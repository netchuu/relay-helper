/**
 * Terminal dialogs waiting at the Mac. A screen that shows one (dialogs.ts), or a hook that says one is open, puts
 * `atMac` on the session: its status lists as `waiting`, and one attention notice carries the title. The trust
 * dialog is left out: it becomes a question for the phone, and its answer is pressed into the screen by label.
 */
import type { Answer, AtMacDialog, Question } from "../../../protocol/index.ts";
import { errMessage, log } from "../log.ts";
import type { AnswerResult, Broker } from "./broker.ts";
import { atMacOf, type Dialog, detectDialog } from "./dialogs.ts";
import type { EventLog } from "./events.ts";
import { answerScreenDialog, type CloseDialogResult, closeScreenDialog, readScreen } from "./inject.ts";
import { redact } from "./redact.ts";
import type { Registry } from "./registry.ts";
import type { StepTracker } from "./steps.ts";
import { head } from "./text.ts";

/** Claude Code's line while it waits for the limit to reset and then carries on by itself. */
const AUTO_RESUME = /Continuing automatically at\s+(.+?)(?:\s+·|\s*$)/m;

/** The step for a screen that shows the wait, or null. */
export function limitWaitStep(screen: string): string | null {
  const at = AUTO_RESUME.exec(screen)?.[1]?.trim();
  return at ? `Waiting for the usage limit, continues at ${at}` : null;
}

const RETRY = /Retrying in\s+\d+\s*s\b.*?attempt\s+(\d+)\s*\/\s*(\d+)/;
const API_STALL = /Waiting for API response/;

/** The step for a screen that shows an API retry or the stall banner before one, or null. */
export function retryStep(screen: string): string | null {
  const m = RETRY.exec(screen);
  if (m) return `Retrying (attempt ${m[1]} of ${m[2]})`;
  return API_STALL.test(screen) ? "Retrying" : null;
}

/** Notification types that mean a dialog is open at the terminal. */
export const HOOK_DIALOGS = new Set([
  "elicitation_dialog",
  "elicitation_url_dialog",
  "worker_permission_prompt",
  "model_refusal_fallback",
]);

/** Dialogs the phone answers as questions, or the helper answers itself: never shown as waiting at the Mac. */
const NOT_AT_MAC = new Set(["trust", "modelSwitch"]);

/** Dialogs that open as a question for the phone. The others only wait at the Mac. */
const ASKED = new Set(["trust"]);

const TRUST_NOTE = "Claude Code will be able to read, edit, and run files here.";
const TRUST_EFFECT: Record<string, string> = {
  "No, exit": "Claude Code doesn't start.",
  "Yes, I trust this folder": "Claude Code starts and can read, edit, and run files here.",
};

/** The question the phone shows for a dialog on the screen. */
export function questionOf(d: Dialog): { title: string; question: Question } {
  if (d.kind === "trust") {
    const path = d.body.split("\n").find((l) => l.trim().startsWith("/") || /^[A-Za-z]:\\|^~/.test(l.trim()));
    return {
      title: "Trust this folder?",
      question: {
        question: ["Trust this folder?", path?.trim(), TRUST_NOTE].filter(Boolean).join("\n"),
        options: d.options.map((label) => ({
          label,
          ...(TRUST_EFFECT[label] ? { description: TRUST_EFFECT[label] } : {}),
        })),
      },
    };
  }
  return {
    title: d.title,
    question: {
      question: [d.title, d.body].filter(Boolean).join("\n"),
      options: d.options.map((label) => ({ label })),
    },
  };
}

const LOOK_EVERY_MS = 3_000;
const LOOK_IDLE_EVERY_MS = 30_000;
const FAST_FOR_MS = 10 * 60_000;
/** A dialog not on the screen this many reads in a row is gone: one read can catch a redraw. */
const GONE_AFTER = 2;
/** Claude Code redraws a beat after an Esc: until then a read still shows the dialog just closed. */
const CLOSE_SETTLE_MS = 500;

const shown = new Map<string, AtMacDialog>();

/** The dialog waiting at the Mac for the session, for `publicSession`. */
export function atMacOfSession(sessionId: string): AtMacDialog | undefined {
  return shown.get(sessionId);
}

export interface DialogDeps {
  registry: Pick<Registry, "get" | "list" | "publish">;
  /** Opens dialog questions and settles them. Absent: dialogs only wait at the Mac. */
  broker?: Pick<Broker, "openDialog" | "openDialogOf" | "listOpen" | "close" | "answerDialog">;
  press?: typeof answerScreenDialog;
  closeDialog?: typeof closeScreenDialog;
  events: Pick<EventLog, "emit">;
  phoneConnected?: () => boolean;
  /** A hook prompt is open for the session (a dialog question is not one): the phone shows its own question. */
  hasOpen?: (sessionId: string) => boolean;
  /** Shows the usage-limit wait or an API retry as the live step of the running turn. */
  steps?: Pick<StepTracker, "waitStarted" | "waitEnded">;
  read?: typeof readScreen;
  now?: () => number;
}

export class DialogWatcher {
  private readonly source = new Map<string, "screen" | "hook">();
  private readonly missing = new Map<string, number>();
  private readonly questionGone = new Map<string, number>();
  private readonly lastLook = new Map<string, number>();
  private readonly waiting = new Set<string>();
  private readonly closing = new Map<string, { dialogId: string; result: Promise<CloseDialogResult> }>();
  private readonly closed = new Map<string, { dialogId: string; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: DialogDeps) {}

  private nowMs(): number {
    return (this.d.now ?? Date.now)();
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), LOOK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round: looks at each session whose turn comes. */
  async tick(): Promise<void> {
    this.closeForEnded();
    if (this.d.phoneConnected && !this.d.phoneConnected()) return;
    const now = (this.d.now ?? Date.now)();
    for (const s of this.d.registry.list()) {
      if (s.status === "working") {
        if (this.source.get(s.id) === "screen") this.clear(s.id);
        await this.lookLimitWait(s, now);
        continue;
      }
      if (s.status === "ended" || !s.canReceive) continue;
      const every = now - s.updatedAt > FAST_FOR_MS && !shown.has(s.id) ? LOOK_IDLE_EVERY_MS : LOOK_EVERY_MS;
      if (now - (this.lastLook.get(s.id) ?? -Infinity) < every) continue;
      this.lastLook.set(s.id, now);
      await this.look(s.id);
    }
  }

  /** A working session on a screen route: reads the screen for the usage limit wait and for API retries. */
  private async lookLimitWait(s: ReturnType<Registry["list"]>[number], now: number): Promise<void> {
    const steps = this.d.steps;
    if (!steps || !s.canReceive) return;
    if (now - (this.lastLook.get(s.id) ?? -Infinity) < LOOK_EVERY_MS) return;
    this.lastLook.set(s.id, now);
    try {
      const screen = await (this.d.read ?? readScreen)(s);
      if (typeof screen !== "string") return;
      const label = limitWaitStep(screen) ?? retryStep(screen);
      if (label) {
        this.waiting.add(s.id);
        steps.waitStarted(s.id, label);
      } else if (this.waiting.delete(s.id)) steps.waitEnded(s.id);
    } catch (err) {
      log.warn("limit wait look", { sessionId: s.id, err: errMessage(err) });
    }
  }

  /** A session that ended or vanished leaves no hook to close its dialog question. */
  private closeForEnded(): void {
    for (const p of this.d.broker?.listOpen() ?? []) {
      if (!p.dialog) continue;
      const s = this.d.registry.get(p.sessionId);
      if (!s || s.status === "ended") this.closeQuestion(p.sessionId, "superseded");
    }
  }

  /** Reads the session's screen once and sets or clears what it shows. */
  async look(sessionId: string): Promise<void> {
    const session = this.d.registry.get(sessionId);
    if (!session || session.status === "ended") {
      this.closeQuestion(sessionId, "superseded");
      return;
    }
    if (this.d.hasOpen?.(sessionId)) {
      if (this.source.get(sessionId) === "screen") this.clear(sessionId);
      return;
    }
    const readAt = this.nowMs();
    try {
      const screen = await (this.d.read ?? readScreen)(session);
      // Unreadable: keep what is known.
      if (typeof screen !== "string") return;
      // Read before the screen settled after an Esc: the dialog it shows is the one just closed.
      const last = this.closed.get(sessionId);
      if (last && readAt < last.at + CLOSE_SETTLE_MS) return;
      const found = detectDialog(screen);
      this.syncQuestion(sessionId, found);
      if (found && !NOT_AT_MAC.has(found.kind)) {
        this.missing.delete(sessionId);
        this.set(sessionId, atMacOf(found), "screen");
        return;
      }
      if (this.source.get(sessionId) !== "screen") return;
      if ((this.missing.get(sessionId) ?? 0) + 1 < GONE_AFTER) {
        this.missing.set(sessionId, (this.missing.get(sessionId) ?? 0) + 1);
        return;
      }
      this.clear(sessionId);
    } catch (err) {
      log.warn("dialog look", { sessionId, err: errMessage(err) });
    }
  }

  /** The phone's pick on a dialog question: pressed into the terminal by label, after reading the screen again. */
  answer(promptId: string, answer: Answer, actor: string): Promise<AnswerResult> | null {
    const broker = this.d.broker;
    if (!broker) return null;
    return broker.answerDialog(promptId, answer, actor, async (label, dialogId, sessionId) => {
      const session = this.d.registry.get(sessionId);
      if (!session || session.status === "ended") return false;
      return (this.d.press ?? answerScreenDialog)(session, dialogId, label);
    });
  }

  /** The phone's Close on a dialog waiting at the Mac: Esc after reading the screen again; the card clears at once. */
  close(sessionId: string, dialogId: string): Promise<CloseDialogResult> {
    const session = this.d.registry.get(sessionId);
    if (!session || session.status === "ended") return Promise.resolve("conflict");
    const last = this.closed.get(sessionId);
    if (last?.dialogId === dialogId && this.nowMs() < last.at + CLOSE_SETTLE_MS)
      return Promise.resolve("closed");
    const running = this.closing.get(sessionId);
    if (running) return running.dialogId === dialogId ? running.result : Promise.resolve("conflict");
    const result = (async () => {
      try {
        const r = await (this.d.closeDialog ?? closeScreenDialog)(session, dialogId);
        if (r === "closed") {
          this.closed.set(sessionId, { dialogId, at: this.nowMs() });
          this.closeQuestion(sessionId, "mac");
          this.clear(sessionId);
        }
        return r;
      } finally {
        this.closing.delete(sessionId);
      }
    })();
    this.closing.set(sessionId, { dialogId, result });
    return result;
  }

  /** Opens the question for an answerable dialog, swaps it when another dialog shows, closes it when none does. */
  private syncQuestion(sessionId: string, found: Dialog | null): void {
    const broker = this.d.broker;
    if (!broker) return;
    const open = broker.openDialogOf(sessionId);
    const askable = found && ASKED.has(found.kind) ? found : null;
    if (open && askable?.id === open.dialogId) {
      this.questionGone.delete(sessionId);
      return;
    }
    if (open) {
      // One read can catch a redraw.
      const n = (this.questionGone.get(sessionId) ?? 0) + 1;
      if (!askable && n < GONE_AFTER) {
        this.questionGone.set(sessionId, n);
        return;
      }
      this.closeQuestion(sessionId, "mac");
    }
    if (!askable) return;
    const { title, question } = questionOf(askable);
    broker.openDialog(sessionId, askable.id, { kind: askable.kind, title }, question);
  }

  private closeQuestion(sessionId: string, by: "mac" | "superseded"): void {
    this.questionGone.delete(sessionId);
    const open = this.d.broker?.openDialogOf(sessionId);
    if (!open) return;
    this.d.broker?.close(open.prompt.id, by);
  }

  /** A hook says a dialog is open on a route that has no screen. */
  fromHook(sessionId: string, type: string, message: string | undefined): void {
    const title =
      head(
        redact(message ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        120,
      ) || "A question on your computer";
    this.set(sessionId, { id: `h_${type}`, kind: type, title, canClose: false }, "hook");
  }

  /** The turn went on, or the hook that closes the dialog came. */
  hookCleared(sessionId: string): void {
    this.clear(sessionId);
  }

  clear(sessionId: string): void {
    this.missing.delete(sessionId);
    this.source.delete(sessionId);
    if (shown.delete(sessionId)) this.d.registry.publish(sessionId);
  }

  private set(sessionId: string, dialog: AtMacDialog, source: "screen" | "hook"): void {
    const before = shown.get(sessionId);
    if (before?.id === dialog.id) return;
    shown.set(sessionId, dialog);
    this.source.set(sessionId, source);
    this.d.registry.publish(sessionId);
    this.d.events.emit({
      type: "session.notice",
      sessionId,
      level: "attention",
      text: `Waiting on your computer: ${dialog.title}`,
    });
  }
}

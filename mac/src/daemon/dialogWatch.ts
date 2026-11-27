/**
 * Terminal dialogs waiting at the Mac. A screen that shows one (dialogs.ts), or a hook that says one is open, puts
 * `atMac` on the session: its status lists as `waiting`, and one attention notice carries the title. The trust
 * dialog is left out: it becomes a question for the phone.
 */
import type { AtMacDialog } from "../../../protocol/index.ts";
import { errMessage, log } from "../log.ts";
import { atMacOf, detectDialog } from "./dialogs.ts";
import type { EventLog } from "./events.ts";
import { readScreen } from "./inject.ts";
import { redact } from "./redact.ts";
import type { Registry } from "./registry.ts";
import { head } from "./text.ts";

/** Notification types that mean a dialog is open at the terminal. */
export const HOOK_DIALOGS = new Set([
  "elicitation_dialog",
  "elicitation_url_dialog",
  "worker_permission_prompt",
]);

/** Dialogs the phone answers as questions, or the helper answers itself: never shown as waiting at the Mac. */
const NOT_AT_MAC = new Set(["trust", "modelSwitch"]);

const LOOK_EVERY_MS = 3_000;
const LOOK_IDLE_EVERY_MS = 30_000;
const FAST_FOR_MS = 10 * 60_000;
/** A dialog not on the screen this many reads in a row is gone: one read can catch a redraw. */
const GONE_AFTER = 2;

const shown = new Map<string, AtMacDialog>();

/** The dialog waiting at the Mac for the session, for `publicSession`. */
export function atMacOfSession(sessionId: string): AtMacDialog | undefined {
  return shown.get(sessionId);
}

export interface DialogDeps {
  registry: Pick<Registry, "get" | "list" | "publish">;
  events: Pick<EventLog, "emit">;
  phoneConnected?: () => boolean;
  /** A hook prompt is open for the session: the phone shows its own question. */
  hasOpen?: (sessionId: string) => boolean;
  read?: typeof readScreen;
  now?: () => number;
}

export class DialogWatcher {
  private readonly source = new Map<string, "screen" | "hook">();
  private readonly missing = new Map<string, number>();
  private readonly lastLook = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: DialogDeps) {}

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
    if (this.d.phoneConnected && !this.d.phoneConnected()) return;
    const now = (this.d.now ?? Date.now)();
    for (const s of this.d.registry.list()) {
      if (s.status === "working") {
        if (this.source.get(s.id) === "screen") this.clear(s.id);
        continue;
      }
      if (s.status === "ended" || !s.canReceive) continue;
      const every = now - s.updatedAt > FAST_FOR_MS && !shown.has(s.id) ? LOOK_IDLE_EVERY_MS : LOOK_EVERY_MS;
      if (now - (this.lastLook.get(s.id) ?? -Infinity) < every) continue;
      this.lastLook.set(s.id, now);
      await this.look(s.id);
    }
  }

  /** Reads the session's screen once and sets or clears what it shows. */
  async look(sessionId: string): Promise<void> {
    const session = this.d.registry.get(sessionId);
    if (!session || session.status === "ended") return;
    if (this.d.hasOpen?.(sessionId)) {
      if (this.source.get(sessionId) === "screen") this.clear(sessionId);
      return;
    }
    try {
      const screen = await (this.d.read ?? readScreen)(session);
      // Unreadable: keep what is known.
      if (typeof screen !== "string") return;
      const found = detectDialog(screen);
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

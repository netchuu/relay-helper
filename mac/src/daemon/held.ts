/** Detects replies Claude Code holds for approval at the Mac: no matching `UserPromptSubmit` hook means held. */
import type { EventBody } from "../../../protocol/index.ts";

/** How long a message posted to an idle session waits for its hook before it counts as held. */
export const HOLD_WAIT_MS = 3000;
/** Claude Code drops a held message after this long. */
export const HOLD_EXPIRE_MS = 5 * 60_000;

/** Sessions with a reply held at the Mac now. */
const heldSessions = new Set<string>();
/** The permission mode each session's hooks report ("default", "acceptEdits", "plan", "bypassPermissions"...). */
const modes = new Map<string, string>();
/** Every mode a session has been in: the ones beyond the usual three show up in the phone's menu once seen. */
const seen = new Map<string, Set<string>>();

/** The session's `heldAtMac` field: present only while a reply to it waits at the Mac. */
export function heldField(sessionId: string): { heldAtMac?: true } {
  return heldSessions.has(sessionId) ? { heldAtMac: true } : {};
}

/** The session's `permissionMode` field, as the last hook reported it; absent when none has. */
export function permissionModeField(sessionId: string): { permissionMode?: string } {
  const mode = modes.get(sessionId);
  return mode ? { permissionMode: mode } : {};
}

/** Remembers the mode a hook reported; true when it changed. */
export function notePermissionMode(sessionId: string, mode: unknown): boolean {
  if (typeof mode !== "string" || mode === "" || mode.length > 40) return false;
  noteSeenModes(sessionId, mode);
  if (modes.get(sessionId) === mode) return false;
  modes.set(sessionId, mode);
  return true;
}

export function noteSeenModes(sessionId: string, mode: string): void {
  const set = seen.get(sessionId) ?? new Set<string>();
  set.add(mode);
  seen.set(sessionId, set);
}

export function seenModesOf(sessionId: string): ReadonlySet<string> {
  return seen.get(sessionId) ?? new Set();
}

/** A session that is gone holds nothing and has no mode. */
export function forgetHeld(sessionId: string): void {
  heldSessions.delete(sessionId);
  modes.delete(sessionId);
  seen.delete(sessionId);
}

/** Zero-width characters, CR and trailing blanks gone; the line breaks stay, they end the text in `seen`. */
function squash(t: string): string {
  return t
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** A turn is running: working, or paused on a permission prompt in the middle of it. */
function isBusy(status: string | undefined): boolean {
  return status === "working" || status === "waiting";
}

/** `text` is in `prompt` as whole lines' end: "yes" isn't in "yes, but first look at the logs". */
function containsWhole(prompt: string, text: string): boolean {
  for (let at = prompt.indexOf(text); at >= 0; at = prompt.indexOf(text, at + 1)) {
    const next = prompt[at + text.length];
    if (next === undefined || next === "\n") return true;
  }
  return false;
}

interface Watched {
  text: string;
  stop: boolean;
  /** The phone's `sendId` for the message, named in its `reply.held` events. */
  sendId?: string;
  state: "pending" | "held";
  /** Set while the session works: the message is judged when its turn ends. */
  afterTurn: boolean;
  timer?: ReturnType<typeof setTimeout>;
  expire?: ReturnType<typeof setTimeout>;
  /** Called with whether it ended up held, when the watch is over or the message is judged held. */
  settle?: (held: boolean) => void;
}

/** What `expect` hands back for one posted message. */
export interface Expectation {
  /** True when held (no hook in time, session idle); a working session answers false and is judged at turn end. */
  wait(ms?: number): Promise<boolean>;
  /** Judges it now: true when the hook hasn't come (the caller already waited), false when it has. */
  holdNow(): boolean;
  /** The message went another way (typed, or never sent). */
  cancel(): void;
}

export interface HeldDeps {
  events: {
    emit(e: EventBody): unknown;
    subscribe(listener: (e: { type: string; session?: { id: string; status: string } }) => void): () => void;
  };
  registry: { get(id: string): { status: string } | null | undefined; publish(id: string): void };
  timing?: { waitMs?: number; expireMs?: number };
}

export class HeldReplies {
  private readonly watched = new Map<string, Watched[]>();
  private readonly waitMs: number;
  private readonly expireMs: number;

  constructor(private readonly d: HeldDeps) {
    this.waitMs = d.timing?.waitMs ?? HOLD_WAIT_MS;
    this.expireMs = d.timing?.expireMs ?? HOLD_EXPIRE_MS;
    // A turn ending judges what was posted during it; a session ending drops everything.
    d.events.subscribe((e) => {
      if (e.type !== "session.upsert" || !e.session) return;
      const { id, status } = e.session;
      if (status === "ended") this.drop(id);
      else if (status === "idle") this.turnEnded(id);
    });
  }

  /** Call before posting `text` to the session's inbox, so a hook that races the post is still seen. */
  expect(sessionId: string, text: string, opts: { stop?: boolean; sendId?: string } = {}): Expectation {
    const entry: Watched = {
      text: squash(text),
      stop: opts.stop === true,
      ...(opts.sendId ? { sendId: opts.sendId } : {}),
      state: "pending",
      afterTurn: isBusy(this.d.registry.get(sessionId)?.status) && !opts.stop,
    };
    const list = this.watched.get(sessionId) ?? [];
    list.push(entry);
    this.watched.set(sessionId, list);
    return {
      wait: (ms = this.waitMs) => {
        if (!this.has(sessionId, entry)) return Promise.resolve(false);
        if (entry.afterTurn) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          entry.settle = resolve;
          entry.timer = setTimeout(() => this.hold(sessionId, entry), ms);
        });
      },
      holdNow: () => {
        if (!this.has(sessionId, entry)) return false;
        this.hold(sessionId, entry);
        return true;
      },
      cancel: () => this.remove(sessionId, entry),
    };
  }

  /** Whether a reply to the session waits at the Mac now. */
  isHeld(sessionId: string): boolean {
    return heldSessions.has(sessionId);
  }

  /** From `UserPromptSubmit`: the prompt is a message posted earlier, so it arrived. */
  seen(sessionId: string, prompt: string): void {
    const list = this.watched.get(sessionId);
    if (!list) return;
    const text = squash(prompt);
    // The longest match: "Fix the tests" is also inside "Fix the tests\nand the lint", which is the one that arrived.
    let entry: Watched | undefined;
    for (const w of list) {
      if (w.text === "" || !containsWhole(text, w.text)) continue;
      if (!entry || w.text.length > entry.text.length) entry = w;
    }
    if (!entry) return;
    const wasHeld = entry.state === "held";
    this.remove(sessionId, entry, false);
    entry.settle?.(false);
    if (wasHeld) this.report(sessionId, entry, "delivered");
  }

  private has(sessionId: string, entry: Watched): boolean {
    return this.watched.get(sessionId)?.includes(entry) ?? false;
  }

  private remove(sessionId: string, entry: Watched, settle = true): void {
    clearTimeout(entry.timer);
    clearTimeout(entry.expire);
    const list = this.watched.get(sessionId)?.filter((w) => w !== entry) ?? [];
    if (list.length > 0) this.watched.set(sessionId, list);
    else this.watched.delete(sessionId);
    if (settle) entry.settle?.(false);
    this.refresh(sessionId);
  }

  private hold(sessionId: string, entry: Watched): void {
    if (!this.has(sessionId, entry) || entry.state === "held") return;
    clearTimeout(entry.timer);
    entry.state = "held";
    entry.settle?.(true);
    entry.expire = setTimeout(() => {
      if (!this.has(sessionId, entry)) return;
      this.remove(sessionId, entry, false);
      this.report(sessionId, entry, "expired");
    }, this.expireMs);
    this.refresh(sessionId);
    this.d.events.emit({
      type: "reply.held",
      sessionId,
      state: "waiting",
      ...(entry.stop ? { stop: true } : {}),
      ...(entry.sendId ? { sendId: entry.sendId } : {}),
    });
  }

  private turnEnded(sessionId: string): void {
    for (const entry of this.watched.get(sessionId) ?? []) {
      if (!entry.afterTurn || entry.state !== "pending") continue;
      entry.afterTurn = false;
      entry.timer = setTimeout(() => {
        if (this.d.registry.get(sessionId)?.status !== "idle") entry.afterTurn = true;
        else this.hold(sessionId, entry);
      }, this.waitMs);
    }
  }

  private drop(sessionId: string): void {
    for (const entry of this.watched.get(sessionId) ?? []) {
      clearTimeout(entry.timer);
      clearTimeout(entry.expire);
      entry.settle?.(false);
    }
    this.watched.delete(sessionId);
    forgetHeld(sessionId);
  }

  /** Keeps `heldAtMac` in step with the held messages, and tells the phones when it changed. */
  private refresh(sessionId: string): void {
    const now = (this.watched.get(sessionId) ?? []).some((w) => w.state === "held");
    if (now === heldSessions.has(sessionId)) return;
    if (now) heldSessions.add(sessionId);
    else heldSessions.delete(sessionId);
    this.d.registry.publish(sessionId);
  }

  private report(sessionId: string, entry: Watched, state: "delivered" | "expired"): void {
    this.d.events.emit({
      type: "reply.held",
      sessionId,
      state,
      ...(entry.stop ? { stop: true } : {}),
      ...(entry.sendId ? { sendId: entry.sendId } : {}),
    });
  }
}

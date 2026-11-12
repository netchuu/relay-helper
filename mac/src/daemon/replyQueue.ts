/**
 * Replies waiting to be typed in as the person's own message, rather than sent labelled through the inbox:
 *
 * - "unlock": for the Mac to be unlocked. While the screen is locked, macOS
 *   hides the Claude desktop app's contents, so a reply to a desktop session can't be typed in.
 * - "pause": for a pause in the person's typing at the Mac, so a reply typed into the session's terminal doesn't mix
 *   into what they are typing there or into a draft (inject.ts WaitForPause). Typed anyway after TYPE_ANYWAY_MS.
 *
 * Kept in the database so a helper restart doesn't lose them. Delivered oldest first per session, through the
 * normal routes; one session waiting doesn't hold another back.
 */
import { errMessage, log } from "../log.ts";
import { platform } from "../platform/index.ts";
import type { DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import { notePhoneTyped, phoneTypePending } from "./hooks.ts";
import { deliver, TYPE_ANYWAY_MS, type TypeOps, WaitForPause, WaitForUnlock } from "./inject.ts";
import type { Registry, SessionRecord } from "./registry.ts";

/** A reply older than this is dropped, with a notice: the person has moved on. */
export const QUEUE_MAX_AGE_MS = 24 * 3_600_000;

/** What a reply waits for. */
export type WaitsFor = "unlock" | "pause";

/** Why a session's replies wait now, as the phone is told (protocol SendResult.reason). */
export type WaitReason = "locked" | "typing" | "draft";

/** What a WaitForPause means to the phone; null for an open prompt, which has no wording of its own. */
export function reasonOfPause(err: WaitForPause): WaitReason | null {
  return err.reason === "prompt" ? null : err.reason;
}

export interface QueuedReply {
  id: number;
  sessionId: string;
  text: string;
  createdAt: number;
  waitsFor: WaitsFor;
}

/** The reply was typed into the prompt but never submitted, even after Enter again. */
export class NotSent extends Error {}

export type Deliver = (session: SessionRecord, text: string, reply: QueuedReply) => Promise<void>;

export class ReplyQueue {
  /** Sessions being drained right now: one run per session, so a slow one never holds up the others. */
  private draining = new Set<string>();
  /** Why each session's replies wait now; a change goes to the phones as `reply.waiting`. */
  private readonly reasons = new Map<string, WaitReason>();

  constructor(
    private readonly db: DB,
    private readonly events: EventLog,
    private readonly registry: Registry,
  ) {}

  add(sessionId: string, text: string, now = Date.now(), waitsFor: WaitsFor = "unlock"): void {
    this.db
      .query("INSERT INTO queued_replies (session_id, text, created_at, waits_for) VALUES (?, ?, ?, ?)")
      .run(sessionId, text, now, waitsFor);
  }

  reasonOf(sessionId: string): WaitReason | undefined {
    return this.reasons.get(sessionId);
  }

  /** Records why a session's replies wait (null: none do now) and tells the phones when that changed. */
  setReason(sessionId: string, reason: WaitReason | null): void {
    if ((this.reasons.get(sessionId) ?? null) === reason) return;
    if (reason) this.reasons.set(sessionId, reason);
    else this.reasons.delete(sessionId);
    this.events.emit({ type: "reply.waiting", sessionId, reason });
  }

  /** Waiting replies, oldest first; for one session when given. */
  list(sessionId?: string): QueuedReply[] {
    const rows = (
      sessionId
        ? this.db.query("SELECT * FROM queued_replies WHERE session_id = ? ORDER BY id").all(sessionId)
        : this.db.query("SELECT * FROM queued_replies ORDER BY id").all()
    ) as { id: number; session_id: string; text: string; created_at: number; waits_for: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      text: r.text,
      createdAt: r.created_at,
      waitsFor: r.waits_for === "pause" ? "pause" : "unlock",
    }));
  }

  /**
   * Delivers what's waiting. While the Mac is locked a reply waiting for the unlock stays (and so does everything
   * after it for that session); one waiting for a pause is tried, since terminals take typing while locked. A reply
   * whose session has ended, or that waited too long, is dropped with a notice in that session's chat. Sessions are
   * drained side by side, each in order. One run at a time per session.
   */
  async drain(locked: boolean, deliver: Deliver, now = Date.now()): Promise<void> {
    const bySession = new Map<string, QueuedReply[]>();
    for (const reply of this.list()) {
      const list = bySession.get(reply.sessionId) ?? [];
      list.push(reply);
      bySession.set(reply.sessionId, list);
    }
    await Promise.all(
      [...bySession].map(async ([sessionId, replies]) => {
        if (this.draining.has(sessionId)) return;
        this.draining.add(sessionId);
        try {
          await this.drainSession(replies, locked, deliver, now);
        } finally {
          this.draining.delete(sessionId);
        }
      }),
    );
  }

  private async drainSession(
    replies: QueuedReply[],
    locked: boolean,
    deliver: Deliver,
    now: number,
  ): Promise<void> {
    for (const reply of replies) {
      // Still locked: it waits, and the session's later replies wait behind it (the age is checked on unlock).
      if (locked && reply.waitsFor === "unlock") return void this.setReason(reply.sessionId, "locked");
      const session = this.registry.get(reply.sessionId);
      const reason =
        !session || session.status === "ended"
          ? reply.waitsFor === "pause"
            ? "the session ended before it could be typed in"
            : "the session ended before your Mac was unlocked"
          : now - reply.createdAt > QUEUE_MAX_AGE_MS
            ? reply.waitsFor === "pause"
              ? "Relay couldn't type it in for a day"
              : "your Mac stayed locked for a day"
            : null;
      if (reason || !session) {
        this.drop(reply, reason ?? "the session is gone");
        continue;
      }
      try {
        await deliver(session, reply.text, reply);
        this.remove(reply.id);
      } catch (err) {
        // Locked again, or someone is typing there: stop here and keep the order.
        if (err instanceof WaitForUnlock) return void this.setReason(reply.sessionId, "locked");
        if (err instanceof WaitForPause) {
          const why = reasonOfPause(err);
          // An open question has no wording of its own, and a draft/typing reason from earlier no longer holds.
          this.setReason(reply.sessionId, why);
          return;
        }
        log.warn("queued reply couldn't be delivered", {
          sessionId: reply.sessionId,
          err: errMessage(err),
        });
        this.drop(
          reply,
          err instanceof NotSent ? "it's typed in the prompt but wasn't sent" : "Relay couldn't reach it",
        );
      }
    }
    // Every one we saw went or was dropped; clear only if nothing was added meanwhile (a send during a deliver).
    const sessionId = replies[0]?.sessionId;
    if (sessionId && this.list(sessionId).length === 0) this.setReason(sessionId, null);
  }

  private remove(id: number): void {
    this.db.query("DELETE FROM queued_replies WHERE id = ?").run(id);
  }

  private drop(reply: QueuedReply, reason: string): void {
    this.remove(reply.id);
    const session = this.registry.get(reply.sessionId);
    const name = session?.name ?? session?.project ?? "the session";
    this.events.emit({
      type: "session.notice",
      sessionId: reply.sessionId,
      level: "error",
      text: `Your message to ${name} wasn't sent: ${reason}.`,
    });
  }
}

/**
 * How the daemon delivers a queued reply: through the normal routes, with a fresh reading of your typing for one
 * waiting for a pause, typed anyway once it has waited TYPE_ANYWAY_MS.
 */
export function deliverQueued(opts: {
  preferTyping: boolean;
  /** The session is asking a question at the Mac (broker): typing now would answer it. */
  hasOpenPrompt(sessionId: string): boolean;
  typeOps?: TypeOps;
  now?: () => number;
}): Deliver {
  const now = opts.now ?? Date.now;
  return async (session, text, reply) => {
    const pause = reply.waitsFor === "pause";
    if (pause && opts.hasOpenPrompt(session.id)) throw new WaitForPause(null, "prompt");
    const { idleSeconds, locked } = pause
      ? await platform.presence.read({ tmuxSockets: session.tmuxSocket ? [session.tmuxSocket] : [] })
      : { idleSeconds: null, locked: false };
    notePhoneTyped(session.id, text);
    const res = await deliver(
      session,
      text,
      {
        submitted: () => !phoneTypePending(session.id, text),
        idleSeconds,
        userTypingNow: false,
        preferTyping: opts.preferTyping,
        locked: locked === true,
        typeAnyway: now() - reply.createdAt >= TYPE_ANYWAY_MS,
      },
      opts.typeOps,
    );
    if (res.submitted === false) throw new NotSent();
  };
}

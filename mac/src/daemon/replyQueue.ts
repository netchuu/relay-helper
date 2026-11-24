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
import type { HeldReplies } from "./held.ts";
import { dropPhoneTyped, notePhoneTyped, phoneTypeDelivered, phoneTypePending } from "./hooks.ts";
import {
  deliver,
  type HeadlessRoute,
  OpenEditorPanel,
  PHONE_PREFIX,
  TYPE_ANYWAY_MS,
  type TypeOps,
  WaitForPause,
  WaitForUnlock,
} from "./inject.ts";
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
  /** The phone's id for the message, when it sent one; held-reply events carry it. */
  sendId?: string;
}

/** The reply was typed into the prompt but never submitted, even after Enter again. */
export class NotSent extends Error {}

export type Deliver = (session: SessionRecord, text: string, reply: QueuedReply) => Promise<void>;

export class ReplyQueue {
  /** Sessions being drained right now: one run per session, so a slow one never holds up the others. */
  private draining = new Set<string>();
  /** Why each session's replies wait now; a change goes to the phones as `reply.waiting`. */
  private readonly reasons = new Map<string, WaitReason>();
  /** When each session's next try may succeed, from the keyboard's idle time; absent when it can't be told. */
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly events: EventLog,
    private readonly registry: Registry,
  ) {}

  add(
    sessionId: string,
    text: string,
    now = Date.now(),
    waitsFor: WaitsFor = "unlock",
    sendId?: string,
  ): void {
    this.db
      .query(
        "INSERT INTO queued_replies (session_id, text, created_at, waits_for, send_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionId, text, now, waitsFor, sendId ?? null);
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

  /** Nothing is tried for this session until `ms` from `now`, the time its keyboard needs to be still. */
  retryIn(sessionId: string, ms: number, now = Date.now()): void {
    this.retryAt.set(sessionId, now + ms);
  }

  /** Waiting replies, oldest first; for one session when given. */
  list(sessionId?: string): QueuedReply[] {
    const rows = (
      sessionId
        ? this.db.query("SELECT * FROM queued_replies WHERE session_id = ? ORDER BY id").all(sessionId)
        : this.db.query("SELECT * FROM queued_replies ORDER BY id").all()
    ) as {
      id: number;
      session_id: string;
      text: string;
      created_at: number;
      waits_for: string | null;
      send_id: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      text: r.text,
      createdAt: r.created_at,
      waitsFor: r.waits_for === "pause" ? "pause" : "unlock",
      ...(r.send_id ? { sendId: r.send_id } : {}),
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
        // Typing at the Mac can't have stopped before this: nothing to try yet (typed anyway at TYPE_ANYWAY_MS).
        const first = replies[0];
        const retryAt = this.retryAt.get(sessionId);
        if (
          first?.waitsFor === "pause" &&
          retryAt !== undefined &&
          now < Math.min(retryAt, first.createdAt + TYPE_ANYWAY_MS)
        )
          return;
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
      this.retryAt.delete(reply.sessionId);
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
          if (err.retryInMs !== undefined) this.retryAt.set(reply.sessionId, now + err.retryInMs);
          return;
        }
        log.warn("queued reply couldn't be delivered", {
          sessionId: reply.sessionId,
          err: errMessage(err),
        });
        this.drop(
          reply,
          err instanceof NotSent
            ? "it's typed in the prompt but wasn't sent"
            : err instanceof OpenEditorPanel
              ? err.message
              : "Relay couldn't reach it",
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
  /** Processes the helper runs itself: a queued reply for one of their sessions goes to its stdin. */
  headless?: HeadlessRoute;
  /** Replies Claude Code holds at the Mac: a queued reply that ends up in the inbox is watched like a direct one. */
  held?: HeldReplies;
}): Deliver {
  const now = opts.now ?? Date.now;
  return async (session, text, reply) => {
    const pause = reply.waitsFor === "pause";
    if (pause && opts.hasOpenPrompt(session.id)) throw new WaitForPause(null, "prompt");
    const { idleSeconds, locked } = pause
      ? await platform.presence.read({ tmuxSockets: session.tmuxSocket ? [session.tmuxSocket] : [] })
      : { idleSeconds: null, locked: false };
    notePhoneTyped(session.id, text, true, reply.sendId);
    const watch = opts.held?.expect(session.id, `${PHONE_PREFIX}\n${text}`, { sendId: reply.sendId });
    let res: Awaited<ReturnType<typeof deliver>>;
    try {
      res = await deliver(
        session,
        text,
        {
          submitted: () => !phoneTypePending(session.id, text),
          idleSeconds,
          userTypingNow: false,
          preferTyping: opts.preferTyping,
          locked: locked === true,
          typeAnyway: now() - reply.createdAt >= TYPE_ANYWAY_MS,
          headless: opts.headless,
        },
        opts.typeOps,
      );
      phoneTypeDelivered(session.id, text);
    } catch (err) {
      watch?.cancel();
      // Nothing was typed: a prompt the person types at the Mac next must not match this message.
      dropPhoneTyped(session.id, text);
      throw err;
    }
    // Through the inbox: the watch runs on without holding the queue up, and tells the phone if it is held.
    if (res.via === "socket") void watch?.wait();
    else watch?.cancel();
    if (res.submitted === false) throw new NotSent();
  };
}

/**
 * Replies a helper from before left waiting (for the Mac to unlock, or for a pause in typing at it). Nothing is added
 * to the queue now: a phone message is typed in at once. What is left is delivered at the next tick, oldest first per
 * session, through the normal routes; one session's reply doesn't hold another back. Kept in the database so a helper
 * restart doesn't lose them.
 */
import { errMessage, log } from "../log.ts";
import { platform } from "../platform/index.ts";
import type { DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import type { HeldReplies } from "./held.ts";
import { dropPhoneTyped, notePhoneTyped, phoneTypeDelivered, phoneTypePending } from "./hooks.ts";
import {
  DeliveryError,
  deliver,
  type HeadlessRoute,
  OpenEditorPanel,
  PHONE_PREFIX,
  type TypeOps,
} from "./inject.ts";
import type { Registry, SessionRecord } from "./registry.ts";

/** A reply older than this is dropped, with a notice: the person has moved on. */
export const QUEUE_MAX_AGE_MS = 24 * 3_600_000;

/** What a reply waited for, as the database keeps it. */
export type WaitsFor = "unlock" | "pause";

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

/** The session has a question open at the Mac: typing now would answer it, so the reply stays until it is answered. */
export class PromptOpen extends Error {}

export type Deliver = (session: SessionRecord, text: string, reply: QueuedReply) => Promise<void>;

export class ReplyQueue {
  /** Sessions being drained right now: one run per session, so a slow one never holds up the others. */
  private draining = new Set<string>();

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
   * Delivers what's waiting. A reply whose session has ended, or that waited too long, is dropped with a notice in
   * that session's chat. Sessions are drained side by side, each in order. One run at a time per session.
   */
  async drain(deliver: Deliver, now = Date.now()): Promise<void> {
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
          await this.drainSession(replies, deliver, now);
        } finally {
          this.draining.delete(sessionId);
        }
      }),
    );
  }

  private async drainSession(replies: QueuedReply[], deliver: Deliver, now: number): Promise<void> {
    for (const reply of replies) {
      const session = this.registry.get(reply.sessionId);
      const reason =
        !session || session.status === "ended"
          ? "the session ended before it could be typed in"
          : now - reply.createdAt > QUEUE_MAX_AGE_MS
            ? "Relay couldn't type it in for a day"
            : null;
      if (reason || !session) {
        this.drop(reply, reason ?? "the session is gone");
        continue;
      }
      try {
        await deliver(session, reply.text, reply);
        this.remove(reply.id);
      } catch (err) {
        // A question is open: stop here and keep the order.
        if (err instanceof PromptOpen) return;
        log.warn("queued reply couldn't be delivered", {
          sessionId: reply.sessionId,
          err: errMessage(err),
        });
        this.drop(
          reply,
          err instanceof NotSent
            ? "it's typed in the prompt but wasn't sent"
            : err instanceof OpenEditorPanel || err instanceof DeliveryError
              ? err.message
              : "Relay couldn't reach it",
        );
      }
    }
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

/** How the daemon delivers a queued reply: through the normal routes, as a phone message is typed in now. */
export function deliverQueued(opts: {
  preferTyping: boolean;
  /** The session is asking a question at the Mac (broker): typing now would answer it. */
  hasOpenPrompt(sessionId: string): boolean;
  typeOps?: TypeOps;
  /** Processes the helper runs itself: a queued reply for one of their sessions goes to its stdin. */
  headless?: HeadlessRoute;
  /** Replies Claude Code holds at the Mac: a queued reply that ends up in the inbox is watched like a direct one. */
  held?: HeldReplies;
}): Deliver {
  return async (session, text, reply) => {
    if (opts.hasOpenPrompt(session.id)) throw new PromptOpen();
    const { locked } = await platform.presence.read({
      tmuxSockets: session.tmuxSocket ? [session.tmuxSocket] : [],
    });
    notePhoneTyped(session.id, text, true, reply.sendId);
    const watch = opts.held?.expect(session.id, `${PHONE_PREFIX}\n${text}`, { sendId: reply.sendId });
    let res: Awaited<ReturnType<typeof deliver>>;
    try {
      res = await deliver(
        session,
        text,
        {
          submitted: () => !phoneTypePending(session.id, text),
          userTypingNow: false,
          preferTyping: opts.preferTyping,
          locked: locked === true,
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

import type { SendResult } from "../../../protocol/index.ts";
import type { DB } from "./db.ts";

/** How long a delivered message's `sendId` is remembered: longer than a failed bubble usually waits for Try Again. */
export const SENT_ID_TTL_MS = 24 * 3600_000;
/** At most this many remembered at once; the oldest go first. */
export const SENT_ID_MAX = 5_000;

/**
 * Messages from the phone by their `sendId`, so one whose reply was lost is never typed twice: a repeat of
 * `session.send` with an id that was delivered gets the first send's result, and `session.delivered` can say whether
 * it arrived. A send still on its way is kept as its promise, so a repeat or a question waits for it. A send that
 * failed is forgotten at once (Try Again must send it). Delivered ones are also kept in the `sent_messages` table (when given a database), so a helper restart doesn't forget them.
 */
export class SentMessages {
  private readonly sends = new Map<string, { at: number; result: Promise<SendResult> }>();

  constructor(
    private readonly ttlMs = SENT_ID_TTL_MS,
    private readonly max = SENT_ID_MAX,
    private readonly now: () => number = Date.now,
    private readonly db?: DB,
  ) {}

  /**
   * The send with this id in this session: its result, once it has one. Nil when there was none, it failed, or it's
   * forgotten. The promise rejects only for a send still on its way that then fails (it's forgotten by then).
   */
  get(sessionId: string, sendId: string): Promise<SendResult> | undefined {
    this.prune();
    const live = this.sends.get(key(sessionId, sendId))?.result;
    if (live || !this.db) return live;
    // Not in memory: delivered before a helper restart?
    try {
      const row = this.db
        .query("SELECT via FROM sent_messages WHERE session_id = ? AND send_id = ? AND at >= ?")
        .get(sessionId, sendId, this.now() - this.ttlMs) as { via: SendResult["via"] } | null;
      return row ? Promise.resolve({ via: row.via }) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remembers a send that just started; it stays once it succeeds and goes if it fails. Returns its result. */
  track(sessionId: string, sendId: string, send: Promise<SendResult>): Promise<SendResult> {
    const k = key(sessionId, sendId);
    const entry = { at: this.now(), result: send };
    // Forgotten before anyone waiting on it hears of the failure, so they find it gone and send it themselves.
    entry.result = send.then(
      (result) => {
        this.persist(sessionId, sendId, result.via, entry.at);
        return { via: result.via };
      },
      (err) => {
        if (this.sends.get(k) === entry) this.sends.delete(k);
        throw err;
      },
    );
    // Callers that never wait on it (no repeat came) mustn't see an unhandled rejection.
    entry.result.catch(() => {});
    this.sends.delete(k);
    this.sends.set(k, entry);
    this.prune();
    return send;
  }

  private persist(sessionId: string, sendId: string, via: SendResult["via"], at: number): void {
    try {
      this.db
        ?.query("INSERT OR REPLACE INTO sent_messages (session_id, send_id, via, at) VALUES (?, ?, ?, ?)")
        .run(sessionId, sendId, via, at);
    } catch {
      // Remembering across a restart is best effort: the send itself went through.
    }
  }

  get size(): number {
    return this.sends.size;
  }

  private prune(): void {
    const oldest = this.now() - this.ttlMs;
    try {
      this.db?.query("DELETE FROM sent_messages WHERE at < ?").run(oldest);
    } catch {
      // see persist
    }
    for (const [k, entry] of this.sends) {
      if (entry.at >= oldest && this.sends.size <= this.max) break;
      this.sends.delete(k);
    }
  }
}

function key(sessionId: string, sendId: string): string {
  return `${sessionId}\u0000${sendId}`;
}

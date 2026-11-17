import type { EventBody, RelayEvent } from "../../../protocol/index.ts";
import type { DB } from "./db.ts";

type Listener = (event: RelayEvent) => void;

/** Durable, ordered event log; old events are pruned, so clients too far behind get a snapshot (`sync` RPC). */
export class EventLog {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: DB) {}

  emit(body: EventBody): RelayEvent {
    const ts = Date.now();
    const row = this.db
      .query("INSERT INTO events (ts, type, data_json) VALUES (?, ?, ?) RETURNING seq")
      .get(ts, body.type, JSON.stringify(body)) as { seq: number };
    const event = { seq: row.seq, ts, ...body } as RelayEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the producer.
      }
    }
    return event;
  }

  since(seq: number, limit = 1000): RelayEvent[] {
    const rows = this.db
      .query("SELECT seq, ts, data_json FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, limit) as { seq: number; ts: number; data_json: string }[];
    return rows.map(
      (r) => ({ seq: r.seq, ts: r.ts, ...(JSON.parse(r.data_json) as EventBody) }) as RelayEvent,
    );
  }

  /** Like `since`, but keeps only the newest `session.background` per session and `turn.step` per turn. */
  sinceForSync(seq: number, limit = 1000): RelayEvent[] {
    const rows = this.db
      .query(
        `SELECT seq, ts, data_json FROM events WHERE seq > ? AND (type != 'turn.step' OR seq IN (
           SELECT MAX(seq) FROM events WHERE type = 'turn.step' GROUP BY json_extract(data_json, '$.turnId')))
         AND (type != 'session.background' OR seq IN (
           SELECT MAX(seq) FROM events WHERE type = 'session.background'
           GROUP BY json_extract(data_json, '$.sessionId')))
         ORDER BY seq LIMIT ?`,
      )
      .all(seq, limit) as { seq: number; ts: number; data_json: string }[];
    return rows.map(
      (r) => ({ seq: r.seq, ts: r.ts, ...(JSON.parse(r.data_json) as EventBody) }) as RelayEvent,
    );
  }

  /** `sinceForSync` cut to `limit` events and `maxBytes` (`more`/`latestSeq` continue it); oversized ones go to `dropped`. */
  syncPage(
    seq: number,
    opts: {
      limit?: number;
      maxBytes: number;
      /** Each event as it will be sent (a big prompt cut), measured and returned instead of the stored one. */
      fit?: (event: RelayEvent) => RelayEvent;
      dropped?: (event: RelayEvent, bytes: number) => void;
      /** An event over `maxBytes` goes alone in its page instead of being left out. */
      keepOversized?: boolean;
    },
  ): { events: RelayEvent[]; latestSeq: number; more: boolean } {
    const limit = opts.limit ?? 1000;
    const stored = this.sinceForSync(seq, limit);
    const rows = opts.fit ? stored.map(opts.fit) : stored;
    const events: RelayEvent[] = [];
    let used = 2;
    let last = seq;
    let more = false;
    for (const event of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes > opts.maxBytes && !opts.keepOversized) {
        opts.dropped?.(event, bytes);
        last = event.seq;
        continue;
      }
      if (used + bytes > opts.maxBytes && (events.length > 0 || !opts.keepOversized)) {
        more = true;
        break;
      }
      used += bytes;
      events.push(event);
      last = event.seq;
    }
    if (!more && rows.length >= limit) more = true;
    return { events, latestSeq: more ? last : Math.max(this.latestSeq(), last), more };
  }

  /** A turn ended: its live steps are history now (the turn keeps its own list). */
  deleteTurnSteps(turnId: string): void {
    this.db
      .query("DELETE FROM events WHERE type = 'turn.step' AND json_extract(data_json, '$.turnId') = ?")
      .run(turnId);
  }

  /** Each session's newest stored background list (background-work), for a restarted helper. */
  latestBackground(): { sessionId: string; tasks: unknown }[] {
    const rows = this.db
      .query(
        `SELECT data_json FROM events WHERE type = 'session.background' AND seq IN (
           SELECT MAX(seq) FROM events WHERE type = 'session.background'
           GROUP BY json_extract(data_json, '$.sessionId'))`,
      )
      .all() as { data_json: string }[];
    const out: { sessionId: string; tasks: unknown }[] = [];
    for (const r of rows) {
      try {
        const e = JSON.parse(r.data_json) as { sessionId?: unknown; tasks?: unknown };
        if (typeof e.sessionId === "string") out.push({ sessionId: e.sessionId, tasks: e.tasks });
      } catch {
        // a row that isn't JSON is skipped
      }
    }
    return out;
  }

  /** A newer background list replaces the session's older ones (background-work). */
  deleteSessionBackground(sessionId: string): void {
    this.db
      .query(
        "DELETE FROM events WHERE type = 'session.background' AND json_extract(data_json, '$.sessionId') = ?",
      )
      .run(sessionId);
  }

  /** A turn ended: its live actions are history now (the finished turn carries them; turn-timeline). */
  deleteTurnActions(turnId: string): void {
    this.db
      .query("DELETE FROM events WHERE type = 'turn.action' AND json_extract(data_json, '$.turnId') = ?")
      .run(turnId);
  }

  /** A turn ended: its live messages are history now (the finished turn carries them). */
  deleteTurnMessages(turnId: string): void {
    this.db
      .query("DELETE FROM events WHERE type = 'turn.message' AND json_extract(data_json, '$.turnId') = ?")
      .run(turnId);
  }

  /** Oldest seq still stored (0 when empty). Clients behind this need a snapshot. */
  oldestSeq(): number {
    const row = this.db.query("SELECT MIN(seq) AS s FROM events").get() as { s: number | null };
    return row.s ?? 0;
  }

  latestSeq(): number {
    const row = this.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number | null };
    return row.s ?? 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prune(maxAgeMs: number): number {
    const res = this.db.query("DELETE FROM events WHERE ts < ?").run(Date.now() - maxAgeMs);
    return res.changes;
  }
}

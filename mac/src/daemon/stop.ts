import {
  type InterruptResult,
  type InterruptVia,
  TURN_MESSAGES_MAX,
  type Turn,
  type TurnStats,
} from "../../../protocol/index.ts";
import type { RelayConfig } from "../config.ts";
import { log } from "../log.ts";
import { attachmentFields } from "./attachments.ts";
import type { Broker } from "./broker.ts";
import { audit, type DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import {
  DeliveryError,
  defaultKeyOps,
  type KeyOps,
  postToInbox,
  pressEscape,
  STOP_MESSAGE,
  STOP_TEXT,
} from "./inject.ts";
import { finishedMessages, type MessageTracker, messagesJson, turnMessageFields } from "./messages.ts";
import { redact } from "./redact.ts";
import type { Registry } from "./registry.ts";
import { compact } from "./render.ts";
import { type StepTracker, stepsJsonOf, timelineFields } from "./steps.ts";
import { interruptedTurn, transcriptPathFor } from "./transcript.ts";

/**
 * The phone's Stop (session.interrupt): stops Claude's current turn the way Esc
 * does, and ends that turn as stopped. Claude Code runs no hook after an interrupt, so the helper ends the
 * turn itself, from the transcript's interrupt marker (or, through the inbox, from its own stop message).
 */

export class StopError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface StopDeps {
  db: DB;
  events: EventLog;
  registry: Registry;
  broker: Broker;
  config: Pick<RelayConfig, "previewChars">;
  keys?: KeyOps;
  inbox?: (socketPath: string, token: string | null, text: string) => Promise<void>;
  timing?: Partial<Timing>;
  /** Where the session's transcript is; tests point it at a fixture. */
  transcriptPath?: (session: NonNullable<ReturnType<Registry["get"]>>) => string | null;
  /** The live steps (turn-steps), shared with the hook handler: a stopped turn's are cleared and kept. */
  steps?: StepTracker;
  /** The live messages (live-messages), shared with the hook handler: a stopped turn stops being followed. */
  messages?: MessageTracker;
}

interface Timing {
  /** After a prompt answered with deny-and-interrupt, before reading the transcript (it's flushed async). */
  graceMs: number;
  /** How long to look for the interrupt marker after an Esc. */
  markerMs: number;
  /** How long to wait for Claude Code to start a turn with the stop message sent through the inbox. */
  inboxMs: number;
  pollMs: number;
  /** A second Stop within this time after an Esc sends no second Esc (two would open Claude Code's rewind menu). */
  repeatMs: number;
}

const TIMING: Timing = { graceMs: 400, markerMs: 5000, inboxMs: 3000, pollMs: 250, repeatMs: 2000 };
/** A stop message held at the terminal (bypass mode) still counts once someone delivers it. */
const PENDING_INBOX_MS = 10 * 60_000;

interface OpenTurn {
  id: string;
  started_at: number | null;
  prompt: string | null;
}

export class TurnStopper {
  private readonly inflight = new Map<string, Promise<InterruptResult>>();
  private readonly lastEsc = new Map<
    string,
    { at: number; result: InterruptResult; turnId: string | null }
  >();
  private readonly pendingInbox = new Map<
    string,
    { turnId: string | null; at: number; resolve: (turnId: string | null) => void }
  >();
  private readonly t: Timing;
  private readonly keys: KeyOps;
  private readonly inbox: (socketPath: string, token: string | null, text: string) => Promise<void>;

  constructor(private readonly d: StopDeps) {
    this.t = { ...TIMING, ...d.timing };
    this.keys = d.keys ?? defaultKeyOps;
    this.inbox = d.inbox ?? ((path, token, text) => postToInbox(path, token, text, 5000, "now"));
  }

  /** session.interrupt. One stop at a time per session: a second call while one runs gets the same result. */
  interrupt(sessionId: string, actor: string): Promise<InterruptResult> {
    const session = this.d.registry.get(sessionId);
    if (!session || session.status === "ended")
      throw new StopError("not_found", "session not found or ended");
    const running = this.inflight.get(sessionId);
    if (running) return running;
    if (session.status !== "working" && session.status !== "waiting")
      throw new StopError("conflict", "nothing to stop: the session isn't working");
    // A quick second tap: never a second Esc (two open Claude Code's rewind menu), and never a stop of a turn
    // you haven't seen yet (the first Esc can submit a message queued at the computer, the inbox stop starts a
    // turn). Same turn still running: the first tap's answer, unless a prompt opened, which is answered (no key).
    const recent = this.lastEsc.get(sessionId);
    if (recent && Date.now() - recent.at < this.t.repeatMs) {
      const sameTurn = recent.turnId !== null && recent.turnId === (this.openTurn(sessionId)?.id ?? null);
      if (!sameTurn) throw new StopError("conflict", "nothing to stop: the turn already stopped");
      if (!this.d.broker.hasOpen(sessionId)) return Promise.resolve(recent.result);
    }
    const p = this.run(sessionId, actor).finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, p);
    return p;
  }

  private async run(sessionId: string, actor: string): Promise<InterruptResult> {
    const open = this.openTurn(sessionId);
    const done = (via: InterruptVia, turnId: string | null): InterruptResult => {
      audit(this.d.db, actor, "session.interrupt", { sessionId, via, turnId });
      log.info("session interrupted", { sessionId, via, turnId });
      const result = { via, turnId };
      this.lastEsc.set(sessionId, { at: Date.now(), result, turnId: open?.id ?? null });
      return result;
    };

    // 1. A prompt with a waiting hook: Claude Code's own deny-and-interrupt, in every terminal.
    if (this.d.broker.stop(sessionId, actor)) {
      await Bun.sleep(this.t.graceMs);
      const turnId = open ? this.endStopped(open.id) : null;
      if (!open) this.d.registry.setStatus(sessionId, "idle");
      return done("prompt", turnId);
    }

    // The turn may have ended while we looked; never press Esc on an idle prompt.
    const fresh = this.d.registry.get(sessionId);
    if (!fresh || fresh.status === "ended") throw new StopError("not_found", "session not found or ended");
    if (fresh.status !== "working" && fresh.status !== "waiting")
      throw new StopError("conflict", "nothing to stop: the session isn't working");

    // 2. Esc in the session's terminal.
    const route = await pressEscape(fresh, this.keys);
    if (route) {
      const result = { via: route as InterruptVia, turnId: null as string | null };
      this.lastEsc.set(sessionId, { at: Date.now(), result, turnId: open?.id ?? null });
      if (open) result.turnId = await this.waitForMarker(sessionId, open);
      return done(result.via, result.turnId);
    }

    // 3. The inbox: a "now" message aborts the turn and starts one with the stop request.
    if (fresh.socketPath) {
      const confirmed = new Promise<string | null>((resolve) => {
        this.pendingInbox.set(sessionId, { turnId: open?.id ?? null, at: Date.now(), resolve });
      });
      try {
        await this.inbox(fresh.socketPath, fresh.socketToken, STOP_MESSAGE);
      } catch (err) {
        this.pendingInbox.delete(sessionId);
        if (err instanceof DeliveryError) throw new StopError("unavailable", err.message);
        throw err;
      }
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), this.t.inboxMs));
      const outcome = await Promise.race([confirmed, timeout]);
      if (outcome === "timeout") return done("message", null);
      return done("inbox", outcome);
    }

    throw new StopError("unavailable", "Relay has no way to reach this session");
  }

  /**
   * From UserPromptSubmit, before the new turn starts: when the prompt is the stop message this helper sent
   * through the inbox, the turn it cut off ends as stopped (`finish`, once the new turn is recorded).
   */
  takeInboxStop(sessionId: string, prompt: string): { finish(): void } | null {
    const pending = this.pendingInbox.get(sessionId);
    if (!pending || !prompt.includes(STOP_TEXT)) return null;
    this.pendingInbox.delete(sessionId);
    if (Date.now() - pending.at > PENDING_INBOX_MS) return null;
    const cutAt = Date.now();
    return {
      // After the new turn is recorded, and after a moment for Claude Code to write the cut-off text.
      finish: () => {
        setTimeout(() => {
          const row = pending.turnId
            ? (this.d.db.query("SELECT started_at, prompt FROM turns WHERE id = ?").get(pending.turnId) as {
                started_at: number | null;
                prompt: string | null;
              } | null)
            : null;
          const info = row?.started_at
            ? this.transcriptInfo(sessionId, row.started_at, cutAt, row.prompt)
            : null;
          pending.resolve(pending.turnId ? this.endStopped(pending.turnId, info) : null);
        }, this.t.graceMs);
      },
    };
  }

  /** True right after a stop ended the session's turn, so a late Stop hook doesn't record a second turn. */
  justStopped(sessionId: string): boolean {
    if (this.openTurn(sessionId)) return false;
    const last = this.d.db
      .query("SELECT stopped, ended_at FROM turns WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1")
      .get(sessionId) as { stopped: number; ended_at: number | null } | null;
    return Boolean(last?.stopped && last.ended_at && Date.now() - last.ended_at < 60_000);
  }

  /**
   * Esc pressed at the computer: no hook says so, but `claude agents` reports the session idle (reconcile) and
   * the transcript has the marker. Ends those open turns as stopped.
   */
  sweep(): void {
    const rows = this.d.db
      .query(
        `SELECT t.id, t.session_id, t.started_at, t.prompt FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.ended_at IS NULL AND t.started_at IS NOT NULL AND s.status = 'idle'`,
      )
      .all() as { id: string; session_id: string; started_at: number; prompt: string | null }[];
    for (const r of rows) {
      if (this.inflight.has(r.session_id)) continue;
      const info = this.transcriptInfo(r.session_id, r.started_at, undefined, r.prompt);
      if (info?.interrupted) this.endStopped(r.id, info);
    }
  }

  /**
   * Ends a turn as stopped and announces it once. Does nothing for a turn a Stop hook already finished. When
   * the turn was still the session's open one, the session goes idle; when a newer turn already started (a
   * message queued at the computer, or the inbox stop message), its status is left to that turn.
   */
  endStopped(turnId: string, known?: ReturnType<typeof interruptedTurn>): string | null {
    const row = this.d.db
      .query(
        "SELECT id, session_id, prompt, full_text, started_at, ended_at, stopped FROM turns WHERE id = ?",
      )
      .get(turnId) as {
      id: string;
      session_id: string;
      prompt: string | null;
      full_text: string | null;
      started_at: number | null;
      ended_at: number | null;
      stopped: number;
    } | null;
    if (!row || row.full_text !== null || row.stopped) return null;
    const info =
      known ??
      (row.started_at ? this.transcriptInfo(row.session_id, row.started_at, undefined, row.prompt) : null);
    const full = redact(info?.text ?? "");
    const { text: summary, truncated } = compact(full, this.d.config.previewChars);
    const now = Date.now();
    const endedAt = row.ended_at ?? now;
    const stats: TurnStats = {
      durationMs: row.started_at ? Math.max(0, (info?.endedAt ?? endedAt) - row.started_at) : null,
      toolCalls: info?.toolCalls ?? 0,
      filesEdited: info?.files ?? [],
    };
    // The transcript's tool calls, else what the hooks saw (turn-steps).
    const hookSteps = this.d.steps?.endTurn(row.session_id, row.id) ?? [];
    const timeline = timelineFields(info ? info.steps : hookSteps, info?.thoughts ?? []);
    if (!info && hookSteps.length) stats.toolCalls = hookSteps.length;
    const stepsJson = stepsJsonOf(timeline);
    // The transcript's messages without the answer, else what was sent live (live-messages).
    const liveSent = this.d.messages?.endTurn(row.session_id, row.id) ?? [];
    const messages = info
      ? finishedMessages(info.messages, info.text)
      : { messages: liveSent.slice(0, TURN_MESSAGES_MAX) };
    this.d.db
      .query(
        "UPDATE turns SET full_text = ?, summary = ?, truncated = ?, stats_json = ?, failed = 0, stopped = 1, ended_at = ?, steps_json = ?, messages_json = ? WHERE id = ?",
      )
      .run(
        full,
        summary,
        truncated ? 1 : 0,
        JSON.stringify(stats),
        endedAt,
        stepsJson,
        messagesJson(messages),
        row.id,
      );
    const turn: Turn = {
      id: row.id,
      sessionId: row.session_id,
      prompt: row.prompt,
      summary,
      fullLength: full.length,
      truncated,
      stats,
      failed: false,
      startedAt: row.started_at,
      endedAt,
      stopped: true,
      ...timeline,
      ...turnMessageFields(messages),
      ...attachmentFields(this.d.db, row.session_id, row.prompt),
    };
    this.d.events.emit({ type: "turn.done", turn });
    if (row.ended_at === null) {
      const s = this.d.registry.get(row.session_id);
      if (s && s.status !== "ended")
        this.d.registry.setStatus(row.session_id, "idle", summary ? { lastSummary: summary } : undefined);
    }
    log.info("turn stopped", { turnId: row.id });
    return row.id;
  }

  private async waitForMarker(sessionId: string, open: OpenTurn): Promise<string | null> {
    const end = Date.now() + this.t.markerMs;
    let unreadable = true;
    while (Date.now() < end) {
      await Bun.sleep(this.t.pollMs);
      const info = open.started_at
        ? this.transcriptInfo(sessionId, open.started_at, undefined, open.prompt)
        : null;
      if (info) unreadable = false;
      if (info?.interrupted) return this.endStopped(open.id, info);
      // A Stop hook got there first: the turn finished on its own.
      const row = this.d.db.query("SELECT full_text FROM turns WHERE id = ?").get(open.id) as {
        full_text: string | null;
      } | null;
      if (row?.full_text !== null && row?.full_text !== undefined) return null;
    }
    log.warn("no interrupt marker after Esc", {
      sessionId,
      turnId: open.id,
      transcriptUnreadable: unreadable,
    });
    return null;
  }

  private transcriptInfo(
    sessionId: string,
    since: number,
    until?: number,
    prompt: string | null = null,
  ): ReturnType<typeof interruptedTurn> {
    const session = this.d.registry.get(sessionId);
    const path = session ? (this.d.transcriptPath ?? transcriptPathFor)(session) : null;
    return path ? interruptedTurn(path, since, until, session?.cwd ?? null, prompt) : null;
  }

  private openTurn(sessionId: string): OpenTurn | null {
    return this.d.db
      .query(
        "SELECT id, started_at, prompt FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(sessionId) as OpenTurn | null;
  }
}

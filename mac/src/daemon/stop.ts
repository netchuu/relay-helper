import { statSync } from "node:fs";
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
import { type HeadlessSessions, ResumeError } from "./headless.ts";
import type { HeldReplies } from "./held.ts";
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
import { endedContextFull, interruptedTurn, transcriptPathFor } from "./transcript.ts";
import { CONTEXT_FULL, noteContextFull } from "./usage.ts";

/** A turn the transcript says nothing about. */
const NO_TURN_INFO: NonNullable<ReturnType<typeof interruptedTurn>> = {
  interrupted: false,
  text: "",
  toolCalls: 0,
  files: [],
  endedAt: null,
  steps: [],
  thoughts: [],
  messages: [],
  finished: false,
  lastAt: null,
};

/** The phone's Stop: interrupts the turn like Esc and ends it as stopped, since Claude Code runs no hook after one. */

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
  /** Replies Claude Code holds at the Mac (held-replies): a stop message held there has stopped nothing. */
  held?: HeldReplies;
  /** The Claude Code processes the helper runs itself (a continued session): Stop goes through their pipes. */
  headless?: Pick<HeadlessSessions, "has" | "interrupt">;
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
  /** A sweep ends an idle session's open turn on a finished answer only once the transcript has been quiet this long. */
  quietMs: number;
}

const TIMING: Timing = {
  graceMs: 400,
  markerMs: 5000,
  inboxMs: 3000,
  pollMs: 250,
  repeatMs: 2000,
  quietMs: 30_000,
};
/** A stop message held at the terminal (bypass mode) still counts once someone delivers it. */
const PENDING_INBOX_MS = 10 * 60_000;
/** Only turns this recent are failed when their session is found ended; older open rows are history. */
const DIED_WINDOW_MS = 24 * 3_600_000;
const DIED_NOTE = "Claude Code stopped before it finished.";
const withDiedNote = (text: string) => (text.trim() ? `${text.trimEnd()}\n\n${DIED_NOTE}` : DIED_NOTE);

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
  /** The transcript's size and mtime when a sweep last read it for a turn: unchanged, nothing new to find. */
  private readonly swept = new Map<string, string>();
  private readonly t: Timing;
  private readonly keys: KeyOps;
  private readonly inbox: (socketPath: string, token: string | null, text: string) => Promise<void>;

  /** Set after construction when the headless sessions are built later (main.ts). */
  headless: StopDeps["headless"];

  constructor(private readonly d: StopDeps) {
    this.headless = d.headless;
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
    // A quick second tap sends no second Esc (two open the rewind menu) and never stops a turn you haven't seen.
    // Same turn still running: the first tap's answer, unless a prompt opened, which is answered (no key).
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
    const done = (via: InterruptVia, turnId: string | null, heldAtMac = false): InterruptResult => {
      audit(this.d.db, actor, "session.interrupt", { sessionId, via, turnId });
      log.info("session interrupted", { sessionId, via, turnId });
      const result: InterruptResult = { via, turnId, ...(heldAtMac ? { heldAtMac: true as const } : {}) };
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

    // A session the helper runs itself has no terminal and no inbox of its own (a socket path on its row is the
    // closed terminal's): tell its process to stop the turn through the pipes the helper owns.
    if (this.headless?.has(sessionId)) {
      try {
        await this.headless.interrupt(sessionId);
      } catch (err) {
        if (err instanceof ResumeError) throw new StopError("unavailable", err.message);
        throw err;
      }
      await Bun.sleep(this.t.graceMs);
      const turnId = open ? this.endStopped(open.id) : null;
      // No hook follows an interrupt; a process that had to be ended already made the session ended. A turn that
      // opened meanwhile (the process started a queued message) is a new one: it stays working and stoppable.
      const next = this.openTurn(sessionId) !== null;
      if (!next && this.d.registry.get(sessionId)?.status !== "ended")
        this.d.registry.setStatus(sessionId, "idle");
      const result = done("headless", turnId);
      if (next) this.lastEsc.delete(sessionId);
      return result;
    }

    // 2. Esc in the session's terminal.
    const route = await pressEscape(fresh, this.keys);
    if (route) {
      const result = { via: route, turnId: null as string | null };
      this.lastEsc.set(sessionId, { at: Date.now(), result, turnId: open?.id ?? null });
      if (open) result.turnId = await this.waitForMarker(sessionId, open);
      return done(result.via, result.turnId);
    }

    // 3. The inbox: a "now" message aborts the turn and starts one with the stop request.
    if (fresh.socketPath) {
      const confirmed = new Promise<string | null>((resolve) => {
        this.pendingInbox.set(sessionId, { turnId: open?.id ?? null, at: Date.now(), resolve });
      });
      const watch = this.d.held?.expect(sessionId, STOP_MESSAGE, { stop: true });
      try {
        await this.inbox(fresh.socketPath, fresh.socketToken, STOP_MESSAGE);
      } catch (err) {
        watch?.cancel();
        this.pendingInbox.delete(sessionId);
        if (err instanceof DeliveryError) throw new StopError("unavailable", err.message);
        throw err;
      }
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), this.t.inboxMs));
      const outcome = await Promise.race([confirmed, timeout]);
      if (outcome === "timeout") {
        return done("message", null, watch?.holdNow() === true);
      }
      watch?.cancel();
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
    // The process died mid-turn: reconcile ended the session, and no hook will close the turn.
    const died = this.d.db
      .query(
        `SELECT t.id, t.session_id, t.started_at, t.prompt FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.ended_at IS NULL AND t.started_at IS NOT NULL AND t.full_text IS NULL AND s.status = 'ended'
         AND t.started_at > ?`,
      )
      .all(Date.now() - DIED_WINDOW_MS) as typeof rows;
    for (const r of died) {
      if (this.inflight.has(r.session_id)) continue;
      const info = this.transcriptInfo(r.session_id, r.started_at, undefined, r.prompt);
      this.endStopped(r.id, { ...(info ?? NO_TURN_INFO), text: withDiedNote(info?.text ?? "") }, false, true);
    }
    const open = new Set(rows.map((r) => r.id));
    for (const id of this.swept.keys()) if (!open.has(id)) this.swept.delete(id);
    for (const r of rows) {
      if (this.inflight.has(r.session_id)) continue;
      const stamp = this.transcriptStamp(r.session_id);
      if (stamp !== null && this.swept.get(r.id) === stamp) continue;
      const info = this.transcriptInfo(r.session_id, r.started_at, undefined, r.prompt);
      // The prompt didn't fit the context and Claude Code fired no Stop: the turn ends saying so.
      if (this.contextFullSince(r.session_id, r.started_at)) {
        noteContextFull(r.session_id, true);
        this.endStopped(r.id, { ...(info ?? NO_TURN_INFO), text: CONTEXT_FULL }, false);
        continue;
      }
      if (info?.interrupted) this.endStopped(r.id, info);
      else if (info?.finished && info.lastAt !== null && Date.now() - info.lastAt >= this.t.quietMs) {
        // A Stop hook was missed (the helper was down): Claude finished, and nothing came after the answer.
        this.endStopped(r.id, info, false);
      } else if (stamp !== null && !info?.finished) this.swept.set(r.id, stamp); // finished: wait out the quiet time
    }
  }

  /** Ends a turn as failed (its process stopped or reported an error); raises no push of its own. */
  endFailed(turnId: string, text?: string): string | null {
    const row = this.d.db
      .query("SELECT session_id, started_at, prompt FROM turns WHERE id = ?")
      .get(turnId) as { session_id: string; started_at: number | null; prompt: string | null } | null;
    if (!row) return null;
    if (text) return this.endStopped(turnId, { ...NO_TURN_INFO, text }, false, true);
    const info = row.started_at
      ? this.transcriptInfo(row.session_id, row.started_at, undefined, row.prompt)
      : null;
    return this.endStopped(
      turnId,
      { ...(info ?? NO_TURN_INFO), text: withDiedNote(info?.text ?? "") },
      false,
      true,
    );
  }

  /** Ends a turn as stopped and announces it once; the session goes idle unless a newer turn already started. */
  endStopped(
    turnId: string,
    known?: ReturnType<typeof interruptedTurn>,
    stopped = true,
    failed = false,
  ): string | null {
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
    const endedAt = row.ended_at ?? (stopped ? now : (info?.lastAt ?? now));
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
        "UPDATE turns SET full_text = ?, summary = ?, truncated = ?, stats_json = ?, failed = ?, stopped = ?, ended_at = ?, steps_json = ?, messages_json = ? WHERE id = ?",
      )
      .run(
        full,
        summary,
        truncated ? 1 : 0,
        JSON.stringify(stats),
        failed ? 1 : 0,
        stopped ? 1 : 0,
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
      failed,
      startedAt: row.started_at,
      endedAt,
      ...(stopped ? { stopped: true } : {}),
      ...(failed ? { died: true } : {}),
      ...timeline,
      ...turnMessageFields(messages),
      ...attachmentFields(this.d.db, row.session_id, row.prompt, row.id),
    };
    this.d.events.emit({ type: "turn.done", turn });
    if (row.ended_at === null) {
      const s = this.d.registry.get(row.session_id);
      if (s && s.status !== "ended")
        this.d.registry.setStatus(row.session_id, "idle", summary ? { lastSummary: summary } : undefined);
    }
    log.info(failed ? "turn failed: process gone" : stopped ? "turn stopped" : "stale open turn ended", {
      turnId: row.id,
    });
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

  private transcriptStamp(sessionId: string): string | null {
    const session = this.d.registry.get(sessionId);
    const path = session ? (this.d.transcriptPath ?? transcriptPathFor)(session) : null;
    if (!path) return null;
    try {
      const st = statSync(path);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private contextFullSince(sessionId: string, since: number): boolean {
    const session = this.d.registry.get(sessionId);
    const path = session ? (this.d.transcriptPath ?? transcriptPathFor)(session) : null;
    return path !== null && endedContextFull(path, since);
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

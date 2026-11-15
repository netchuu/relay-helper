import { randomUUID } from "node:crypto";
import { TURN_MESSAGES_MAX, type Turn, type TurnStats } from "../../../protocol/index.ts";
import type { RelayConfig } from "../config.ts";
import { log } from "../log.ts";
import { cleanTypedText } from "../shell/typedText.ts";
import { attachmentFields } from "./attachments.ts";
import { BackgroundTracker } from "./background.ts";
import type { Broker, HookReply } from "./broker.ts";
import type { DB } from "./db.ts";
import type { PermissionRequestInput } from "./decisions.ts";
import type { EventLog } from "./events.ts";
import { splitAttachmentPaths } from "./inject.ts";
import { finishedMessages, MessageTracker, messagesJson, turnMessageFields } from "./messages.ts";
import { modelFromTranscript, sessionModels } from "./model.ts";
import type { PresenceMonitor } from "./presence.ts";
import { notePromptSubmitted } from "./promptLine.ts";
import { redact } from "./redact.ts";
import type { HookEnv, Registry } from "./registry.ts";
import { compact, turnFromTranscript, withoutIdeContext } from "./render.ts";
import { StepTracker, stepsJsonOf, type ToolCall, timelineFields } from "./steps.ts";
import type { TurnStopper } from "./stop.ts";
import { head } from "./text.ts";
import { answerOwner, interruptedTurn, isSystemMessage } from "./transcript.ts";
import { forgetUsage, noteUsageAll, parseUsage } from "./usage.ts";

/** What relay-hook sends: the hook's stdin JSON plus details only visible in its environment. */
export interface HookEnvelope {
  payload: Record<string, unknown> & { hook_event_name?: string; session_id?: string };
  env: HookEnv;
}

export interface HookDeps {
  db: DB;
  events: EventLog;
  registry: Registry;
  broker: Broker;
  presence: PresenceMonitor;
  config: RelayConfig;
  /** The phone's Stop (session.interrupt); absent in tests that don't need it. */
  stopper?: TurnStopper;
  /** Live steps (turn-steps); one is made when absent. Tests pass their own timings. */
  steps?: StepTracker;
  /** Live messages (live-messages); one is made when absent. */
  messages?: MessageTracker;
  /** What runs in the background (background-work); one is made when absent. */
  background?: BackgroundTracker;
}

const NO_OUTPUT: HookReply = { stdout: "" };

/** Text recently typed into a tmux pane on the phone's behalf, so it isn't mistaken for local presence. */
const phoneTyped = new Map<string, { text: string; head: string; paths: string[]; at: number }>();

/** Whitespace squashed and zero-width characters dropped, so two renderings of one message compare equal. */
function squash(t: string): string {
  return t
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What Claude Code reports back for `text` after the phone typed it: the cleaned text (what is really typed), without
 * trailing attachment paths (a pasted image path comes back as "[Image #N]"), squashed, its first 40 characters.
 */
function typedHead(clean: string): string {
  return squash(splitAttachmentPaths(clean).body).slice(0, 40);
}

export function notePhoneTyped(sessionId: string, text: string): void {
  const clean = cleanTypedText(text);
  const paths = splitAttachmentPaths(clean).paths.map((p) => p.replace(/^"|"$/g, ""));
  phoneTyped.set(sessionId, { text: clean, head: typedHead(clean), paths, at: Date.now() });
}

/**
 * Whether the prompt Claude Code reported is the text the phone typed. An empty prompt never is; with no caption,
 * only a prompt that shows the image ("[Image #N]" first, or the path itself) is.
 */
function matchesPhoneTyped(typed: { head: string; paths: string[] }, prompt: string): boolean {
  const s = squash(prompt);
  if (s === "") return false;
  if (typed.head !== "") return s.includes(typed.head);
  return s.startsWith("[Image #") || typed.paths.some((p) => s.includes(squash(p)));
}

/** Whether the phone's text typed at `since` hasn't come back as a UserPromptSubmit hook yet (it isn't submitted). */
export function phoneTypePending(sessionId: string, text: string): boolean {
  const typed = phoneTyped.get(sessionId);
  return typed !== undefined && typed.text === cleanTypedText(text);
}

/**
 * A Claude Code notice (a background task finishing) that arrives while the session's turn is still running and
 * no Stop has come yet belongs to that turn: Claude takes it in mid-answer. If that turn's Stop then comes within
 * this time, the notice was really the next turn (the two hooks raced), and a turn starts for it after the Stop.
 */
const HELD_NOTICE_MS = 2000;

export class HookHandler {
  private readonly steps: StepTracker;
  private readonly messages: MessageTracker;
  private readonly background: BackgroundTracker;
  /** Sessions whose Stop is being handled (its transcript wait), by when it arrived. */
  private readonly stopping = new Map<string, number>();
  /** A notice held back during a running turn, by when it arrived (HELD_NOTICE_MS). */
  private readonly heldNotice = new Map<string, number>();
  /**
   * Turns whose answer came while later prompts were still waiting (stopOwner): everything in the transcript up
   * to now is theirs, also what they did after those prompts' hooks came.
   */
  private readonly answeredAhead = new Set<string>();

  constructor(private readonly d: HookDeps) {
    this.steps = d.steps ?? new StepTracker(d.events);
    this.messages = d.messages ?? new MessageTracker(d.events);
    this.background = d.background ?? new BackgroundTracker(d.events);
  }

  /** A status line refresh (usage-left): keeps what is left of the limits and tells the phones when it changed. */
  statusLine(payload: Record<string, unknown>): void {
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string") return;
    const known = this.d.registry.get(sessionId);
    if (!known || known.status === "ended") return;
    // The model and effort the status line reports: published when either changed.
    const model = payload.model as { display_name?: unknown } | undefined;
    const effort = payload.effort as { level?: unknown } | undefined;
    const changedModel = sessionModels.setModelName(sessionId, model?.display_name);
    const changedEffort = sessionModels.setEffort(sessionId, effort?.level);
    if (changedModel || changedEffort) this.d.registry.publish(sessionId);
    // The account's limits changed for every live session, not only this one.
    for (const id of noteUsageAll(sessionId, parseUsage(payload))) {
      // The registry ends sessions without a SessionEnd hook too (process gone, no longer listed): drop those.
      if (this.d.registry.get(id)?.status === "ended") forgetUsage(id);
      else this.d.registry.publish(id);
    }
  }

  async handle(envelope: HookEnvelope, signal: AbortSignal): Promise<HookReply> {
    const p = envelope.payload;
    const event = p.hook_event_name;
    const sessionId = p.session_id;
    if (!event || !sessionId) return NO_OUTPUT;

    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    const { session, created } = this.d.registry.touch(sessionId, {
      cwd: str("cwd"),
      transcript: str("transcript_path"),
      env: envelope.env,
      name: str("session_title") ?? null,
    });
    if (created) this.d.registry.publish(sessionId);
    // A session that started before the helper did: its model is in the transcript, read once per prompt or stop
    // (the status change that follows publishes it).
    if ((event === "UserPromptSubmit" || event === "Stop") && !sessionModels.has(sessionId))
      sessionModels.setModel(sessionId, modelFromTranscript(session.transcript ?? str("transcript_path")));

    switch (event) {
      case "SessionStart":
        sessionModels.setModel(sessionId, p.model);
        this.d.registry.publish(sessionId);
        return NO_OUTPUT;

      // The model changed (from the phone's `/model` or at the Mac): the new one is the one Claude Code reports.
      case "PostModelSwitch":
        if (sessionModels.setModel(sessionId, p.to_model)) this.d.registry.publish(sessionId);
        return NO_OUTPUT;

      case "UserPromptSubmit": {
        // What the person typed: the IDE extension's context blocks are for Claude, not for the phone.
        // A background task's notification or another message Claude Code adds itself starts a turn too, but
        // nobody typed it: the phone shows no bubble for it, and it isn't presence at the computer.
        const raw = withoutIdeContext(str("prompt") ?? "");
        const system = isSystemMessage(raw);
        // Only a real submit empties the input box; a notice leaves the typed draft where it was.
        if (!system) notePromptSubmitted(sessionId);
        // A background task finished: Claude Code tells the session with a notification (background-work).
        if (system) this.background.notified(sessionId, raw);
        const prompt = system ? "" : raw;
        this.d.broker.settleFromSessionEvent(sessionId, { hookEventName: event });
        // A notice while the turn is still running (no Stop yet) is part of that turn, not a new one: closing the
        // turn here would leave it without its answer and put the answer on a turn without a prompt.
        if (system && !this.stopping.has(sessionId) && this.openTurn(sessionId)) {
          this.heldNotice.set(sessionId, Date.now());
          return NO_OUTPUT;
        }
        const typed = phoneTyped.get(sessionId);
        const fromPhone = typed && Date.now() - typed.at < 15_000 && matchesPhoneTyped(typed, prompt);
        if (fromPhone) phoneTyped.delete(sessionId);
        // The stop message the helper sent through the inbox: it cut the old turn off, which ends as stopped.
        const inboxStop = this.d.stopper?.takeInboxStop(sessionId, prompt) ?? null;
        if (!fromPhone && !inboxStop && !system) this.d.presence.noteLocalActivity();
        this.beginTurn(sessionId, prompt, session.transcript ?? str("transcript_path") ?? null, session.cwd);
        inboxStop?.finish();
        this.d.registry.setStatus(
          sessionId,
          "working",
          system ? {} : { title: oneLine(redact(prompt), 120) },
        );
        return NO_OUTPUT;
      }

      case "PermissionRequest":
        // A process the helper runs asks over its own channel too (can_use_tool): one prompt, not two.
        if (this.d.registry.ownedByHelper(sessionId)) return NO_OUTPUT;
        return this.permissionRequest(p as unknown as PermissionRequestInput, signal);

      case "PreToolUse": {
        const call = toolCall(p, session.cwd);
        this.steps.toolStarted(sessionId, call);
        this.messages.poll(sessionId);
        // A denied tool has no end hook, so the next tool starting is the first sign Claude went on.
        if (!call.agentId && session.status === "waiting" && !this.d.broker.hasOpen(sessionId))
          this.d.registry.setStatus(sessionId, "working");
        // A background agent's tool call: what that agent is doing now (background-work).
        if (call.agentId)
          this.background.agentTool(sessionId, call.agentId, call.toolName, call.input ?? {}, session.cwd);
        return NO_OUTPUT;
      }

      case "PostToolUse":
      case "PostToolUseFailure":
      case "PermissionDenied": {
        this.d.broker.settleFromSessionEvent(sessionId, {
          hookEventName: event,
          toolName: str("tool_name"),
          toolInput: (p.tool_input as Record<string, unknown>) ?? {},
          toolResponse: p.tool_response,
        });
        const ended = toolCall(p, session.cwd);
        this.steps.toolEnded(sessionId, ended, event !== "PostToolUse");
        // A background agent's finished tool call is its activity too, until its next one (background-work).
        if (ended.agentId)
          this.background.agentTool(
            sessionId,
            ended.agentId,
            ended.toolName,
            ended.input ?? {},
            session.cwd,
            true,
          );
        this.messages.poll(sessionId);
        if (session.status === "waiting" && !this.d.broker.hasOpen(sessionId))
          this.d.registry.setStatus(sessionId, "working");
        return NO_OUTPUT;
      }

      case "Stop":
      case "StopFailure": {
        this.d.broker.settleFromSessionEvent(sessionId, { hookEventName: event });
        // Claude Code's own list of what still runs in the background (background-work).
        this.background.stopped(sessionId, p.background_tasks);
        // The phone's Stop already ended this turn; don't record it a second time.
        if (this.d.stopper?.justStopped(sessionId)) {
          if (session.status !== "idle" && session.status !== "ended")
            this.d.registry.setStatus(sessionId, "idle");
          return NO_OUTPUT;
        }
        const stopAt = Date.now();
        this.stopping.set(sessionId, stopAt);
        try {
          const failed = event === "StopFailure";
          const text = str("last_assistant_message") ?? "";
          // The turn this Stop ends, taken before the wait: hooks are async, so a prompt queued at the computer
          // can start the next turn meanwhile, and that one isn't finished by this Stop.
          const picked = this.openTurn(sessionId);
          const transcript = session.transcript ?? str("transcript_path") ?? null;
          // The transcript is flushed asynchronously; give it a moment before reading stats.
          await Bun.sleep(400);
          const ending = this.stopOwner(sessionId, picked, text, transcript, session.cwd);
          const turn = this.finishTurn(sessionId, ending, text, failed, transcript, session.cwd);
          // Idle even with background shells still running (a dev server): the prompt waits for you. One finishing
          // starts a turn of its own.
          const next = this.openTurn(sessionId);
          this.d.registry.setStatus(sessionId, next && next.id !== turn.id ? "working" : "idle", {
            lastSummary: turn.summary,
          });
          if (failed)
            this.d.events.emit({
              type: "session.notice",
              sessionId,
              level: "error",
              text: head(`${str("error") ?? "error"}: ${str("error_details") ?? text}`, 500),
            });
          // A notice held back just before this Stop was the next turn after all: it starts now.
          const held = this.heldNotice.get(sessionId);
          this.heldNotice.delete(sessionId);
          if (held !== undefined && stopAt - held < HELD_NOTICE_MS && !(next && next.id !== turn.id)) {
            this.beginTurn(sessionId, "", transcript, session.cwd);
            this.d.registry.setStatus(sessionId, "working");
          }
          return NO_OUTPUT;
        } finally {
          if (this.stopping.get(sessionId) === stopAt) this.stopping.delete(sessionId);
        }
      }

      case "Notification": {
        const type = str("notification_type");
        if (type && type !== "permission_prompt" && type !== "auth_success") {
          this.d.events.emit({
            type: "session.notice",
            sessionId,
            level: type === "idle_prompt" || type === "agent_needs_input" ? "attention" : "info",
            text: head(redact(str("message") ?? type), 500),
          });
        }
        return NO_OUTPUT;
      }

      case "SessionEnd":
        this.d.broker.settleFromSessionEvent(sessionId, { hookEventName: event });
        this.background.clear(sessionId);
        this.steps.clear(sessionId);
        this.messages.clear(sessionId);
        forgetUsage(sessionId);
        this.d.registry.setStatus(sessionId, "ended");
        sessionModels.forget(sessionId);
        return NO_OUTPUT;

      default:
        return NO_OUTPUT;
    }
  }

  /** A permission request that doesn't come from a hook (a process the helper owns): the same prompt and status. */
  openPrompt(input: PermissionRequestInput, signal: AbortSignal): Promise<HookReply> {
    return this.permissionRequest(input, signal);
  }

  private async permissionRequest(input: PermissionRequestInput, signal: AbortSignal): Promise<HookReply> {
    const { prompt, reply } = this.d.broker.open(input);
    this.d.registry.setStatus(input.session_id, "waiting");
    log.info("prompt opened", { promptId: prompt.id, kind: prompt.kind, tool: input.tool_name });
    // Claude Code ends the waiting hook when the dialog is answered in the terminal (Yes, No, Esc, plan
    // feedback), the turn is interrupted or Claude exits. After No, Esc or feedback no other hook event
    // follows, so this is the only sign: close the prompt, or the phone keeps showing it, reminders
    // repeat it, and an answer from the phone goes nowhere. (Its own timeout is 24 h, like the prompt's.)
    // Tie the prompt to its tool now: PreToolUse(dN) comes right before PermissionRequest(dN).
    const toolId = this.steps.promptOpened(
      input.session_id,
      input.tool_name,
      input.tool_input as Record<string, unknown> | undefined,
      this.d.registry.get(input.session_id)?.cwd ?? null,
    );
    // A phone answer marks nothing: the tool runs or its end hook follows.
    let answered = false;
    void reply.then(() => {
      answered = true;
    });
    const aborted = new Promise<HookReply>((resolve) =>
      signal.addEventListener("abort", () => {
        this.d.broker.close(prompt.id, "mac");
        if (!answered) this.steps.promptClosed(input.session_id, toolId);
        resolve(NO_OUTPUT);
      }),
    );
    return Promise.race([reply, aborted]);
  }

  /** Starts a turn and its live trackers (steps, messages, timeline). */
  private beginTurn(
    sessionId: string,
    prompt: string,
    transcript: string | null,
    cwd: string | null,
  ): string {
    const { turnId, startedAt } = this.startTurn(sessionId, prompt);
    this.steps.turnStarted(sessionId, turnId);
    // The turn's own start time, so live and finished thinking lines are timed from the same moment.
    this.messages.turnStarted(sessionId, turnId, transcript, startedAt, cwd);
    return turnId;
  }

  private startTurn(sessionId: string, prompt: string): { turnId: string; startedAt: number } {
    const now = Date.now();
    this.d.db
      .query("UPDATE turns SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL")
      .run(now, sessionId);
    const turnId = newId("t");
    const shown = redact(prompt);
    this.d.db
      .query("INSERT INTO turns (id, session_id, prompt, started_at) VALUES (?, ?, ?, ?)")
      .run(turnId, sessionId, shown, now);
    // The phone shows the prompt at once, not only when the answer is done.
    this.d.events.emit({
      type: "turn.started",
      turnId,
      sessionId,
      prompt: shown,
      startedAt: now,
      ...attachmentFields(this.d.db, sessionId, shown),
    });
    return { turnId, startedAt: now };
  }

  /**
   * The turn a Stop ends. Usually the open one; but the Stop can also arrive just after the next prompt's hook
   * (both are async). Then the open turn is that new one, and the answer belongs to the turn before it, which the
   * new prompt closed unanswered. Told apart by the transcript: the answer is that turn's last text, and not among
   * the new turn's.
   */
  private stopOwner(
    sessionId: string,
    picked: OpenTurn | null,
    answer: string,
    transcript: string | null,
    cwd: string | null,
  ): OpenTurn | null {
    if (!picked?.started_at || !transcript || !answer.trim()) return picked;
    const before = this.d.db
      .query(
        "SELECT id, prompt, started_at FROM turns WHERE session_id = ? AND id != ? AND ended_at = ? AND full_text IS NULL AND stopped = 0 ORDER BY started_at DESC LIMIT 1",
      )
      .get(sessionId, picked.id, picked.started_at) as OpenTurn | null;
    // Prompts sent while Claude was still answering (from the phone, or queued at the computer): each one's hook
    // came before this Stop and closed the turn before it, but Claude Code starts on them only now, and in the
    // transcript the answer stands before them. The answer is for the newest of these turns whose prompt stands
    // before it (or nobody's prompt), and the later ones wait: the new turn was shown as done with the previous
    // answer under it, and its own answer then landed under the next message.
    const waiting = this.unansweredUpTo(sessionId, picked);
    const owner = answerOwner(
      transcript,
      answer,
      waiting.map((t) => ({ id: t.id, prompt: t.prompt, startedAt: t.started_at ?? 0 })),
    );
    if (owner !== undefined) {
      if (owner !== null && owner !== picked.id) this.answeredAhead.add(owner);
      return waiting.find((t) => t.id === owner) ?? null;
    }
    if (!before?.started_at) return picked;
    // Only on positive evidence: the answer is the earlier turn's own last text, that turn wasn't interrupted
    // (Esc, then a new prompt), and the new turn hasn't written it. A lagging transcript or an API error keeps
    // the Stop with the open turn.
    const same = (m: { raw: string }) => m.raw.trim() === answer.trim();
    const earlier = interruptedTurn(transcript, before.started_at, picked.started_at, cwd, before.prompt);
    const last = earlier?.messages.at(-1);
    if (!earlier || earlier.interrupted || !last || !same(last)) return picked;
    const own = interruptedTurn(transcript, picked.started_at, Number.POSITIVE_INFINITY, cwd, picked.prompt);
    if (own?.messages.some(same)) return picked;
    return before;
  }

  /**
   * `open` and, before it, the turns each closed unanswered by the next one's prompt (a run of prompts sent while
   * Claude was answering), oldest first.
   */
  private unansweredUpTo(sessionId: string, open: OpenTurn): OpenTurn[] {
    const chain = [open];
    // By the order they were recorded, not by time alone: several can arrive within one millisecond.
    for (let last = open; last.started_at !== null && chain.length < 20; ) {
      const before = this.d.db
        .query(
          "SELECT id, prompt, started_at FROM turns WHERE session_id = ? AND rowid < (SELECT rowid FROM turns WHERE id = ?) AND ended_at = ? AND full_text IS NULL AND stopped = 0 ORDER BY rowid DESC LIMIT 1",
        )
        .get(sessionId, last.id, last.started_at) as OpenTurn | null;
      if (!before) break;
      chain.unshift(before);
      last = before;
    }
    return chain;
  }

  private openTurn(sessionId: string): OpenTurn | null {
    return this.d.db
      .query(
        "SELECT id, prompt, started_at FROM turns WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(sessionId) as OpenTurn | null;
  }

  private finishTurn(
    sessionId: string,
    open: OpenTurn | null,
    rawText: string,
    failed: boolean,
    transcript: string | null,
    cwd: string | null,
  ): Turn {
    const id = open?.id ?? newId("t");
    const full = redact(rawText);
    const { text: summary, truncated } = compact(full, this.d.config.previewChars);
    // A newer turn already started (a prompt queued at the computer): only this turn's part of the transcript,
    // from its prompt to the next one. Otherwise everything since the last prompt.
    const next = this.openTurn(sessionId);
    const newer = next && next.id !== open?.id;
    const fromTranscript = !transcript
      ? null
      : // Unknown where this turn starts, and a newer one has begun: no safe part of the transcript to read.
        !open && newer
        ? null
        : open?.started_at && newer
          ? boundedTurn(
              transcript,
              { ...open, started_at: open.started_at },
              // The next prompt's hook came while this turn still ran (it waits its turn): what was done after
              // that hook is this turn's too.
              this.answeredAhead.delete(open.id)
                ? Number.POSITIVE_INFINITY
                : (next.started_at ?? Number.POSITIVE_INFINITY),
              cwd,
            )
          : // A turn begun on a notice was started with no prompt (UserPromptSubmit, above).
            turnFromTranscript(transcript, open?.started_at ?? null, cwd, open?.prompt === "");
    const stats: TurnStats = fromTranscript?.stats ?? {
      durationMs: transcript && open?.started_at ? Date.now() - open.started_at : null,
      toolCalls: 0,
      filesEdited: [],
    };
    // The transcript is the full record; without one, the steps the hooks saw.
    // No turn known (the helper started mid-turn): whatever the trackers follow is a newer turn; leave it.
    const hookSteps = open ? this.steps.endTurn(sessionId, open.id) : [];
    const timeline = timelineFields(
      fromTranscript ? fromTranscript.steps : hookSteps,
      fromTranscript?.thoughts ?? [],
    );
    if (!fromTranscript && hookSteps.length) stats.toolCalls = hookSteps.length;
    const stepsJson = stepsJsonOf(timeline);
    // The transcript's messages without the final answer, else what was sent live (live-messages).
    const liveSent = open ? this.messages.endTurn(sessionId, open.id) : [];
    const messages = fromTranscript
      ? finishedMessages(fromTranscript.messages, rawText)
      : { messages: liveSent.slice(0, TURN_MESSAGES_MAX) };
    const msgsJson = messagesJson(messages);
    const endedAt = Date.now();
    if (open) {
      this.d.db
        .query(
          "UPDATE turns SET full_text = ?, summary = ?, truncated = ?, stats_json = ?, failed = ?, ended_at = ?, steps_json = ?, messages_json = ? WHERE id = ?",
        )
        .run(
          full,
          summary,
          truncated ? 1 : 0,
          JSON.stringify(stats),
          failed ? 1 : 0,
          endedAt,
          stepsJson,
          msgsJson,
          id,
        );
    } else {
      this.d.db
        .query(
          "INSERT INTO turns (id, session_id, full_text, summary, truncated, stats_json, failed, started_at, ended_at, steps_json, messages_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .run(
          id,
          sessionId,
          full,
          summary,
          truncated ? 1 : 0,
          JSON.stringify(stats),
          failed ? 1 : 0,
          endedAt,
          stepsJson,
          msgsJson,
        );
    }
    const turn: Turn = {
      id,
      sessionId,
      prompt: open?.prompt ?? null,
      summary,
      fullLength: full.length,
      truncated,
      stats,
      failed,
      startedAt: open?.started_at ?? null,
      endedAt,
      ...timeline,
      ...turnMessageFields(messages),
      ...attachmentFields(this.d.db, sessionId, open?.prompt),
    };
    this.d.events.emit({ type: "turn.done", turn });
    return turn;
  }
}

interface OpenTurn {
  id: string;
  prompt: string | null;
  started_at: number | null;
}

/** A turn's stats, steps and messages from its own part of the transcript: from its prompt to `until`. */
function boundedTurn(
  transcript: string,
  open: OpenTurn & { started_at: number },
  until: number,
  cwd: string | null,
): ReturnType<typeof turnFromTranscript> {
  const info = interruptedTurn(transcript, open.started_at, until, cwd, open.prompt);
  if (!info) return null;
  return {
    stats: {
      durationMs: Math.max(0, (info.endedAt ?? Date.now()) - open.started_at),
      toolCalls: info.toolCalls,
      filesEdited: info.files,
    },
    steps: info.steps,
    thoughts: info.thoughts,
    messages: info.messages,
  };
}

/** The tool call in a PreToolUse/PostToolUse payload, for the step tracker. */
function toolCall(p: Record<string, unknown>, cwd: string | null): ToolCall {
  const s = (k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : null);
  const input =
    p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  return { toolUseId: s("tool_use_id"), toolName: s("tool_name") ?? "", input, cwd, agentId: s("agent_id") };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${head(line, max - 1)}…` : line;
}

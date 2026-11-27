import { randomUUID } from "node:crypto";
import { TURN_MESSAGES_MAX, type Turn, type TurnCommand, type TurnStats } from "../../../protocol/index.ts";
import type { RelayConfig } from "../config.ts";
import { log } from "../log.ts";
import { cleanTypedText } from "../shell/typedText.ts";
import { attachmentFields, attachmentIdsAtPaths, recordTurnAttachments } from "./attachments.ts";
import { BackgroundTracker } from "./background.ts";
import type { Broker, HookReply } from "./broker.ts";
import { type HookTrace, type LocalCommand, LocalCommandReader } from "./commandTurns.ts";
import type { DB } from "./db.ts";
import { type ElicitationInput, elicitationQuestion, type PermissionRequestInput } from "./decisions.ts";
import { type DialogWatcher, HOOK_DIALOGS } from "./dialogWatch.ts";
import type { EventLog } from "./events.ts";
import { failureLine, noticeFor } from "./failureWords.ts";
import type { Handover } from "./handover.ts";
import { type HeldReplies, notePermissionMode } from "./held.ts";
import { clearLeftUnsent, draftSubmitted, splitAttachmentPaths } from "./inject.ts";
import { finishedMessages, MessageTracker, messagesJson, turnMessageFields } from "./messages.ts";
import { modelFromTranscript, sessionModels } from "./model.ts";
import type { PresenceMonitor } from "./presence.ts";
import { notePromptSubmitted } from "./promptLine.ts";
import { redact } from "./redact.ts";
import { type EndReason, endReasonOf, type HookEnv, type Registry } from "./registry.ts";
import { compact, turnFromTranscript, withoutIdeContext } from "./render.ts";
import { StepTracker, stepsJsonOf, type ToolCall, timelineFields } from "./steps.ts";
import type { TurnStopper } from "./stop.ts";
import type { SuggestionWatcher } from "./suggestion.ts";
import { forgetSuggestionKnown } from "./suggestionSeen.ts";
import { head } from "./text.ts";
import { markShownAsTurn, shownOutput } from "./timeline.ts";
import {
  answerOwner,
  endedContextFull,
  interruptedTurn,
  isSystemMessage,
  transcriptPathFor,
} from "./transcript.ts";
import {
  CONTEXT_FULL,
  forgetUsage,
  isContextFullError,
  noteContextFull,
  noteUsageAll,
  parseUsage,
  usageOf,
} from "./usage.ts";

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
  /** Claude Code's suggested next message, read off the terminal after a turn; absent in tests that don't need it. */
  suggestions?: SuggestionWatcher;
  /** Terminal dialogs waiting at the Mac (`Session.atMac`); absent in tests that don't need it. */
  dialogs?: DialogWatcher;
  /** Replies Claude Code holds at the Mac (held-replies); absent in tests that don't need it. */
  held?: HeldReplies;
  /** Stops Relay's own terminal copy of a chat resumed in the person's terminal; absent in tests that don't need it. */
  handover?: Handover;
}

const NO_OUTPUT: HookReply = { stdout: "" };

/** Text recently typed into a tmux pane on the phone's behalf, so it isn't mistaken for local presence. */
type PhoneTyped = {
  text: string;
  head: string;
  paths: string[];
  at: number;
  notedAt: number;
  delivering: boolean;
  sendId?: string;
};
/** Newest last. A terminal session keeps one; a session the helper runs keeps every message it hasn't reported yet. */
const phoneTyped = new Map<string, PhoneTyped[]>();
/** The running handler, told when a slash command is noted so its transcript is read from before the echo. */
let slashNoted: ((sessionId: string) => void) | null = null;

function removeTyped(sessionId: string, entry: PhoneTyped): void {
  const rest = (phoneTyped.get(sessionId) ?? []).filter((e) => e !== entry);
  if (rest.length > 0) phoneTyped.set(sessionId, rest);
  else phoneTyped.delete(sessionId);
}

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

/** How long what the phone typed can still be matched to a prompt, for its photos (an unsent message submitted late). */
const PHONE_TYPED_KEEP_MS = 30 * 60_000;

/**
 * `delivering`: the message is still waiting to be typed (the caller calls `phoneTypeDelivered` when `deliver`
 * returns), so another prompt must not discard it and its age counts from when it was typed.
 */
export function notePhoneTyped(
  sessionId: string,
  text: string,
  delivering = false,
  sendId?: string,
  keepEarlier = false,
): void {
  const clean = cleanTypedText(text);
  const paths = splitAttachmentPaths(clean).paths.map((p) => p.replace(/^"|"$/g, ""));
  const entry: PhoneTyped = {
    text: clean,
    head: typedHead(clean),
    paths,
    at: Date.now(),
    notedAt: Date.now(),
    delivering,
    ...(sendId ? { sendId } : {}),
  };
  const earlier = keepEarlier
    ? (phoneTyped.get(sessionId) ?? []).filter((e) => Date.now() - e.notedAt < PHONE_TYPED_KEEP_MS)
    : [];
  phoneTyped.set(sessionId, [...earlier, entry]);
  slashNoted?.(sessionId);
}

/** The message `notePhoneTyped` stored was typed just now: its age starts here. */
export function phoneTypeDelivered(sessionId: string, text: string): void {
  const typed = phoneTyped.get(sessionId)?.findLast((e) => e.text === cleanTypedText(text));
  if (!typed) return;
  typed.delivering = false;
  typed.at = Date.now();
}

/** Forgets what `notePhoneTyped` stored when nothing was typed (queued, failed), so a Mac prompt can't match it. */
export function dropPhoneTyped(sessionId: string, text: string): void {
  const typed = phoneTyped.get(sessionId)?.findLast((e) => e.text === cleanTypedText(text));
  if (typed) removeTyped(sessionId, typed);
}

/** First messages of sessions the phone is starting: their id isn't known until the launch returns. */
const phoneLaunches = new Set<{
  cwd: string;
  head: string;
  paths: string[];
  text: string;
  taken: boolean;
  expiresAt: number;
}>();

/** How long a launch whose session wasn't found keeps waiting for that session's first hook. */
export const UNFOUND_LAUNCH_MS = 30_000;

/** The phone starts a session in `cwd`: its first hook can beat the session id, so it is matched by folder and text. */
export function notePhoneLaunch(
  cwd: string,
  text: string,
): { done: (sessionId: string) => void; abort: () => void; keep: (ms?: number) => void } {
  const clean = cleanTypedText(text);
  const paths = splitAttachmentPaths(clean).paths.map((p) => p.replace(/^"|"$/g, ""));
  const launch = { cwd, head: typedHead(clean), paths, text: clean, taken: false, expiresAt: Infinity };
  phoneLaunches.add(launch);
  return {
    done: (sessionId) => {
      phoneLaunches.delete(launch);
      if (!launch.taken) notePhoneTyped(sessionId, text);
    },
    abort: () => void phoneLaunches.delete(launch),
    // The session started but couldn't be looked up: its first hook is still the phone's text, for a while.
    keep: (ms = UNFOUND_LAUNCH_MS) => {
      launch.expiresAt = Date.now() + ms;
      setTimeout(() => phoneLaunches.delete(launch), ms).unref();
    },
  };
}

/** Whether `prompt` in `cwd` is the first message of a session the phone is starting; it is used up then. */
function takePhoneLaunch(cwd: string | undefined, prompt: string): string[] | null {
  if (!cwd) return null;
  for (const l of phoneLaunches) {
    if (l.expiresAt <= Date.now()) phoneLaunches.delete(l);
    else if (!l.taken && l.cwd === cwd && matchesPhoneTyped(l, prompt)) {
      l.taken = true;
      return l.paths;
    }
  }
  return null;
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

/**
 * A stricter match for a prompt reported long after the phone typed (an unsent message submitted later): it must
 * start with the caption (after any "[Image #N]" marks) and, when the phone typed files, show an image.
 */
function matchesLatePhoneTyped(typed: { head: string; paths: string[] }, prompt: string): boolean {
  const s = squash(prompt);
  if (typed.paths.length > 0 && !s.includes("[Image #") && !typed.paths.some((p) => s.includes(squash(p))))
    return false;
  return typed.head === "" || s.replace(/^(\[Image #\d+\]\s*)+/, "").startsWith(typed.head);
}

/** Whether the phone's text typed at `since` hasn't come back as a UserPromptSubmit hook yet (it isn't submitted). */
export function phoneTypePending(sessionId: string, text: string): boolean {
  return phoneTyped.get(sessionId)?.some((e) => e.text === cleanTypedText(text)) ?? false;
}

/** A notice during a running turn belongs to it; a Stop within this time means it was the next turn (hooks raced). */
const HELD_NOTICE_MS = 2000;
/** What the turn of a `/compact` says once it is done. */
const COMPACTING_LABEL = "Compacting the conversation";
export const COMPACTED = "Conversation compacted.";
const QUIT = "Claude Code was quit.";
const CLEARED = "Cleared. The conversation continues in a new chat.";
const BLOCKED_PREFIX = "A hook on your computer blocked this message";
const LOST_TEXT = "Claude Code ended before it read this message.";
/** What it says when nothing reported the end of a `/compact`. */
export const COMPACT_FAILED = "Compacting didn't finish. Try it again, or clear the chat.";
/** How long a `/compact` may take before its turn is given up as failed (a long chat took 80 s). */
const COMPACT_GIVE_UP_MS = 10 * 60_000;
/** How long after typing a slash command the phone's send is watched for its echo. */
const SLASH_WATCH_MS = 30_000;

const LINK_WINDOW_MS = 10_000;

interface EndedForLink {
  at: number;
  pid: number;
  pty: string | null;
  tmux: string | null;
}

const terminalOf = (env: HookEnv) => ({
  pty: env.pty ?? null,
  tmux: env.tmux && env.tmuxPane ? `${env.tmux.split(",")[0]}|${env.tmuxPane}` : null,
});

export class HookHandler {
  private readonly steps: StepTracker;
  private readonly messages: MessageTracker;
  private readonly background: BackgroundTracker;
  /** Sessions whose Stop is being handled (its transcript wait), by when it arrived. */
  private readonly stopping = new Map<string, number>();
  /** The turn a `/compact` started, by session, until Claude Code says the session was compacted. */
  private readonly compacting = new Map<string, string>();
  /** Tests shorten it. */
  compactGiveUpMs = COMPACT_GIVE_UP_MS;
  private readonly localCommands = new LocalCommandReader();
  /** The phone's `sendId` of each turn it started, for a block that comes after the turn began. */
  private readonly turnSends = new Map<string, { sessionId: string; sendId: string; at: number }>();
  private readonly reportedHookErrors = new Map<string, Set<string>>();
  /** How long an echo waits for its output before it counts as a command that printed nothing; tests shorten it. */
  commandGraceMs = 1500;
  /** A notice held back during a running turn, by when it arrived (HELD_NOTICE_MS). */
  private readonly heldNotice = new Map<string, number>();
  /** Chats that ended by /clear or /resume and wait for their successor, by session id. */
  private readonly endedForLink = new Map<string, EndedForLink>();
  /**
   * Turns whose answer came while later prompts were still waiting (stopOwner): everything in the transcript up
   * to now is theirs, also what they did after those prompts' hooks came.
   */
  private readonly answeredAhead = new Set<string>();

  constructor(private readonly d: HookDeps) {
    this.steps = d.steps ?? new StepTracker(d.events);
    this.messages = d.messages ?? new MessageTracker(d.events);
    this.background = d.background ?? new BackgroundTracker(d.events);
    slashNoted = (sessionId) => {
      const session = this.d.registry.get(sessionId);
      const path = session ? (transcriptPathFor(session) ?? session.transcript) : null;
      if (path) this.localCommands.open(sessionId, path);
    };
  }

  /** A status line refresh (usage-left): keeps what is left of the limits and tells the phones when it changed. */
  statusLine(payload: Record<string, unknown>): void {
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string") return;
    const known = this.d.registry.get(sessionId);
    if (!known || known.status === "ended") return;
    this.scanCommands(sessionId);
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
    if (this.d.handover?.fromLeftCopy(sessionId, envelope.env)) return NO_OUTPUT;
    if (this.d.registry.fromStoppedProcess(sessionId, envelope.env.claudePid, event)) return NO_OUTPUT;
    if (event === "SessionStart" && str("source") === "resume")
      await this.d.handover?.resumed(sessionId, envelope.env);
    // The touch below wakes an ended session; a SessionEnd that follows a stop or an earlier end keeps that reason.
    const endedBefore = event === "SessionEnd" ? this.d.registry.get(sessionId) : undefined;
    const { session, created } = this.d.registry.touch(sessionId, {
      cwd: str("cwd"),
      transcript: str("transcript_path"),
      env: envelope.env,
      name: str("session_title") ?? null,
      keepSuccessor: event === "SessionEnd",
    });
    if (event === "SessionStart") this.linkSuccessor(sessionId, str("source"), envelope.env);
    // The permission mode rides on every hook: the phone can be told beforehand that replies need approval.
    const modeChanged = notePermissionMode(sessionId, p.permission_mode);
    if (created || modeChanged) this.d.registry.publish(sessionId);
    // A session that started before the helper did: its model is in the transcript, read once per prompt or stop
    // (the status change that follows publishes it).
    if ((event === "UserPromptSubmit" || event === "Stop") && !sessionModels.has(sessionId))
      sessionModels.setModel(sessionId, modelFromTranscript(session.transcript ?? str("transcript_path")));

    this.scanCommands(sessionId, session.transcript ?? str("transcript_path") ?? null, session.cwd);
    if (event === "UserPromptSubmit" || event === "PreCompact") this.flushCommands(sessionId, session.cwd);

    if (this.d.dialogs) {
      if (event === "Notification") {
        const type = str("notification_type");
        if (type && HOOK_DIALOGS.has(type)) this.d.dialogs.fromHook(sessionId, type, str("message"));
        else if (type === "elicitation_complete" || type === "elicitation_response")
          this.d.dialogs.hookCleared(sessionId);
      } else if (["UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"].includes(event)) {
        this.d.dialogs.hookCleared(sessionId);
      }
    }

    switch (event) {
      case "SessionStart": {
        sessionModels.setModel(sessionId, p.model);
        // Compacted or cleared: the context has room again.
        const source = str("source");
        if (source === "compact" || source === "clear") noteContextFull(sessionId, false);
        if (source === "compact") this.steps.waitEnded(sessionId);
        // The turn a `/compact` started ends here: compacting writes no answer and fires no Stop.
        let compacting = source === "compact" ? this.compacting.get(sessionId) : undefined;
        this.compacting.delete(sessionId);
        // Settings from before the PreCompact hook: the phone's `/compact` still gets its turn, at the end.
        const typed =
          source === "compact" && !compacting && !this.openTurn(sessionId)
            ? (phoneTyped.get(sessionId) ?? []).findLast((e) => /^\/compact(\s|$)/.test(e.text))
            : undefined;
        if (typed) {
          removeTyped(sessionId, typed);
          compacting = this.beginTurn(sessionId, typed.text, null, session.cwd, [], typed.sendId);
        }
        const open = compacting ? this.openTurn(sessionId) : null;
        if (open && open.id === compacting) {
          const turn = this.finishTurn(sessionId, open, COMPACTED, false, null, session.cwd);
          this.d.registry.setStatus(sessionId, "idle", { lastSummary: turn.summary });
          return NO_OUTPUT;
        }
        this.d.registry.publish(sessionId);
        return NO_OUTPUT;
      }

      // `/compact`, from the phone or at the Mac: a slash command submits no prompt, so its turn starts here and
      // the phone's message counts as started. Compacting by itself in the middle of a turn is part of that turn.
      case "PreCompact": {
        if (str("trigger") !== "manual") {
          // Compacting by itself ends with SessionStart `compact`, or the turn's next tool.
          if (this.openTurn(sessionId)) this.steps.waitStarted(sessionId, COMPACTING_LABEL);
          return NO_OUTPUT;
        }
        // A Stop still being recorded ends its turn first.
        for (let i = 0; i < 30 && this.stopping.has(sessionId); i++) await Bun.sleep(100);
        const running = this.openTurn(sessionId);
        if (running) {
          // Claude Code fires no Stop for a prompt that didn't fit the context, so its turn is still open when the
          // person compacts: it ends here, saying why. Any other open turn is left alone.
          const transcript = session.transcript ?? str("transcript_path") ?? null;
          if (!transcript || !running.started_at || !endedContextFull(transcript, running.started_at))
            return NO_OUTPUT;
          noteContextFull(sessionId, true);
          this.finishTurn(sessionId, running, CONTEXT_FULL, true, transcript, session.cwd);
        }
        const instructions = (str("custom_instructions") ?? "").trim();
        const prompt = instructions ? `/compact ${instructions}` : "/compact";
        const typed = (phoneTyped.get(sessionId) ?? []).findLast((e) => matchesPhoneTyped(e, prompt));
        if (typed) removeTyped(sessionId, typed);
        else if (!this.d.registry.ownedByHelper(sessionId)) this.d.presence.noteLocalActivity();
        this.d.suggestions?.clear(sessionId);
        this.d.held?.seen(sessionId, prompt);
        const turnId = this.beginTurn(sessionId, prompt, null, session.cwd, [], typed?.sendId);
        this.compacting.set(sessionId, turnId);
        this.d.registry.setStatus(sessionId, "working");
        // Compacting can fail (it needs room itself) and nothing says so: the turn isn't left running for ever.
        const giveUp = setTimeout(() => {
          if (this.compacting.get(sessionId) !== turnId) return;
          this.compacting.delete(sessionId);
          const open = this.openTurn(sessionId);
          if (open?.id !== turnId) return;
          const turn = this.finishTurn(sessionId, open, COMPACT_FAILED, true, null, session.cwd);
          this.d.registry.setStatus(sessionId, "idle", { lastSummary: turn.summary });
        }, this.compactGiveUpMs);
        giveUp.unref?.();
        return NO_OUTPUT;
      }

      // The model changed (from the phone's `/model` or at the Mac): the new one is the one Claude Code reports.
      case "PostModelSwitch":
        if (sessionModels.setModel(sessionId, p.to_model)) this.d.registry.publish(sessionId);
        return NO_OUTPUT;

      case "UserPromptSubmit": {
        // IDE context blocks are for Claude, not the phone. System messages start a turn but nobody typed them.
        const raw = withoutIdeContext(str("prompt") ?? "");
        const system = isSystemMessage(raw);
        // Only a real submit empties the input box; a notice leaves the typed draft where it was.
        if (!system) {
          notePromptSubmitted(sessionId);
          draftSubmitted(sessionId, raw);
          forgetSuggestionKnown(sessionId);
          clearLeftUnsent(sessionId);
        }
        // A new turn: the suggestion shown for the last one is gone (the status change below publishes that).
        this.d.suggestions?.clear(sessionId);
        // A background task finished: Claude Code tells the session with a notification (background-work).
        if (system) this.background.notified(sessionId, raw);
        const prompt = system ? "" : raw;
        // A message posted to the inbox arrived: it isn't held at the Mac.
        this.d.held?.seen(sessionId, raw);
        this.d.broker.settleFromSessionEvent(sessionId, { hookEventName: event });
        // A notice while the turn is still running (no Stop yet) is part of that turn, not a new one: closing the
        // turn here would leave it without its answer and put the answer on a turn without a prompt.
        if (system && !this.stopping.has(sessionId) && this.openTurn(sessionId)) {
          this.heldNotice.set(sessionId, Date.now());
          return NO_OUTPUT;
        }
        // A session the helper runs has no keyboard: every prompt is the phone's, and several can be waiting.
        const owned = this.d.registry.ownedByHelper(sessionId);
        const waiting = phoneTyped.get(sessionId) ?? [];
        const typed = owned
          ? (waiting.find((e) => matchesPhoneTyped(e, prompt)) ?? waiting.find((e) => e.delivering))
          : waiting.at(-1);
        // Whether this prompt is what the phone typed: the photo goes with it however late Claude Code reports it
        // (an unsent message the person submits at the Mac later). Only a recent one counts as the phone's own
        // typing for presence.
        const age = typed ? Date.now() - typed.at : 0;
        // Still being delivered: its age isn't known yet, so it counts as just typed.
        const late = typed !== undefined && !typed.delivering && age >= 15_000;
        const matched =
          typed !== undefined &&
          age < PHONE_TYPED_KEEP_MS &&
          matchesPhoneTyped(typed, prompt) &&
          // How strict the match is depends on how long ago the phone typed, delivered or not: a Mac prompt
          // long after must not take the photo with a bare substring match.
          (Date.now() - typed.notedAt < 15_000 || matchesLatePhoneTyped(typed, prompt));
        let fromPhone = matched && typed !== undefined && !late;
        // The files the phone typed with this message: the prompt only says "[Image #N]" for them.
        let typedPaths: string[] = [];
        let typedSendId: string | undefined;
        // Another prompt after the presence window: the typed message was dropped or replaced, so its photo is not
        // waiting for a later prompt.
        if (!system && typed && !matched && late) removeTyped(sessionId, typed);
        if (matched && typed) {
          removeTyped(sessionId, typed);
          typedPaths = typed.paths;
          typedSendId = typed.sendId;
        } else if (!system) {
          const launched = takePhoneLaunch(str("cwd") ?? session.cwd, prompt);
          if (launched) {
            fromPhone = true;
            typedPaths = launched;
          }
        }
        // The stop message the helper sent through the inbox: it cut the old turn off, which ends as stopped.
        const inboxStop = this.d.stopper?.takeInboxStop(sessionId, prompt) ?? null;
        if (!fromPhone && !inboxStop && !system && !owned) this.d.presence.noteLocalActivity();
        this.beginTurn(
          sessionId,
          prompt,
          session.transcript ?? str("transcript_path") ?? null,
          session.cwd,
          attachmentIdsAtPaths(this.d.db, sessionId, typedPaths),
          typedSendId,
        );
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

      case "Elicitation":
        return this.elicitation(p as unknown as ElicitationInput, signal);

      case "PreToolUse": {
        const call = toolCall(p, session.cwd);
        this.steps.toolStarted(sessionId, call);
        this.d.suggestions?.duringTurn(sessionId);
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
        this.d.suggestions?.duringTurn(sessionId);
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
          this.d.suggestions?.turnEnded(sessionId);
          return NO_OUTPUT;
        }
        const stopAt = Date.now();
        this.stopping.set(sessionId, stopAt);
        try {
          const failed = event === "StopFailure";
          const said = str("last_assistant_message") ?? "";
          // The turn didn't fit the context: say that, and what helps, in place of Claude Code's error text. Any
          // turn that ends well afterwards means there is room again.
          const contextFull = isContextFullError(
            failed ? (str("error") ?? "unknown") : undefined,
            said,
            str("error_details") ?? "",
          );
          const text = contextFull ? CONTEXT_FULL : said;
          const line = contextFull
            ? text
            : failed
              ? failureLine(str("error"), str("error_details") || said, usageOf(sessionId))
              : said;
          if (contextFull || !failed) noteContextFull(sessionId, contextFull);
          // The turn this Stop ends, taken before the wait: hooks are async, so a prompt queued at the computer
          // can start the next turn meanwhile, and that one isn't finished by this Stop.
          const picked = this.openTurn(sessionId);
          const transcript = session.transcript ?? str("transcript_path") ?? null;
          // Text typed since the last tool hook is a draft; the suggestion is drawn only once the turn is over.
          await this.d.suggestions?.beforeStop(sessionId);
          // The transcript is flushed asynchronously; give it a moment before reading stats.
          await Bun.sleep(400);
          await this.messages.outputsRead(sessionId);
          const ending = this.stopOwner(sessionId, picked, text, transcript, session.cwd);
          const turn = this.finishTurn(sessionId, ending, text, failed, transcript, session.cwd, line);
          // Idle even with background shells still running (a dev server): the prompt waits for you. One finishing
          // starts a turn of its own.
          const next = this.openTurn(sessionId);
          this.d.registry.setStatus(sessionId, next && next.id !== turn.id ? "working" : "idle", {
            lastSummary: turn.summary,
          });
          if (!(next && next.id !== turn.id)) this.d.suggestions?.turnEnded(sessionId);
          if (failed && !contextFull)
            this.d.events.emit({
              type: "session.notice",
              sessionId,
              level: "error",
              text: head(line, 500),
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
        if (
          type &&
          type !== "permission_prompt" &&
          type !== "auth_success" &&
          !(this.d.dialogs && HOOK_DIALOGS.has(type))
        ) {
          const words = noticeFor(type);
          this.d.events.emit({
            type: "session.notice",
            sessionId,
            level:
              words?.level ?? (type === "idle_prompt" || type === "agent_needs_input" ? "attention" : "info"),
            text: words?.text ?? head(redact(str("message") ?? type), 500),
          });
        }
        return NO_OUTPUT;
      }

      case "SessionEnd":
        if (endedBefore?.status !== "ended") this.settlePhoneSends(sessionId, str("reason"), session.cwd);
        this.d.broker.settleFromSessionEvent(sessionId, { hookEventName: event });
        this.background.clear(sessionId);
        this.steps.clear(sessionId);
        this.messages.clear(sessionId);
        forgetUsage(sessionId);
        this.d.suggestions?.clear(sessionId);
        this.d.registry.setStatus(sessionId, "ended", {
          endReason:
            endedBefore?.status === "ended" && endedBefore.endReason
              ? (endedBefore.endReason as EndReason)
              : endReasonOf(str("reason")),
        });
        sessionModels.forget(sessionId);
        if (endedBefore?.status !== "ended") this.noteEndedForLink(sessionId, str("reason"), envelope.env);
        return NO_OUTPUT;

      default:
        return NO_OUTPUT;
    }
  }

  /** The phone's `/exit` or `/clear` answers as a command turn before the session ends; any other send still pending is lost. */
  private settlePhoneSends(sessionId: string, reason: string | undefined, cwd: string | null): void {
    const all = phoneTyped.get(sessionId) ?? [];
    const pending = all.filter((e) => !e.delivering);
    const ending =
      reason === "prompt_input_exit"
        ? /^\/(exit|quit)(\s|$)/
        : reason === "clear"
          ? /^\/(clear|reset|new)(\s|$)/
          : null;
    const typed = ending ? all.findLast((e) => ending.test(e.text)) : undefined;
    if (ending && (reason === "clear" || typed)) {
      const line = typed ? squash(typed.text) : reason === "clear" ? "/clear" : "/exit";
      const name = line.slice(1).split(" ")[0] ?? "";
      const turnId = this.beginTurn(sessionId, line, null, cwd, [], typed?.sendId);
      const open = this.openTurn(sessionId);
      if (open && open.id === turnId)
        this.finishTurn(sessionId, open, reason === "clear" ? CLEARED : QUIT, false, null, cwd, undefined, {
          name,
        });
      if (typed) removeTyped(sessionId, typed);
    }
    for (const e of pending) {
      if (e === typed || !e.sendId) continue;
      this.d.events.emit({
        type: "reply.outcome",
        sessionId,
        sendId: e.sendId,
        outcome: "lost",
        text: LOST_TEXT,
      });
    }
    // A message still being typed may land in the new chat; its own send reports it.
    const still = all.filter((e) => e.delivering && e !== typed);
    if (still.length > 0) phoneTyped.set(sessionId, still);
    else phoneTyped.delete(sessionId);
  }

  private noteEndedForLink(id: string, reason: string | undefined, env: HookEnv): void {
    if (reason !== "clear" && reason !== "resume") return;
    if (!env.claudePid) return;
    const now = Date.now();
    for (const [k, v] of this.endedForLink) if (now - v.at > LINK_WINDOW_MS) this.endedForLink.delete(k);
    this.endedForLink.set(id, { at: now, pid: env.claudePid, ...terminalOf(env) });
  }

  /** The new chat of a /clear or /resume joins the one that just ended in the same process and terminal. */
  private linkSuccessor(id: string, source: string | undefined, env: HookEnv): void {
    if ((source !== "clear" && source !== "resume") || !env.claudePid) return;
    const now = Date.now();
    const here = terminalOf(env);
    const match = [...this.endedForLink].filter(
      ([oldId, v]) =>
        oldId !== id &&
        now - v.at <= LINK_WINDOW_MS &&
        v.pid === env.claudePid &&
        (v.pty || here.pty ? v.pty === here.pty : v.tmux === here.tmux),
    );
    const only = match.length === 1 ? match[0] : undefined;
    if (!only) return;
    this.endedForLink.delete(only[0]);
    this.d.registry.link(only[0], id);
  }

  /** After a restart: follows the turns the database still has open, so a running turn keeps its steps and messages. */
  resumeOpenTurns(): number {
    const rows = this.d.db
      .query<{ id: string; turn_id: string }, []>(
        `SELECT t.session_id AS id, t.id AS turn_id FROM turns t
         WHERE t.ended_at IS NULL
           AND t.started_at = (SELECT MAX(started_at) FROM turns WHERE session_id = t.session_id)`,
      )
      .all();
    let armed = 0;
    for (const row of rows) {
      const session = this.d.registry.get(row.id);
      if (!session || (session.status !== "working" && session.status !== "waiting")) continue;
      const startedAt =
        this.d.db
          .query<{ started_at: number | null }, [string]>("SELECT started_at FROM turns WHERE id = ?")
          .get(row.turn_id)?.started_at ?? Date.now();
      this.steps.turnStarted(row.id, row.turn_id);
      this.messages.turnStarted(
        row.id,
        row.turn_id,
        transcriptPathFor(session),
        startedAt,
        session.cwd,
        true,
      );
      armed++;
    }
    return armed;
  }

  /** A permission request that doesn't come from a hook (a process the helper owns): the same prompt and status. */
  openPrompt(input: PermissionRequestInput, signal: AbortSignal): Promise<HookReply> {
    return this.permissionRequest(input, signal);
  }

  /** An MCP server asks the person something: a one-field choice goes to the phone when you're away, the rest stays at the Mac. */
  private async elicitation(input: ElicitationInput, signal: AbortSignal): Promise<HookReply> {
    if (this.d.registry.ownedByHelper(input.session_id)) return NO_OUTPUT;
    const asked = elicitationQuestion(input);
    if (!asked) {
      const type = input.mode === "url" ? "elicitation_url_dialog" : "elicitation_dialog";
      const text = input.mode === "url" ? input.message : (input.message ?? input.mcp_server_name);
      this.d.dialogs?.fromHook(input.session_id, type, text);
      return NO_OUTPUT;
    }
    // Claude Code waits for this hook before it draws its dialog, and draws it only when the hook prints nothing.
    if (this.d.presence.get().present) return NO_OUTPUT;
    const { prompt, reply } = this.d.broker.openElicitation(input.session_id, asked.question, asked.ask);
    this.d.registry.setStatus(input.session_id, "waiting");
    log.info("prompt opened", { promptId: prompt.id, kind: prompt.kind, tool: "Elicitation" });
    const aborted = new Promise<HookReply>((resolve) =>
      signal.addEventListener("abort", () => {
        this.d.broker.close(prompt.id, "mac");
        resolve(NO_OUTPUT);
      }),
    );
    return Promise.race([reply, aborted]);
  }

  private async permissionRequest(input: PermissionRequestInput, signal: AbortSignal): Promise<HookReply> {
    const { prompt, reply } = this.d.broker.open(input);
    this.d.registry.setStatus(input.session_id, "waiting");
    log.info("prompt opened", { promptId: prompt.id, kind: prompt.kind, tool: input.tool_name });
    // The hook ends when the dialog is answered in the terminal; nothing else follows a No or Esc, so close it here.
    // PreToolUse(dN) comes right before PermissionRequest(dN): tie the prompt to its tool.
    // A subagent's tools never reach the step tracker, so its prompt isn't tracked either.
    const agentId = (input as unknown as Record<string, unknown>).agent_id;
    const toolId =
      typeof agentId === "string" && agentId
        ? null
        : this.steps.promptOpened(
            input.session_id,
            input.tool_name,
            input.tool_input as Record<string, unknown> | undefined,
            this.d.registry.get(input.session_id)?.cwd ?? null,
          );
    // A phone Allow marks nothing: the tool runs and its end hook follows. A phone Deny (or plan changes)
    // is the same as a terminal No: the tool never runs, so mark it and let the next tool replace it.
    let answered = false;
    void reply.then((r) => {
      answered = true;
      if (isDenyReply(r)) this.steps.toolDenied(input.session_id, toolId);
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

  /** Whether a phone send starting with a slash is still waiting for Claude Code to answer it. */
  pendingSlashSessions(): string[] {
    const now = Date.now();
    const ids = new Set<string>();
    for (const [id, list] of phoneTyped) if (list.some((e) => now - e.notedAt < SLASH_WATCH_MS)) ids.add(id);
    // The helper's own hook drops the phone's entry while another hook may still block the prompt.
    for (const send of this.turnSends.values())
      if (now - send.at < SLASH_WATCH_MS && this.openTurn(send.sessionId)) ids.add(send.sessionId);
    return [...ids];
  }

  /** Looks for local slash commands the session's transcript gained since the last look. */
  scanCommands(sessionId: string, transcript?: string | null, cwd?: string | null): void {
    const session = this.d.registry.get(sessionId);
    if (!session || session.status === "ended") return;
    const path = transcript ?? transcriptPathFor(session);
    if (!path) return;
    const inTurn = !!this.openTurn(sessionId) || this.stopping.has(sessionId);
    const found = this.localCommands.scan(sessionId, path, this.commandGraceMs, Date.now(), inTurn);
    for (const command of found) this.commandTurn(sessionId, command, cwd ?? session.cwd);
    for (const trace of this.localCommands.takeTraces(sessionId))
      this.hookTrace(sessionId, trace, session.cwd);
  }

  /** A hook stopped a prompt, or failed: the phone's message gets its outcome, a failure an error notice. */
  private hookTrace(sessionId: string, trace: HookTrace, cwd: string | null): void {
    if (trace.kind === "error") {
      const seen = this.reportedHookErrors.get(sessionId) ?? new Set<string>();
      const key = `${trace.event}\n${trace.detail}`;
      if (seen.has(key)) return;
      seen.add(key);
      this.reportedHookErrors.set(sessionId, seen);
      const detail = oneLine(redact(trace.detail), 300);
      this.d.events.emit({
        type: "session.notice",
        sessionId,
        level: "error",
        text: `${trace.event} hook error${detail ? `: ${detail}` : ""}`,
      });
      return;
    }
    const text = `${BLOCKED_PREFIX}${trace.reason ? `: ${oneLine(redact(trace.reason), 500)}` : "."}`;
    const typed = (phoneTyped.get(sessionId) ?? []).findLast((e) => matchesPhoneTyped(e, trace.prompt));
    if (typed) removeTyped(sessionId, typed);
    // The helper's own hook can run before the blocking one: its turn never gets a Stop.
    const open = this.openTurn(sessionId);
    const started = open && open.prompt === redact(trace.prompt) ? open : null;
    const sendId = typed?.sendId ?? (started ? this.turnSends.get(started.id)?.sendId : undefined);
    if (started) {
      this.finishTurn(sessionId, started, text, true, null, cwd, undefined, { name: "blocked" });
      this.d.registry.setStatus(sessionId, "idle");
    }
    if (sendId) this.d.events.emit({ type: "reply.outcome", sessionId, sendId, outcome: "blocked", text });
  }

  /** A model turn is about to start: a command echo still held was a local command with no output. */
  private flushCommands(sessionId: string, cwd: string | null): void {
    for (const command of this.localCommands.flush(sessionId)) this.commandTurn(sessionId, command, cwd);
  }

  /** A command Claude Code ran without the model, outside a turn, is a turn of its own: started and done at once. */
  private commandTurn(sessionId: string, command: LocalCommand, cwd: string | null): void {
    // Inside a turn it stays one of that turn's steps.
    if (this.openTurn(sessionId) || this.stopping.has(sessionId)) return;
    const line = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    const typed = (phoneTyped.get(sessionId) ?? []).findLast((e) => squash(e.text) === squash(line));
    if (typed) removeTyped(sessionId, typed);
    else if (!this.d.registry.ownedByHelper(sessionId)) this.d.presence.noteLocalActivity();
    markShownAsTurn(...command.uuids);
    const printed = shownOutput(command.output ?? "").output;
    const turnId = this.beginTurn(sessionId, line, null, cwd, [], typed?.sendId);
    const open = this.openTurn(sessionId);
    if (!open || open.id !== turnId) return;
    const args = command.args ? redact(command.args) : "";
    this.finishTurn(sessionId, open, printed ?? `Ran ${line}`, false, null, cwd, undefined, {
      name: command.name,
      ...(args ? { args } : {}),
    });
  }

  /** Starts a turn and its live trackers (steps, messages, timeline). */
  private beginTurn(
    sessionId: string,
    prompt: string,
    transcript: string | null,
    cwd: string | null,
    attachmentIds: string[] = [],
    sendId?: string,
  ): string {
    const { turnId, startedAt } = this.startTurn(sessionId, prompt, attachmentIds, sendId);
    this.steps.turnStarted(sessionId, turnId);
    // The turn's own start time, so live and finished thinking lines are timed from the same moment.
    this.messages.turnStarted(sessionId, turnId, transcript, startedAt, cwd);
    return turnId;
  }

  private startTurn(
    sessionId: string,
    prompt: string,
    attachmentIds: string[],
    sendId?: string,
  ): { turnId: string; startedAt: number } {
    const now = Date.now();
    this.d.db
      .query("UPDATE turns SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL")
      .run(now, sessionId);
    const turnId = newId("t");
    const shown = redact(prompt);
    this.d.db
      .query("INSERT INTO turns (id, session_id, prompt, started_at) VALUES (?, ?, ?, ?)")
      .run(turnId, sessionId, shown, now);
    recordTurnAttachments(this.d.db, turnId, attachmentIds);
    for (const [id, send] of this.turnSends) if (send.sessionId === sessionId) this.turnSends.delete(id);
    this.reportedHookErrors.delete(sessionId);
    if (sendId) this.turnSends.set(turnId, { sessionId, sendId, at: now });
    // The phone shows the prompt at once, not only when the answer is done.
    this.d.events.emit({
      type: "turn.started",
      turnId,
      sessionId,
      prompt: shown,
      startedAt: now,
      ...attachmentFields(this.d.db, sessionId, shown, turnId),
      ...(sendId ? { sendId } : {}),
    });
    return { turnId, startedAt: now };
  }

  /** The turn a Stop ends: usually the open one, but a Stop after the next prompt's hook belongs to the turn before (told by the transcript). */
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
    // Prompts queued during an answer closed the earlier turn before this Stop. The answer goes to the newest turn
    // whose prompt precedes it in the transcript; later ones wait, or their answers land under the next message.
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
    // Only on positive evidence (the earlier turn's own last text, not interrupted); a lagging transcript keeps the open turn.
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
    shown?: string,
    command?: TurnCommand,
  ): Turn {
    const id = open?.id ?? newId("t");
    this.turnSends.delete(id);
    const full = redact(shown ?? rawText);
    // A command's output is already cut to its last lines: shown whole, not as an answer's preview.
    const { text: summary, truncated } = command
      ? { text: full, truncated: false }
      : compact(full, this.d.config.previewChars);
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
    if (command)
      this.d.db
        .query("INSERT OR REPLACE INTO turn_commands (turn_id, name, args) VALUES (?, ?, ?)")
        .run(id, command.name, command.args ?? null);
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
      ...(command ? { command } : {}),
      ...timeline,
      ...turnMessageFields(messages),
      ...attachmentFields(this.d.db, sessionId, open?.prompt, open?.id),
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

/** Whether a PermissionRequest reply denies the tool (a phone Deny, or plan changes sent back). */
function isDenyReply(reply: HookReply): boolean {
  try {
    const out = JSON.parse(reply.stdout) as { hookSpecificOutput?: { decision?: { behavior?: string } } };
    return out.hookSpecificOutput?.decision?.behavior === "deny";
  } catch {
    return false;
  }
}

/** Relay wire protocol shared by the Mac daemon and the iOS app (zod schemas); bump PROTOCOL_VERSION on any breaking change. */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Domain objects

export const SessionStatus = z.enum(["working", "idle", "waiting", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionKind = z.enum(["interactive", "background", "unknown"]);
export type SessionKind = z.infer<typeof SessionKind>;

/** One thing Claude did in a turn: `label` is live in `turn.step`, finished in `Turn.steps`; apps treat an unknown `kind` as "other". */
export const TurnStepKind = z.enum([
  "thinking",
  "read",
  "edit",
  "run",
  "search",
  "web",
  "agent",
  "todo",
  "question",
  "plan",
  "other",
]);
export type TurnStepKind = z.infer<typeof TurnStepKind>;

/** At most this many characters in a step's label (one line, redacted). */
export const TURN_STEP_LABEL_MAX = 80;
/** Storage guard in UTF-16 units (what zod's max counts); the helper also cuts a label to it between characters. */
export const TURN_STEP_LABEL_UNITS = 4000;
/** A finished turn keeps at most this many steps; `Turn.stepsMore` counts the rest. */
export const TURN_STEPS_MAX = 100;

/** At most this many characters in a step's detail (a command, a path); the apps show at most 12 lines of it. */
export const TURN_STEP_DETAIL_MAX = 2000;
/** Storage guard in UTF-16 units for a detail. */
export const TURN_STEP_DETAIL_UNITS = 40_000;
/** A finished turn keeps at most this many thinking lines (`Turn.thoughts`). */
export const TURN_THOUGHTS_MAX = 100;
/** At most this many `turn.action` items (actions and thinking lines) are sent live per turn. */
export const TURN_ACTIONS_LIVE_MAX = 200;

/** An agent's step list in `children` keeps at most this many steps (agent-progress); `childrenMore` counts the rest. */
export const TURN_STEP_CHILDREN_MAX = 50;

const TurnStepBase = z.object({
  kind: TurnStepKind,
  /** At most TURN_STEP_LABEL_MAX characters as people see them (graphemes, as for session names). */
  label: z
    .string()
    .max(TURN_STEP_LABEL_UNITS)
    .refine((l) => sessionNameLength(l) <= TURN_STEP_LABEL_MAX, `at most ${TURN_STEP_LABEL_MAX} characters`),
  /** When the step started (epoch ms). */
  at: z.number(),
  /** The tool call failed. In a finished turn's steps, and in `turn.action` (turn-timeline). */
  failed: z.boolean().optional(),
  // turn-timeline: what the phones show for each action and thinking line.
  /** The tool call's `tool_use_id`, or the thinking entry's uuid: the same live and in the finished turn. */
  id: z.string().optional(),
  /** The tool's name as people see it ("Bash", "Read", an MCP tool's own name). */
  tool: z.string().optional(),
  /** The tool's own short description when Claude wrote one (Bash, Agent): redacted, one line. */
  title: z
    .string()
    .max(TURN_STEP_LABEL_UNITS)
    .refine((t) => sessionNameLength(t) <= TURN_STEP_LABEL_MAX, `at most ${TURN_STEP_LABEL_MAX} characters`)
    .optional(),
  /** The command, file path, pattern, site or agent description: redacted; may have line breaks. */
  detail: z
    .string()
    .max(TURN_STEP_DETAIL_UNITS)
    .refine((t) => graphemes(t).length <= TURN_STEP_DETAIL_MAX, `at most ${TURN_STEP_DETAIL_MAX} characters`)
    .optional(),
  /** How long a thinking line took, or an agent ran (ms). */
  durationMs: z.number().nonnegative().optional(),
  // agent-progress: an agent's or workflow's step. Older phones ignore these.
  /** The agent is still running: its label is in the live form ("Running an agent: …"), not "Ran …". */
  running: z.boolean().optional(),
  /** A workflow's agent line: "running", "done" or "failed". */
  state: z.string().max(40).optional(),
});

/** One step; an agent's or workflow's also carries progress (`children`, at most TURN_STEP_CHILDREN_MAX, without details). */
export const TurnStep = TurnStepBase.extend({
  /** How many steps the agent has taken so far (all of them, also those beyond `children`). */
  stepCount: z.number().int().nonnegative().optional(),
  /** The agent's current step, in the live form ("Reading lib.ts"); only while it runs. */
  current: z
    .string()
    .max(TURN_STEP_LABEL_UNITS)
    .refine((l) => sessionNameLength(l) <= TURN_STEP_LABEL_MAX, `at most ${TURN_STEP_LABEL_MAX} characters`)
    .optional(),
  children: z.array(TurnStepBase).max(TURN_STEP_CHILDREN_MAX).optional(),
  /** How many of the agent's steps (or a workflow's agents) were left out over TURN_STEP_CHILDREN_MAX. */
  childrenMore: z.number().int().positive().optional(),
});
export type TurnStep = z.infer<typeof TurnStep>;

/** Something Claude wrote between tool calls: Markdown, redacted, cut at TURN_MESSAGE_MAX; sent in `turn.message`. */
export const TURN_MESSAGE_MAX = 2000;
/** Storage guard in UTF-16 units; the helper also cuts a message to it, between characters. */
export const TURN_MESSAGE_UNITS = 40_000;
/** A turn keeps at most this many messages; `Turn.messagesMore` counts the rest. */
export const TURN_MESSAGES_MAX = 50;

export const TurnMessage = z.object({
  /** The transcript entry's uuid: the live event and the finished turn use the same id. */
  id: z.string(),
  /** At most TURN_MESSAGE_MAX characters as people see them, " …" included when cut. */
  text: z
    .string()
    .max(TURN_MESSAGE_UNITS)
    .refine((t) => graphemes(t).length <= TURN_MESSAGE_MAX, `at most ${TURN_MESSAGE_MAX} characters`),
  /** When Claude wrote it (epoch ms). */
  at: z.number(),
  /** The text was cut. Sent only when true. */
  truncated: z.boolean().optional(),
});
export type TurnMessage = z.infer<typeof TurnMessage>;

/** Something Claude left running after a turn (a shell or an agent); apps treat an unknown `kind` as "agent". */
export const BackgroundTask = z.object({
  id: z.string(),
  kind: z.string(),
  /** The task's description, else the command's first words: redacted, one line, at most 80 characters. */
  title: z
    .string()
    .max(TURN_STEP_LABEL_UNITS)
    .refine((t) => sessionNameLength(t) <= TURN_STEP_LABEL_MAX, `at most ${TURN_STEP_LABEL_MAX} characters`),
  /** A shell's command: redacted, at most TURN_STEP_DETAIL_MAX characters. */
  detail: z
    .string()
    .max(TURN_STEP_DETAIL_UNITS)
    .refine((t) => graphemes(t).length <= TURN_STEP_DETAIL_MAX, `at most ${TURN_STEP_DETAIL_MAX} characters`)
    .optional(),
  /** An agent's type ("general-purpose"). */
  agentType: z.string().optional(),
  /** When the helper first saw it (epoch ms). */
  startedAt: z.number(),
  /** An agent's newest tool call, in the live form ("Running sleep 15"). */
  activity: TurnStep.optional(),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

// Attachments: photos and files sent from a phone reach Claude as file paths.

/** At most this many attachments in one message (`session.send`). */
export const ATTACHMENTS_MAX = 10;
/** At most this many bytes in one attachment: 50 MB. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
/** Bytes in one chunk or `attachment.get` reply; as base64 JSON it fits one relay frame (256 KiB, cloud/src/index.ts). */
export const ATTACHMENT_CHUNK_BYTES = 128 * 1024;
/** How long an unfinished upload is kept (ms). */
export const ATTACHMENT_UPLOAD_TTL_MS = 60 * 60_000;
/** How long a saved attachment is kept on the computer (ms). */
export const ATTACHMENT_KEEP_MS = 7 * 86_400_000;

/** An attachment saved on the computer; `path` is as typed into the session (unquoted), so an app can show a chip. */
export const AttachmentRef = z.object({
  id: z.string(),
  /** The file name the phone sent ("IMG_1234.HEIC"), without the helper's id prefix. */
  name: z.string(),
  /** MIME type as the phone sent it ("image/jpeg"); "application/octet-stream" when unknown. */
  mime: z.string(),
  /** Bytes. */
  size: z.number().int().nonnegative(),
  path: z.string(),
  /** The file was removed from the computer (after 7 days): `attachment.get` can't fetch it. Sent only when true. */
  removed: z.boolean().optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** `attachment.begin`'s result: send `chunks` chunks of `chunkSize` bytes (the last one shorter). */
export const AttachmentUpload = z.object({
  id: z.string(),
  chunkSize: z.number().int().positive(),
  chunks: z.number().int().nonnegative(),
});
export type AttachmentUpload = z.infer<typeof AttachmentUpload>;

/** `attachment.chunk`'s result: how many different chunks of the upload arrived so far. */
export const AttachmentChunkAck = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
});
export type AttachmentChunkAck = z.infer<typeof AttachmentChunkAck>;

/** `attachment.get`'s result: chunk `index` (base64), or with `thumbnail` a small JPEG; `size` and `sha256` describe what is fetched. */
export const AttachmentData = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  chunkSize: z.number().int().positive(),
  chunks: z.number().int().positive(),
  index: z.number().int().nonnegative(),
  data: z.string(),
  thumbnail: z.boolean().optional(),
});
export type AttachmentData = z.infer<typeof AttachmentData>;

/** `attachment.discard`'s result; `discarded` is false for an unknown or already removed id, which is not an error. */
export const AttachmentDiscarded = z.object({
  id: z.string(),
  discarded: z.boolean(),
});
export type AttachmentDiscarded = z.infer<typeof AttachmentDiscarded>;

/** `session.send`'s result: how it went in (`tmux`, `iterm`, `pty`, `socket`, ...) or `queued`; `repeat` (only true): this `sendId` was delivered already. */
export const SendResult = z.object({
  via: z.string(),
  repeat: z.literal(true).optional(),
  /** With `via: "queued"`: why it waits. Older helpers leave it out, and the phone then says the Mac is locked. */
  reason: z.enum(["locked", "typing", "draft"]).optional(),
  /** With `via: "socket"`: Claude Code holds the message for approval at the Mac (only true); `reply.held` events follow. */
  heldAtMac: z.literal(true).optional(),
});
export type SendResult = z.infer<typeof SendResult>;

/** `session.delivered`'s result: whether the helper has the message with this `sendId`, and how it went in. */
export const DeliveryCheck = z.object({
  delivered: z.boolean(),
  via: z.string().optional(),
});
export type DeliveryCheck = z.infer<typeof DeliveryCheck>;

/** At most this long, a `sendId` the phone may ask about or send again. */
export const SEND_ID_MAX = 100;

/** One of the plan's usage limits: how much of the window is used, and when it starts over. */
export const UsageLimit = z.object({
  /** Share of the window already used, 0 to 100. */
  usedPercent: z.number(),
  /** When the window resets, in ms since epoch. Absent when Claude Code doesn't say. */
  resetsAt: z.number().optional(),
});
export type UsageLimit = z.infer<typeof UsageLimit>;

/** What is left of the limits, from Claude Code's status line; every part is optional. */
export const Usage = z.object({
  /** Share of this session's context window still free, 0 to 100. */
  contextLeftPercent: z.number().optional(),
  /** The plan's 5-hour limit. */
  fiveHour: UsageLimit.optional(),
  /** The plan's weekly limit. */
  sevenDay: UsageLimit.optional(),
});
export type Usage = z.infer<typeof Usage>;

export const Session = z.object({
  id: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  project: z.string(),
  branch: z.string().nullable(),
  kind: SessionKind,
  status: SessionStatus,
  /** First prompt of the session, used as a human-readable title. */
  title: z.string().nullable(),
  terminal: z.string().nullable(),
  /** True when Relay can deliver free text into this session. */
  canReceive: z.boolean(),
  /** How a reply would arrive: "typed" as the person's own input or "labelled" (through the inbox); absent on older helpers. */
  replyRoute: z.enum(["typed", "labelled"]).optional(),
  /** With "labelled": what would make replies arrive typed ("accessibility"); absent when nothing the person can switch on helps. */
  replyFix: z.enum(["accessibility"]).optional(),
  /** True only while the session runs in a Claude Code process the helper started (`session.resume`); replies go to it. */
  runsInHelper: z.literal(true).optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  lastSummary: z.string().nullable(),
  /** Only when renamed from a phone (`session.rename`): what `name` would be without it; `name` then holds the phone's name. */
  originalName: z.string().nullable().optional(),
  /** When the session was pinned (`session.pin`), in ms since epoch; present only when pinned, newest pin first. */
  pinnedAt: z.number().nullable().optional(),
  /** What Claude is doing right now (live form), while the session works; absent otherwise. */
  step: TurnStep.nullable().optional(),
  /** Shells and agents still running in the background (background-work); absent when none. */
  background: z.array(BackgroundTask).optional(),
  /** The model the session runs, as people read it ("Fable 5.2"); absent when the helper doesn't know. */
  model: z.string().optional(),
  /** The session's effort level ("medium"), when known; absent otherwise. */
  effort: z.string().optional(),
  /** What is left of the plan limits and the session's context (usage-left); absent when the helper has none. */
  usage: Usage.optional(),
  /** The next message Claude Code suggests (one line, redacted), present only while idle and readable off the screen. */
  suggestion: z.string().optional(),
  /** Present (true) while a reply to this session waits for approval at the Mac (`reply.held`); absent otherwise. */
  heldAtMac: z.literal(true).optional(),
  /** Claude Code's permission mode from the last hook; a session that skips prompts may need approval at the Mac for inbox replies. */
  permissionMode: z.string().optional(),
});
export type Session = z.infer<typeof Session>;

/** A name given from a phone: one line, at most 60 characters as people see them (grapheme clusters, as Swift's String.count). */
export const SESSION_NAME_MAX = 60;
/** Storage guard for long emoji sequences; far above any 60-character name people type. */
const SESSION_NAME_MAX_UNITS = 1000;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;
/** Whitespace, separators and invisible format characters (zero-width space, word joiner, BOM…). */
const INVISIBLE = /^[\s\p{Z}\p{Cf}]*$/u;

export function sessionNameLength(name: string): number {
  return graphemes(name).length;
}

/** A text split into characters as people see them (grapheme clusters). */
export function graphemes(text: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
}

export const TurnStats = z.object({
  durationMs: z.number().nullable(),
  toolCalls: z.number(),
  filesEdited: z.array(z.string()),
});
export type TurnStats = z.infer<typeof TurnStats>;

export const Turn = z.object({
  id: z.string(),
  sessionId: z.string(),
  prompt: z.string().nullable(),
  /** Compact, redacted preview of the final assistant message (Markdown). */
  summary: z.string(),
  /** Length of the full (redacted) text; fetch it with `turn.full`. */
  fullLength: z.number(),
  truncated: z.boolean(),
  stats: TurnStats,
  failed: z.boolean(),
  startedAt: z.number().nullable(),
  endedAt: z.number(),
  /** True on a turn the user stopped (the phone's Stop, session.interrupt, or Esc); sent only when true; `failed` stays false. */
  stopped: z.boolean().optional(),
  /** The turn's tool calls, oldest first, in the finished form ("Read …"); at most TURN_STEPS_MAX. */
  steps: z.array(TurnStep).max(TURN_STEPS_MAX).optional(),
  /** How many steps were left out over TURN_STEPS_MAX. */
  stepsMore: z.number().int().positive().optional(),
  /** The turn's thinking lines ("Thought for 4s"), oldest first; apps merge them with steps and messages by `at`. */
  thoughts: z.array(TurnStep).max(TURN_THOUGHTS_MAX).optional(),
  /** What Claude wrote between tool calls, oldest first, without the final answer; at most TURN_MESSAGES_MAX. */
  messages: z.array(TurnMessage).max(TURN_MESSAGES_MAX).optional(),
  /** How many messages were left out over TURN_MESSAGES_MAX. */
  messagesMore: z.number().int().positive().optional(),
  /** Attachments whose paths are in `prompt`, in order; absent when none (`prompt` keeps the paths for older apps). */
  attachments: z.array(AttachmentRef).optional(),
});
export type Turn = z.infer<typeof Turn>;

/** How session.interrupt reached Claude ("message": asked, not stopped yet); apps treat any other value as a stop. */
export const InterruptVia = z.enum(["prompt", "pty", "tmux", "iterm", "inbox", "message", "headless"]);
export type InterruptVia = z.infer<typeof InterruptVia>;

export const InterruptResult = z.object({
  via: InterruptVia,
  /** The stopped turn, once the helper saw it end (within a few seconds); null otherwise. */
  turnId: z.string().nullable(),
  /** Present (true) when the stop message sits at the Mac waiting for approval: nothing has stopped yet. */
  heldAtMac: z.literal(true).optional(),
});
export type InterruptResult = z.infer<typeof InterruptResult>;

/** The model names the phone offers; Claude Code's `/model <name>` takes each of them. */
export const MODEL_ALIASES = [
  "default",
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
  "fable[1m]",
  "opus[1m]",
  "sonnet[1m]",
] as const;
export const ModelAlias = z.enum(MODEL_ALIASES);
export type ModelAlias = z.infer<typeof ModelAlias>;

/** The effort levels the phone offers; Claude Code's `/effort <level>` takes each of them. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export const EffortLevel = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevel>;

/** `session.model`'s result: the command that was typed. The new model shows in the session once Claude Code reports it. */
export const ModelResult = z.object({
  via: z.string(),
});
export type ModelResult = z.infer<typeof ModelResult>;

export const QuestionOption = z.object({ label: z.string(), description: z.string().optional() });
export const Question = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(QuestionOption),
  multiSelect: z.boolean().optional(),
});
export type Question = z.infer<typeof Question>;

export const PromptPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), questions: z.array(Question) }),
  z.object({ kind: z.literal("plan"), plan: z.string(), planFilePath: z.string().nullable() }),
  z.object({
    kind: z.literal("permission"),
    toolName: z.string(),
    /** Human-readable one-liner, e.g. the Bash command or the edited file path. */
    summary: z.string(),
    /** Redacted JSON of the tool input, for the detail view. */
    detail: z.string(),
    canAlwaysAllow: z.boolean(),
  }),
]);
export type PromptPayload = z.infer<typeof PromptPayload>;

export const PromptKind = z.enum(["question", "plan", "permission"]);
export type PromptKind = z.infer<typeof PromptKind>;

export const ResolvedBy = z.enum(["phone", "mac", "timeout", "superseded"]);
export type ResolvedBy = z.infer<typeof ResolvedBy>;

export const Prompt = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: PromptKind,
  payload: PromptPayload,
  status: z.enum(["open", "closed"]),
  resolvedBy: ResolvedBy.nullable(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
  /** What was decided, in a few words ("SwiftData", "Allowed", "Revised: add tests"); null while open or unknown. */
  outcome: z.string().nullable().optional(),
  /** True when a long text in `payload` was cut to fit the relay's limit (each cut ends "… (N more characters)"). */
  truncated: z.boolean().optional(),
});
export type Prompt = z.infer<typeof Prompt>;

export const Answer = z.discriminatedUnion("kind", [
  /** Maps each question's text to the chosen label(s) (multi-select joined with ", ") or free text. */
  z.object({
    kind: z.literal("question"),
    answers: z.record(z.string(), z.string()),
    /** Question text to the index of the option picked, since a notification button shows a cut title; older phones leave it out. */
    choices: z.record(z.string(), z.number().int().min(0)).optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    action: z.enum(["approve", "approve_accept_edits", "revise", "reject"]),
    feedback: z.string().optional(),
  }),
  z.object({
    kind: z.literal("permission"),
    action: z.enum(["allow", "allow_always", "deny"]),
    reason: z.string().optional(),
  }),
]);
export type Answer = z.infer<typeof Answer>;

/** The computer the phone is paired with, in the `pair` and `hello` replies; a missing `host` means a Mac. */
export const HostInfo = z.object({
  os: z.enum(["macos", "linux"]),
  /** "Ana's MacBook Pro", or the short hostname on Linux. May be empty. */
  name: z.string(),
  /** True only when the helper can find `claude` and so start a session from the phone (`session.start`). */
  canStartSessions: z.boolean().optional(),
});
export type HostInfo = z.infer<typeof HostInfo>;

/** One folder past sessions ran in, as `sessions.directories` lists them. */
export const SessionDirectory = z.object({
  /** Absolute path, the value `session.start` takes. */
  path: z.string(),
  /** The folder's project name (the repository's name, or the folder's own). */
  project: z.string(),
  /** When a session in this folder was last active, epoch ms. */
  lastUsedAt: z.number(),
});
export type SessionDirectory = z.infer<typeof SessionDirectory>;

/** `session.start`'s result: the new session's id, as it appears in `sessions.list`. */
export const SessionStarted = z.object({ sessionId: z.string() });
export type SessionStarted = z.infer<typeof SessionStarted>;

/** `session.resume`'s result: the message went to a Claude Code process the helper started (`via: "headless"`). */
export const SessionResumed = z.object({ via: z.literal("headless") });
export type SessionResumed = z.infer<typeof SessionResumed>;

export const PresenceMode = z.enum(["auto", "here", "away"]);
export type PresenceMode = z.infer<typeof PresenceMode>;

export const Presence = z.object({
  mode: PresenceMode,
  present: z.boolean(),
  idleSeconds: z.number(),
  locked: z.boolean(),
});
export type Presence = z.infer<typeof Presence>;

// Events (server -> client). Every event carries a monotonic `seq` so clients can resume with `sync`.

export const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.upsert"), session: Session }),
  z.object({ type: z.literal("session.removed"), sessionId: z.string() }),
  /** The session's whole background list, when it changes (an empty list: nothing runs). Never pushed. */
  z.object({ type: z.literal("session.background"), sessionId: z.string(), tasks: z.array(BackgroundTask) }),
  z.object({ type: z.literal("turn.done"), turn: Turn }),
  /** A turn began (a prompt typed on the Mac or sent from the phone): its prompt shows before the answer. */
  z.object({
    type: z.literal("turn.started"),
    turnId: z.string(),
    sessionId: z.string(),
    prompt: z.string(),
    startedAt: z.number(),
    /** Attachments whose paths are in `prompt`, as in `Turn.attachments`; absent when none. */
    attachments: z.array(AttachmentRef).optional(),
    /** The `sendId` of the phone message that started it, when it came from the phone and the helper knows; absent otherwise. */
    sendId: z.string().optional(),
  }),
  /** What Claude is doing now in a running turn (live form). At most one a second per session; never pushed. */
  z.object({ type: z.literal("turn.step"), sessionId: z.string(), turnId: z.string(), step: TurnStep }),
  /** Something Claude wrote between tool calls in a running turn, once per message, in order; never pushed. */
  /** An action or thinking line of a running turn, as the transcript shows it (turn-timeline); again when it failed. */
  z.object({ type: z.literal("turn.action"), sessionId: z.string(), turnId: z.string(), step: TurnStep }),
  z.object({
    type: z.literal("turn.message"),
    sessionId: z.string(),
    turnId: z.string(),
    message: TurnMessage,
  }),
  z.object({ type: z.literal("prompt.opened"), prompt: Prompt }),
  z.object({
    type: z.literal("prompt.closed"),
    promptId: z.string(),
    resolvedBy: ResolvedBy,
    outcome: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("presence.changed"), presence: Presence }),
  /** Why replies queued in a session wait (`locked`, `typing`, `draft`); null once nothing waits. Never pushed. */
  z.object({
    type: z.literal("reply.waiting"),
    sessionId: z.string(),
    reason: z.enum(["locked", "typing", "draft"]).nullable(),
  }),
  /** A reply held at the Mac is `waiting`, then `delivered` or `expired`; `stop` marks the phone's Stop. Never pushed. */
  z.object({
    type: z.literal("reply.held"),
    sessionId: z.string(),
    state: z.enum(["waiting", "delivered", "expired"]),
    stop: z.literal(true).optional(),
    /** The `sendId` of the message it is about, when the phone gave one; older helpers leave it out. */
    sendId: z.string().optional(),
  }),
  z.object({
    type: z.literal("session.notice"),
    sessionId: z.string(),
    level: z.enum(["info", "attention", "error"]),
    text: z.string(),
  }),
]);
export type EventBody = z.infer<typeof EventBody>;

export const RelayEvent = z.object({ seq: z.number(), ts: z.number() }).and(EventBody);
export type RelayEvent = { seq: number; ts: number } & EventBody;

// RPC (client -> server). WebSocket: {id, method, params} -> {id, result} | {id, error}; HTTPS: POST /rpc.

export const RpcSchemas = {
  sync: z.object({ sinceSeq: z.number().int().nonnegative().default(0) }),
  "sessions.list": z.object({ includeEnded: z.boolean().default(false) }),
  /** The folders past sessions ran in, most recent first, without ones that no longer exist. Older helpers: "unknown method". */
  "sessions.directories": z.object({}),
  /** Starts a background session in a `sessions.directories` folder with `text` as its first message. Result: SessionStarted. */
  "session.start": z.object({
    directory: z.string().min(1).max(4096),
    text: z.string().max(20_000),
  }),
  /** Continues a session with no live process (`claude --resume`); `conflict` if one runs. Result: SessionResumed. */
  "session.resume": z.object({
    sessionId: z.string(),
    text: z.string().min(1).max(20_000),
    /** Like `session.send`'s: `session.delivered` and a repeated `session.send` with it know this message, also while Claude Code is still starting. */
    sendId: z.string().min(1).max(SEND_ID_MAX).optional(),
  }),
  /** A session's finished turns, newest first; `before` pages back by the time the phone's oldest turn started. */
  "session.turns": z.object({
    sessionId: z.string(),
    limit: z.number().int().min(1).max(100).default(20),
    before: z.number().nonnegative().optional(),
  }),
  /** Types a message, then its `attachments` as paths; a repeated `sendId` returns the first result with `repeat: true`. Result: SendResult. */
  "session.send": z.object({
    sessionId: z.string(),
    text: z.string().max(20_000).default(""),
    attachments: z.array(z.string()).max(100).optional(),
    sendId: z.string().min(1).max(SEND_ID_MAX).optional(),
  }),
  /** Whether the message with this `sendId` reached the helper, asked before the phone says "Couldn't send". Result: DeliveryCheck. */
  "session.delivered": z.object({
    sessionId: z.string(),
    sendId: z.string().min(1).max(SEND_ID_MAX),
  }),
  /** Starts an upload (`sha256` is the hex digest); refused for an unknown or ended session, a file over ATTACHMENT_MAX_BYTES, or an unsafe name. */
  "attachment.begin": z.object({
    sessionId: z.string(),
    name: z.string().max(1000),
    mime: z.string().max(255).optional(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  }),
  /** One base64 chunk of ATTACHMENT_CHUNK_BYTES bytes; sending it again is harmless. Result: AttachmentChunkAck. */
  "attachment.chunk": z.object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 + 4),
  }),
  /** Finishes an upload: checks size and hash, saves the file (0600) under ~/.relay/attachments/<session>/. Result: AttachmentRef. */
  "attachment.end": z.object({ id: z.string() }),
  /** Removes an attachment before it is sent: an unfinished upload is dropped, a saved file deleted. Result: AttachmentDiscarded. */
  "attachment.discard": z.object({ id: z.string() }),
  /** Fetches a saved attachment: chunk `index` of it, or a small JPEG for an image with `thumbnail`. AttachmentData. */
  "attachment.get": z.object({
    id: z.string(),
    index: z.number().int().nonnegative().default(0),
    thumbnail: z.boolean().default(false),
  }),
  /** A name of the phone's own for the session; null or empty clears it. Only in Relay, never in Claude Code. */
  "session.rename": z.object({
    sessionId: z.string(),
    name: z
      .string()
      .trim()
      .max(SESSION_NAME_MAX_UNITS)
      .refine((n) => !LINE_BREAK.test(n), "one line only")
      .refine((n) => sessionNameLength(n) <= SESSION_NAME_MAX, `at most ${SESSION_NAME_MAX} characters`)
      // Nothing visible: the same as clearing it.
      .transform((n) => (INVISIBLE.test(n) ? null : n))
      .nullable(),
  }),
  /** Pin the session to the top of the Sessions list, or unpin it. Pinning a pinned session keeps its time. */
  "session.pin": z.object({ sessionId: z.string(), pinned: z.boolean() }),
  /** Stops Claude's current turn, as Esc does. Result: InterruptResult. Errors: not_found, conflict (nothing running), unavailable. */
  "session.interrupt": z.object({ sessionId: z.string() }),
  /** Switches the model or effort (exactly one) by typing `/model` or `/effort`, only when idle with an empty prompt. Result: ModelResult. */
  "session.model": z
    .object({ sessionId: z.string(), model: ModelAlias.optional(), effort: EffortLevel.optional() })
    .refine(
      (p) => (p.model === undefined) !== (p.effort === undefined),
      "give a model or an effort, not both",
    ),
  "prompt.answer": z.object({ promptId: z.string(), answer: Answer }),
  "prompts.open": z.object({}),
  /** Recently settled prompts, newest first: the Inbox history. */
  "prompts.recent": z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  /** A turn's full text in pieces under the relay's frame limit: `offset` (UTF-16 units, default 0) and the result's `more` / `nextOffset`. */
  "turn.full": z.object({ turnId: z.string(), offset: z.number().int().nonnegative().default(0) }),
  /** Liveness check; any reply proves the computer is there, an "unknown method" error from an older helper too. */
  ping: z.object({}),
  "presence.get": z.object({}),
  "presence.set": z.object({ mode: PresenceMode }),
  /** The device's push token: iOS sends an APNs token (`environment` "sandbox" for debug builds), Android `platform: "fcm"`. */
  "device.registerPush": z.union([
    z.object({
      platform: z.literal("apns").default("apns"),
      token: z.string().regex(/^[0-9a-f]{64,200}$/i),
      environment: z.enum(["sandbox", "production"]),
    }),
    z.object({
      platform: z.literal("fcm"),
      token: z.string().regex(/^[A-Za-z0-9:_-]{20,4096}$/),
      environment: z.enum(["sandbox", "production"]).default("production"),
    }),
  ]),
  "push.test": z.object({}),
  /** The calling phone's notification key (phones paired before keys existed fetch it once). */
  "push.key": z.object({}),
  /** The turn a session is working on right now, if any: {turnId, prompt, startedAt, step?} or null. */
  "session.live": z.object({ sessionId: z.string() }),
  /** Revokes the calling device (the phone's "Unpair"): its token stops working and it gets no more pushes. */
  "device.unpair": z.object({}),
} as const;
export type RpcMethod = keyof typeof RpcSchemas;

/** The relay closes a stream's link on a frame over this many bytes (cloud/src/index.ts MAX_FRAME). */
export const RELAY_FRAME_BYTES = 256 * 1024;
/** What one RPC result's data may take, so the reply (envelope, encryption, stream id) stays under the frame limit. */
export const REPLY_DATA_BYTES = 192 * 1024;

/** `turn.full`'s result; `more` and `nextOffset` are absent on the last piece. */
export const TurnFullResult = z.object({
  text: z.string(),
  more: z.boolean().optional(),
  nextOffset: z.number().int().optional(),
});
export type TurnFullResult = z.infer<typeof TurnFullResult>;

/** `sync`'s result; with `more` true, `latestSeq` is the last event sent and the phone syncs again from there. */
export const SyncResult = z.object({
  snapshot: z.object({ sessions: z.array(Session), prompts: z.array(Prompt), presence: Presence }).optional(),
  events: z.array(RelayEvent),
  latestSeq: z.number(),
  more: z.boolean().optional(),
});
export type SyncResult = z.infer<typeof SyncResult>;

export const RpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export interface RpcError {
  code: "bad_request" | "not_found" | "conflict" | "unauthorized" | "internal" | "unavailable";
  message: string;
  /** Only true: on a failed `session.send`, no live process exists but the conversation is on disk, so `session.resume` can continue it. */
  canResume?: true;
}

/** QR payload shown by `relay pair`: v1 = direct (Tailscale), v2 = through the Cloudflare relay. */
export const PairingPayload = z.discriminatedUnion("v", [
  z.object({
    v: z.literal(1),
    /** Base URL of the daemon as seen from the phone, e.g. https://mac.tailnet.ts.net */
    url: z.string(),
    code: z.string(),
  }),
  z.object({
    v: z.literal(2),
    /** wss:// URL of the Cloudflare relay */
    relay: z.string(),
    /** Room id: b64url(sha256(Mac's Ed25519 key))[0..22] */
    mac: z.string(),
    /** The Mac's static X25519 public key (b64url), anchors the end-to-end encryption */
    key: z.string(),
    code: z.string(),
  }),
]);
export type PairingPayload = z.infer<typeof PairingPayload>;

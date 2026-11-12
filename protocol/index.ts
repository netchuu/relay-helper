/**
 * Relay wire protocol, shared by the Mac daemon and the iOS app.
 *
 * This file is the single source of truth: Swift `Codable` types are generated from the JSON Schema
 * produced from these zod schemas (see `bun run gen:protocol`, Phase 2). Bump PROTOCOL_VERSION on any
 * breaking change.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------------------------------

export const SessionStatus = z.enum(["working", "idle", "waiting", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionKind = z.enum(["interactive", "background", "unknown"]);
export type SessionKind = z.infer<typeof SessionKind>;

/**
 * One thing Claude did in a turn. The helper writes `label` in the words the
 * phones show: the live form in `turn.step` and `Session.step` ("Reading protocol/index.ts"), the finished form
 * in `Turn.steps` ("Read protocol/index.ts"). Apps read `kind` as a plain string and treat one they don't know
 * as "other".
 */
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
/**
 * Storage guard in UTF-16 units (what zod's max counts). 80 of the longest emoji people use (a family with skin
 * tones is 19 units, a tag-sequence flag 14) stay well under it; the helper also cuts a label to it, between
 * characters, so one made of many combining marks per character still fits.
 */
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

/**
 * One step. An agent's (Agent/Task tool) or workflow's step also carries its progress: how many steps the agent
 * has taken, its current one (live), and its own steps (`children`, at most TURN_STEP_CHILDREN_MAX, without
 * details; for a workflow, one line per agent with its label and `state`). Sent live in `turn.action` by the same
 * `id` and kept in the finished turn.
 */
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

/**
 * Something Claude wrote between its tool calls in a turn: Markdown, redacted,
 * cut at TURN_MESSAGE_MAX characters. Sent live in `turn.message`; a finished turn keeps them in `Turn.messages`,
 * without its final answer (that stays `Turn.summary`).
 */
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

/**
 * Something Claude left running after a turn: a shell or an agent, from Claude
 * Code's own list at the end of each turn. Apps treat a `kind` they don't know as "agent".
 */
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

// ---------------------------------------------------------------------------------------------------
// Attachments: photos and files sent from a phone reach Claude as file paths.
// ---------------------------------------------------------------------------------------------------

/** At most this many attachments in one message (`session.send`). */
export const ATTACHMENTS_MAX = 10;
/** At most this many bytes in one attachment: 50 MB. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
/**
 * Bytes in one `attachment.chunk` and one `attachment.get` reply (the last chunk may be shorter). Base64 makes
 * it about 175 KB of JSON, which with the encryption fits in one relay frame (256 KiB, `cloud/src/index.ts`).
 */
export const ATTACHMENT_CHUNK_BYTES = 128 * 1024;
/** How long an unfinished upload is kept (ms). */
export const ATTACHMENT_UPLOAD_TTL_MS = 60 * 60_000;
/** How long a saved attachment is kept on the computer (ms). */
export const ATTACHMENT_KEEP_MS = 7 * 86_400_000;

/**
 * An attachment saved on the computer. `path` is the absolute path as it was typed into the session (without the
 * quotes added around a path with spaces), so an app can find it in a prompt and show a chip instead.
 */
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

/**
 * `attachment.get`'s result: chunk `index` of the file (base64), or with `thumbnail` a small JPEG of an image in
 * one chunk. `size` and `sha256` describe what is fetched (the file, or the thumbnail).
 */
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

/**
 * `attachment.discard`'s result. `discarded` is false when there was nothing to discard (an unknown id, or one
 * already removed), which is not an error: a phone may discard the same attachment twice.
 */
export const AttachmentDiscarded = z.object({
  id: z.string(),
  discarded: z.boolean(),
});
export type AttachmentDiscarded = z.infer<typeof AttachmentDiscarded>;

/**
 * `session.send`'s result: how the message went in (`tmux`, `iterm`, `pty`, `socket`, ...), or `queued` when it waits
 * for the Mac to be unlocked or for a pause in your typing and is typed then. `repeat`: this `sendId` was
 * delivered already, so nothing was typed again; `via` is what the first send answered. Sent only as true.
 * `reason` (optional, only with `queued`): `locked` (the Mac is locked), `typing` (someone is typing in that
 * terminal right now) or `draft` (unsent text in its prompt). Changes arrive as `reply.waiting` events.
 */
export const SendResult = z.object({
  via: z.string(),
  repeat: z.literal(true).optional(),
  /** With `via: "queued"`: why it waits. Older helpers leave it out, and the phone then says the Mac is locked. */
  reason: z.enum(["locked", "typing", "draft"]).optional(),
});
export type SendResult = z.infer<typeof SendResult>;

/**
 * `session.delivered`'s result: whether the helper has the message sent with this `sendId` (typed in, or
 * queued to be), and then how, as `session.send` answered. False: it never arrived, or its send failed, so Try Again
 * should send it.
 */
export const DeliveryCheck = z.object({
  delivered: z.boolean(),
  via: z.string().optional(),
});
export type DeliveryCheck = z.infer<typeof DeliveryCheck>;

/** At most this long, a `sendId` the phone may ask about or send again. */
export const SEND_ID_MAX = 100;

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
  /**
   * How a reply sent now would arrive: "typed" as the person's own input, or "labelled" (through Claude Code's
   * inbox, marked as from another session). Absent on older helpers, and when the session
   * can't take replies. Apps show a hint for "labelled".
   */
  replyRoute: z.enum(["typed", "labelled"]).optional(),
  /**
   * With replyRoute "labelled": what would make replies arrive typed. "accessibility" means the session is in the
   * Claude desktop app or an editor on a Mac where relay hasn't been allowed in Accessibility. Absent when nothing
   * the person can switch on helps (Terminal.app, Linux outside tmux…).
   */
  replyFix: z.enum(["accessibility"]).optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  lastSummary: z.string().nullable(),
  /**
   * Present only when the session was renamed from a phone (`session.rename`): what `name` would be without the
   * rename (Claude Code's name, or null). `name` then holds the phone's name, so older apps show it too.
   */
  originalName: z.string().nullable().optional(),
  /**
   * When the session was pinned to the top of the Sessions list (`session.pin`), in ms since epoch. Present only
   * when pinned; the apps list pinned sessions newest pin first. Older apps ignore it.
   */
  pinnedAt: z.number().nullable().optional(),
  /** What Claude is doing right now (live form), while the session works; absent otherwise. */
  step: TurnStep.nullable().optional(),
  /** Shells and agents still running in the background (background-work); absent when none. */
  background: z.array(BackgroundTask).optional(),
});
export type Session = z.infer<typeof Session>;

/**
 * A name given to a session from a phone: one line, at most 60 characters as people see them (grapheme
 * clusters: an emoji with a skin tone or an accented letter counts once, as Swift's String.count does; Android
 * counts with BreakIterator.getCharacterInstance). Line breaks of any kind are refused, and a name with nothing
 * visible in it clears the name.
 */
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
  /**
   * True on a turn the user stopped (the phone's Stop, session.interrupt, or Esc at the computer); sent only
   * when true. `failed` stays false on it.
   */
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
  /**
   * Attachments whose paths are in `prompt` (attachments), in the order they appear; absent when none. `prompt`
   * still has the paths, so older apps show them as text.
   */
  attachments: z.array(AttachmentRef).optional(),
});
export type Turn = z.infer<typeof Turn>;

/**
 * How session.interrupt reached Claude: "prompt" answered an open prompt with deny-and-interrupt; "pty",
 * "tmux", "iterm" pressed Esc in the terminal; "inbox" stopped it through Claude Code's inbox. "message": the
 * stop went through the inbox but didn't stop the turn (yet), so the phone says it asked Claude to stop.
 * Apps treat any other value as a stop, so later routes don't break them.
 */
export const InterruptVia = z.enum(["prompt", "pty", "tmux", "iterm", "inbox", "message"]);
export type InterruptVia = z.infer<typeof InterruptVia>;

export const InterruptResult = z.object({
  via: InterruptVia,
  /** The stopped turn, once the helper saw it end (within a few seconds); null otherwise. */
  turnId: z.string().nullable(),
});
export type InterruptResult = z.infer<typeof InterruptResult>;

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
});
export type Prompt = z.infer<typeof Prompt>;

export const Answer = z.discriminatedUnion("kind", [
  /** Maps each question's text to the chosen label(s) (multi-select joined with ", ") or free text. */
  z.object({ kind: z.literal("question"), answers: z.record(z.string(), z.string()) }),
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

/**
 * The computer the phone is paired with, sent in the `pair` and `hello` replies (and the direct `/pair`
 * response). Optional: apps treat a missing `host` as a Mac.
 */
export const HostInfo = z.object({
  os: z.enum(["macos", "linux"]),
  /** "Ana's MacBook Pro", or the short hostname on Linux. May be empty. */
  name: z.string(),
});
export type HostInfo = z.infer<typeof HostInfo>;

export const PresenceMode = z.enum(["auto", "here", "away"]);
export type PresenceMode = z.infer<typeof PresenceMode>;

export const Presence = z.object({
  mode: PresenceMode,
  present: z.boolean(),
  idleSeconds: z.number(),
  locked: z.boolean(),
});
export type Presence = z.infer<typeof Presence>;

// ---------------------------------------------------------------------------------------------------
// Events (server -> client). Every event carries a monotonic `seq` so clients can resume with `sync`.
// ---------------------------------------------------------------------------------------------------

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
  /**
   * Why the replies waiting in a session (queued) wait now, sent when it changes: `locked`, `typing` or
   * `draft`; null once nothing waits there any more (they were typed in or dropped). Never pushed.
   */
  z.object({
    type: z.literal("reply.waiting"),
    sessionId: z.string(),
    reason: z.enum(["locked", "typing", "draft"]).nullable(),
  }),
  z.object({
    type: z.literal("session.notice"),
    sessionId: z.string(),
    level: z.enum(["info", "attention", "error"]),
    text: z.string(),
  }),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody["type"];

export const RelayEvent = z.object({ seq: z.number(), ts: z.number() }).and(EventBody);
export type RelayEvent = { seq: number; ts: number } & EventBody;

// ---------------------------------------------------------------------------------------------------
// RPC (client -> server). Over WebSocket: {id, method, params} -> {id, result} | {id, error}.
// Over HTTPS: POST /rpc {method, params} -> {result} | {error}.
// ---------------------------------------------------------------------------------------------------

export const RpcSchemas = {
  sync: z.object({ sinceSeq: z.number().int().nonnegative().default(0) }),
  "sessions.list": z.object({ includeEnded: z.boolean().default(false) }),
  /**
   * A session's finished turns, newest first. `before` (optional): only turns that ended before this time, to
   * page back through a long history from the oldest turn the phone has. Older helpers ignore the field.
   */
  "session.turns": z.object({
    sessionId: z.string(),
    limit: z.number().int().min(1).max(100).default(20),
    before: z.number().int().nonnegative().optional(),
  }),
  /**
   * Types a message into the session. With `attachments` (ids from `attachment.end`, at most ATTACHMENTS_MAX), the
   * text typed is the message (if any) followed by the files' paths, one per line, quoted when they have spaces;
   * `text` may then be empty. Errors are plain sentences the phone can show. Never retried automatically.
   * Result: SendResult.
   *
   * `sendId` (optional): the phone's own id for this message, the same on Try Again. The helper remembers the
   * ids it delivered (for a day, while it runs): a send with one of them again is answered with the first send's
   * result and `repeat: true`, and typed nothing; one still on its way waits for it. A send that failed is forgotten,
   * so Try Again sends it. Older helpers ignore the field.
   */
  "session.send": z.object({
    sessionId: z.string(),
    text: z.string().max(20_000).default(""),
    attachments: z.array(z.string()).max(100).optional(),
    sendId: z.string().min(1).max(SEND_ID_MAX).optional(),
  }),
  /**
   * Whether the message sent with this `sendId` reached the helper: the phone asks once when the reply to its
   * `session.send` didn't come, before it says "Couldn't send". One still on its way is waited for. Result:
   * DeliveryCheck. Older helpers answer "unknown method"; the phone then says "Couldn't send" as before.
   */
  "session.delivered": z.object({
    sessionId: z.string(),
    sendId: z.string().min(1).max(SEND_ID_MAX),
  }),
  /**
   * Starts an upload to an open session. `sha256` is the file's hex digest. Result: AttachmentUpload. Refused with a
   * plain sentence when the session is unknown or ended, the file is over ATTACHMENT_MAX_BYTES, or the name has a
   * slash, "..", or control or bidi characters. An upload not ended within an hour is removed.
   */
  "attachment.begin": z.object({
    sessionId: z.string(),
    name: z.string().max(1000),
    mime: z.string().max(255).optional(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  }),
  /**
   * One chunk (standard base64) of ATTACHMENT_CHUNK_BYTES bytes, the last one shorter. Sending a chunk again is
   * harmless, so a phone can retry any chunk. Result: AttachmentChunkAck.
   */
  "attachment.chunk": z.object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 + 4),
  }),
  /**
   * Finishes an upload: checks the size and the hash and saves the file (0600) under
   * ~/.relay/attachments/<session>/. Result: AttachmentRef. Calling it again after it succeeded returns the same.
   */
  "attachment.end": z.object({ id: z.string() }),
  /**
   * An attachment removed from the message before it was sent: an unfinished upload is dropped, a saved file is
   * deleted (its row stays, marked removed, like one cleaned up after 7 days). Result: AttachmentDiscarded. Older
   * helpers answer "unknown method"; phones ignore that, and the usual cleanup removes the file later.
   */
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
  /**
   * Stops Claude's current turn, as Esc does in the terminal; the session stays open. Result: InterruptResult.
   * Errors: not_found (unknown or ended), conflict (nothing running), unavailable (no way to reach it).
   */
  "session.interrupt": z.object({ sessionId: z.string() }),
  "prompt.answer": z.object({ promptId: z.string(), answer: Answer }),
  "prompts.open": z.object({}),
  /** Recently settled prompts, newest first: the Inbox history. */
  "prompts.recent": z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  /**
   * A turn's full text. It comes in pieces so a reply never passes the relay's frame limit: `offset` (UTF-16 units,
   * default 0) is where to start, and the result's `more` / `nextOffset` say whether and where to continue. A phone
   * that never sends `offset` gets the first piece (everything, for all but a huge turn).
   */
  "turn.full": z.object({ turnId: z.string(), offset: z.number().int().nonnegative().default(0) }),
  /**
   * Liveness check: the apps call it while open to notice a computer that went silent (asleep, off
   * Wi-Fi) without closing its connection. Any reply proves it's there, so an "unknown method" error
   * from an older helper counts too.
   */
  ping: z.object({}),
  "presence.get": z.object({}),
  "presence.set": z.object({ mode: PresenceMode }),
  /**
   * The calling device's push token. iOS sends an APNs token (platform defaults to "apns", so older iOS
   * builds that send only token + environment keep working): environment is "sandbox" for Xcode/debug
   * builds, "production" for TestFlight. Android sends `platform: "fcm"` with its FCM registration
   * token; environment is ignored there.
   */
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

/**
 * `turn.full`'s result. `more` is true when the text goes on at `nextOffset`; both are absent on the last piece, so
 * an older phone that doesn't know them still reads the text it got.
 */
export const TurnFullResult = z.object({
  text: z.string(),
  more: z.boolean().optional(),
  nextOffset: z.number().int().optional(),
});
export type TurnFullResult = z.infer<typeof TurnFullResult>;

/**
 * `sync`'s result. `latestSeq` is the last seq the reply covers: when `more` is true (the replay was cut by count or
 * size) it's the last event actually sent, and the phone calls `sync` again from there for the rest.
 */
export const SyncResult = z.object({
  snapshot: z.object({ sessions: z.array(Session), prompts: z.array(Prompt), presence: Presence }).optional(),
  events: z.array(RelayEvent),
  latestSeq: z.number(),
  more: z.boolean().optional(),
});
export type SyncResult = z.infer<typeof SyncResult>;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RpcSchemas)[M]>;

export const RpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export interface RpcError {
  code: "bad_request" | "not_found" | "conflict" | "unauthorized" | "internal" | "unavailable";
  message: string;
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

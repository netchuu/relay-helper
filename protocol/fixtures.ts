/**
 * Writes protocol/fixtures/*.json: one validated example of every message the daemon sends.
 * The Swift package decodes the same files in its tests, so a change on either side that breaks the
 * wire format fails a test instead of failing on your phone. Run: bun protocol/fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { transcriptTurns } from "../mac/src/daemon/transcript.ts";
import {
  ATTACHMENT_CHUNK_BYTES,
  AttachmentChunkAck,
  AttachmentData,
  AttachmentDiscarded,
  AttachmentRef,
  AttachmentUpload,
  BackgroundTask,
  DeliveryCheck,
  InterruptResult,
  Presence,
  Prompt,
  RelayEvent,
  RpcSchemas,
  SendResult,
  Session,
  Turn,
  TurnFullResult,
  TurnMessage,
  TurnStep,
} from "./index.ts";

const now = 1793620000000;

const session = Session.parse({
  id: "4375b77a-1111-2222-3333-444455556666",
  name: "web-shop",
  cwd: "/Users/me/Projects/web-shop",
  project: "web-shop",
  branch: "fix/cart-total",
  kind: "interactive",
  status: "waiting",
  title: "The cart total is off by a cent sometimes",
  terminal: "iTerm.app",
  canReceive: true,
  // In iTerm2, so replies are typed in.
  replyRoute: "typed",
  startedAt: now - 600_000,
  updatedAt: now,
  lastSummary: "Fixed the rounding. Totals are now summed in cents.",
});

const sessionMinimal = Session.parse({
  id: "s-min",
  name: null,
  cwd: "/tmp",
  project: "tmp",
  branch: null,
  kind: "unknown",
  status: "idle",
  title: null,
  terminal: null,
  canReceive: false,
  startedAt: now,
  updatedAt: now,
  lastSummary: null,
});

const turn = Turn.parse({
  id: "t_abc",
  sessionId: session.id,
  prompt: "Fix the cart total",
  summary: "Fixed the rounding. …",
  fullLength: 1840,
  truncated: true,
  stats: { durationMs: 241_000, toolCalls: 14, filesEdited: ["/src/cart.ts", "/src/money.ts"] },
  failed: false,
  startedAt: now - 241_000,
  endedAt: now,
});

const question = Prompt.parse({
  id: "p_question",
  sessionId: session.id,
  kind: "question",
  payload: {
    kind: "question",
    questions: [
      {
        question: "Which storage should the health sync use?",
        header: "Storage",
        options: [{ label: "SwiftData", description: "Native" }, { label: "SQLite" }],
        multiSelect: false,
      },
      { question: "Which data?", options: [{ label: "Steps" }, { label: "Sleep" }], multiSelect: true },
    ],
  },
  status: "open",
  resolvedBy: null,
  createdAt: now,
  resolvedAt: null,
});

const plan = Prompt.parse({
  id: "p_plan",
  sessionId: session.id,
  kind: "plan",
  payload: { kind: "plan", plan: "## Add Stripe checkout\n1. Route\n2. Webhook", planFilePath: null },
  status: "open",
  resolvedBy: null,
  createdAt: now,
  resolvedAt: null,
});

const permission = Prompt.parse({
  id: "p_perm",
  sessionId: session.id,
  kind: "permission",
  payload: {
    kind: "permission",
    toolName: "Bash",
    summary: "npm run migrate -- --env staging",
    detail: '{\n  "command": "npm run migrate"\n}',
    canAlwaysAllow: true,
  },
  status: "closed",
  resolvedBy: "phone",
  createdAt: now,
  resolvedAt: now + 5000,
  outcome: "Allowed",
});

const presence = Presence.parse({ mode: "auto", present: false, idleSeconds: 340, locked: true });

const events = z.array(RelayEvent).parse([
  { seq: 1, ts: now, type: "session.upsert", session },
  { seq: 2, ts: now, type: "session.upsert", session: sessionMinimal },
  { seq: 3, ts: now, type: "prompt.opened", prompt: question },
  { seq: 4, ts: now, type: "prompt.opened", prompt: plan },
  { seq: 5, ts: now, type: "prompt.opened", prompt: permission },
  {
    seq: 6,
    ts: now,
    type: "prompt.closed",
    promptId: "p_question",
    resolvedBy: "mac",
    outcome: "Answered on the Mac",
  },
  { seq: 7, ts: now, type: "turn.done", turn },
  { seq: 8, ts: now, type: "presence.changed", presence },
  { seq: 9, ts: now, type: "session.notice", sessionId: session.id, level: "error", text: "rate_limit: 429" },
  { seq: 10, ts: now, type: "session.removed", sessionId: "s-min" },
]);

// turn.full in pieces: a request with an offset, a middle piece (more + nextOffset), the last piece (neither).
const turnFull = {
  paramsFirst: RpcSchemas["turn.full"].parse({ turnId: turn.id }),
  params: RpcSchemas["turn.full"].parse({ turnId: turn.id, offset: 1000 }),
  middle: TurnFullResult.parse({ text: "The first part of a long reply, ", more: true, nextOffset: 1000 }),
  last: TurnFullResult.parse({ text: "and its end." }),
};

const sync = {
  snapshot: { sessions: [session, sessionMinimal], prompts: [question, plan], presence },
  events: [],
  latestSeq: 10,
  // A replay cut by size says so: latestSeq is the last event sent and the phone asks again from there.
  more: true,
};

// A session renamed from a phone (session.rename's reply): name is the phone's, originalName Claude Code's.
// Also an example of a session whose replies arrive through the inbox, marked as from another session.
const sessionRenamed = Session.parse({
  ...session,
  name: "Cart bug",
  originalName: "web-shop",
  replyRoute: "labelled",
  replyFix: "accessibility",
});

// A session pinned to the top of the Sessions list (session.pin's reply).
const sessionPinned = Session.parse({ ...session, pinnedAt: 1_762_250_000_000 });

// A turn the user stopped from the phone (session.interrupt): what Claude wrote before it stopped.
const turnStopped = Turn.parse({
  id: "t_stop",
  sessionId: session.id,
  prompt: "Rewrite the checkout in Svelte",
  summary: "Starting with the cart page.",
  fullLength: 27,
  truncated: false,
  stats: { durationMs: 38_000, toolCalls: 3, filesEdited: ["/src/cart.svelte"] },
  failed: false,
  startedAt: now - 38_000,
  endedAt: now,
  stopped: true,
});
const interrupted = InterruptResult.parse({ via: "tmux", turnId: "t_stop" });

// WebSocket frames exactly as the daemon sends them.
const frames = [
  { type: "event", event: events[0] },
  { type: "rpc", id: 1, result: sync },
  { type: "rpc", id: 2, result: { ok: true } },
  { type: "rpc", id: 3, error: { code: "conflict", message: "already closed (mac)" } },
  { type: "rpc", id: null, error: { code: "bad_request", message: "invalid JSON-RPC message" } },
  { type: "rpc", id: 4, result: sessionRenamed },
  { type: "rpc", id: 5, result: sessionPinned },
  { type: "rpc", id: 6, result: interrupted },
  { type: "event", event: { seq: 11, ts: now, type: "turn.done", turn: turnStopped } },
];

// turn-steps: in a file of its own, so the counts both apps assert on events.json don't change.
const thinking = TurnStep.parse({ kind: "thinking", label: "Thinking", at: now - 30_000 });
const reading = TurnStep.parse({ kind: "read", label: "Reading src/cart.ts", at: now - 20_000 });
const steps = {
  events: z.array(RelayEvent).parse([
    { seq: 11, ts: now - 30_000, type: "turn.step", sessionId: session.id, turnId: "t_live", step: thinking },
    { seq: 12, ts: now - 20_000, type: "turn.step", sessionId: session.id, turnId: "t_live", step: reading },
  ]),
  turn: Turn.parse({
    ...turn,
    id: "t_steps",
    steps: [
      { kind: "read", label: "Read src/cart.ts", at: now - 200_000 },
      { kind: "run", label: "Ran bun test", at: now - 120_000, failed: true },
      { kind: "agent", label: "Ran an agent: Check the totals", at: now - 60_000 },
    ],
    stepsMore: 37,
  }),
  session: Session.parse({ ...session, status: "working", step: reading }),
  live: { turnId: "t_live", prompt: "Fix the cart total", startedAt: now - 30_000, step: reading },
};

// live-messages: in a file of its own too. The live turn's messages, then the same ids in the finished turn.
const looking = TurnMessage.parse({
  id: "9b1c7e2a-0d4f-4c55-8f0e-2b7a61c3d001",
  text: "Let me look at how the cart adds up the **total** first.",
  at: now - 25_000,
});
const found = TurnMessage.parse({
  id: "9b1c7e2a-0d4f-4c55-8f0e-2b7a61c3d002",
  text: "Found it: the discount is applied twice in `src/cart.ts`.\n\nThe second time comes from …",
  at: now - 15_000,
  truncated: true,
});
const messages = {
  events: z.array(RelayEvent).parse([
    {
      seq: 21,
      ts: now - 25_000,
      type: "turn.message",
      sessionId: session.id,
      turnId: "t_live",
      message: looking,
    },
    {
      seq: 22,
      ts: now - 15_000,
      type: "turn.message",
      sessionId: session.id,
      turnId: "t_live",
      message: found,
    },
  ]),
  turn: Turn.parse({ ...turn, id: "t_messages", messages: [looking, found], messagesMore: 3 }),
  live: {
    turnId: "t_live",
    prompt: "Fix the cart total",
    startedAt: now - 30_000,
    messages: [looking, found],
  },
};

// turn-timeline: in a file of its own too. A thinking line and an action (then the same action failed), live, and
// the finished turn with its steps' tool, title and detail and its thinking lines.
const thought = TurnStep.parse({
  kind: "thinking",
  label: "Thought for 4s",
  id: "0f2c1d4e-0000-4000-8000-00000000a001",
  at: now - 26_000,
  durationMs: 4200,
});
const build = TurnStep.parse({
  kind: "run",
  label: "Ran swift build",
  id: "toolu_01TimelineBuild",
  tool: "Bash",
  title: "Update settings/README and rebuild",
  detail: "cd ios && swift build 2>&1 | tail -3\necho done",
  at: now - 22_000,
});
const readCart = TurnStep.parse({
  kind: "read",
  label: "Read src/cart.ts",
  id: "toolu_01TimelineRead",
  tool: "Read",
  detail: "src/cart.ts",
  at: now - 20_000,
});
const timeline = {
  events: z.array(RelayEvent).parse([
    {
      seq: 31,
      ts: now - 26_000,
      type: "turn.action",
      sessionId: session.id,
      turnId: "t_live",
      step: thought,
    },
    { seq: 32, ts: now - 22_000, type: "turn.action", sessionId: session.id, turnId: "t_live", step: build },
    {
      seq: 33,
      ts: now - 18_000,
      type: "turn.action",
      sessionId: session.id,
      turnId: "t_live",
      step: { ...build, failed: true },
    },
  ]),
  turn: Turn.parse({
    ...turn,
    id: "t_timeline",
    steps: [{ ...build, failed: true }, readCart],
    thoughts: [thought],
  }),
  live: {
    turnId: "t_live",
    prompt: "Fix the cart total",
    startedAt: now - 30_000,
    actions: [thought, { ...build, failed: true }],
  },
};

// agent-progress: the same file. An agent's step live (running, count and current step, by the same id), finished
// (count and time, its own steps) and a workflow's (one line per agent). Older phones ignore the new fields.
const agentChildren = [
  { kind: "read", label: "Read lib.ts", at: now - 70_000, id: "toolu_01AgentR1", tool: "Read" },
  { kind: "run", label: "Ran bun test", at: now - 60_000, id: "toolu_01AgentR2", tool: "Bash", failed: true },
  { kind: "read", label: "Read app.ts", at: now - 50_000, id: "toolu_01AgentR3", tool: "Read" },
];
const agentRunning = TurnStep.parse({
  kind: "agent",
  label: "Running an agent: Review PR #30",
  at: now - 80_000,
  id: "toolu_01AgentReview",
  tool: "Agent",
  title: "Review PR #30",
  running: true,
  stepCount: 12,
  current: "Reading lib.ts",
  children: agentChildren,
  childrenMore: 9,
});
const agentDone = TurnStep.parse({
  kind: "agent",
  label: "Ran an agent: Review PR #30",
  at: now - 80_000,
  id: "toolu_01AgentReview",
  tool: "Agent",
  title: "Review PR #30",
  stepCount: 34,
  durationMs: 240_000,
  children: agentChildren,
  childrenMore: 31,
});
const workflowDone = TurnStep.parse({
  kind: "agent",
  label: "Ran the deploy workflow",
  at: now - 90_000,
  id: "toolu_01WorkflowDeploy",
  tool: "Workflow",
  durationMs: 600_000,
  children: [
    { kind: "agent", label: "Build the site", at: now - 85_000, id: "agent-a1", state: "done" },
    { kind: "agent", label: "Run the tests", at: now - 84_000, id: "agent-a2", state: "running" },
    { kind: "agent", label: "Upload the release", at: now - 83_000, id: "agent-a3", state: "failed" },
  ],
});
const agentProgress = {
  events: z.array(RelayEvent).parse([
    {
      seq: 35,
      ts: now - 70_000,
      type: "turn.action",
      sessionId: session.id,
      turnId: "t_agent",
      step: agentRunning,
    },
    {
      seq: 36,
      ts: now - 10_000,
      type: "turn.action",
      sessionId: session.id,
      turnId: "t_agent",
      step: agentDone,
    },
  ]),
  turn: Turn.parse({ ...turn, id: "t_agent", steps: [agentDone, workflowDone] }),
};

// background-work: in a file of its own too. A shell and an agent running, then nothing.
const devServer = BackgroundTask.parse({
  id: "bonwwqtte",
  kind: "shell",
  title: "Start the dev server",
  detail: "npm run dev -- --port 5180",
  startedAt: now - 2_820_000,
});
const helperTests = BackgroundTask.parse({
  id: "a009ac2509eecfda6",
  kind: "agent",
  title: "Test the helper side",
  agentType: "general-purpose",
  startedAt: now - 371_000,
  activity: { kind: "run", label: "Running bun test", at: now - 4_000 },
});
const background = {
  events: z.array(RelayEvent).parse([
    {
      seq: 41,
      ts: now - 4_000,
      type: "session.background",
      sessionId: session.id,
      tasks: [devServer, helperTests],
    },
    { seq: 42, ts: now, type: "session.background", sessionId: session.id, tasks: [] },
  ]),
  session: Session.parse({ ...session, status: "idle", background: [devServer, helperTests] }),
};

// attachments: in a file of its own too. The upload of a photo in chunks, a message with it and a PDF, the turn and
// turn.started that list them, fetching a chunk and a thumbnail back, and the refusals the phone shows as they are.
const photoPath = `/Users/me/.relay/attachments/${session.id}/3f9a1c2e-IMG_1234.HEIC`;
const pdfPath = `/Users/me/.relay/attachments/${session.id}/b71d04aa-Cart totals.pdf`;
const photo = AttachmentRef.parse({
  id: "3f9a1c2e5b7d9f01",
  name: "IMG_1234.HEIC",
  mime: "image/heic",
  size: 200_000,
  path: photoPath,
});
const pdf = AttachmentRef.parse({
  id: "b71d04aa66e2c3f5",
  name: "Cart totals.pdf",
  mime: "application/pdf",
  size: 48_213,
  path: pdfPath,
});
const prompt = `Why is the total off here?\n${photoPath}\n"${pdfPath}"`;
const tinyJpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAP/Z";
const attachments = {
  limits: { attachmentsMax: 10, maxBytes: 50 * 1024 * 1024, chunkBytes: ATTACHMENT_CHUNK_BYTES },
  begin: {
    params: RpcSchemas["attachment.begin"].parse({
      sessionId: session.id,
      name: "IMG_1234.HEIC",
      mime: "image/heic",
      size: 200_000,
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    }),
    result: AttachmentUpload.parse({ id: photo.id, chunkSize: ATTACHMENT_CHUNK_BYTES, chunks: 2 }),
  },
  chunk: {
    // data is the chunk in standard base64: 131072 bytes, then the last 68928; shortened here.
    params: RpcSchemas["attachment.chunk"].parse({ id: photo.id, index: 1, data: "AAECAwQFBgc=" }),
    result: AttachmentChunkAck.parse({ id: photo.id, index: 1, received: 2 }),
  },
  end: { params: RpcSchemas["attachment.end"].parse({ id: photo.id }), result: photo },
  // A picked attachment removed before Send: its upload, finished or not, goes from the computer. An older
  // helper doesn't know the method; the phone ignores that answer.
  discard: {
    params: RpcSchemas["attachment.discard"].parse({ id: photo.id }),
    result: AttachmentDiscarded.parse({ id: photo.id, discarded: true }),
    resultNothing: AttachmentDiscarded.parse({ id: "0000000000000000", discarded: false }),
    olderHelper: {
      type: "rpc",
      id: 65,
      error: { code: "bad_request", message: "unknown method attachment.discard" },
    },
  },
  send: {
    params: RpcSchemas["session.send"].parse({
      sessionId: session.id,
      text: "Why is the total off here?",
      attachments: [photo.id, pdf.id],
    }),
    // Only attachments, no text.
    paramsNoText: RpcSchemas["session.send"].parse({
      sessionId: session.id,
      text: "",
      attachments: [photo.id],
    }),
    result: { via: "tmux" },
    // What was typed into the session: the message, then each path on its own line, quoted when it has spaces.
    typed: prompt,
  },
  // data is the whole chunk in base64 (here the PDF's 48213 bytes); shortened here.
  get: {
    params: RpcSchemas["attachment.get"].parse({ id: pdf.id, index: 0 }),
    result: AttachmentData.parse({
      id: pdf.id,
      name: pdf.name,
      mime: pdf.mime,
      size: pdf.size,
      sha256: "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752",
      chunkSize: ATTACHMENT_CHUNK_BYTES,
      chunks: 1,
      index: 0,
      data: "JVBERi0xLjQK",
    }),
    thumbnailParams: RpcSchemas["attachment.get"].parse({ id: photo.id, thumbnail: true }),
    thumbnail: AttachmentData.parse({
      id: photo.id,
      name: photo.name,
      mime: "image/jpeg",
      size: 93,
      sha256: "0aeb869eee19deae9306ca9432011f483487f7ac69e64e14ab36a9cb08b938b1",
      chunkSize: ATTACHMENT_CHUNK_BYTES,
      chunks: 1,
      index: 0,
      data: tinyJpeg,
      thumbnail: true,
    }),
  },
  events: z.array(RelayEvent).parse([
    {
      seq: 51,
      ts: now - 60_000,
      type: "turn.started",
      turnId: "t_attach",
      sessionId: session.id,
      prompt,
      startedAt: now - 60_000,
      attachments: [photo, pdf],
    },
  ]),
  turn: Turn.parse({ ...turn, id: "t_attach", prompt, attachments: [photo, pdf] }),
  // After 7 days the files are removed from the computer; the turn still lists them.
  turnRemoved: Turn.parse({
    ...turn,
    id: "t_attach_old",
    prompt: photoPath,
    attachments: [{ ...photo, removed: true }],
  }),
  live: { turnId: "t_attach", prompt, startedAt: now - 60_000, attachments: [photo, pdf] },
  errors: [
    {
      type: "rpc",
      id: 61,
      error: { code: "bad_request", message: "You can attach up to 10 files to one message." },
    },
    {
      type: "rpc",
      id: 62,
      error: { code: "bad_request", message: "IMG_1234.MOV is too large. Files can be up to 50 MB." },
    },
    {
      type: "rpc",
      id: 63,
      error: { code: "conflict", message: "IMG_1234.HEIC didn't arrive intact. Send it again." },
    },
    {
      type: "rpc",
      id: 64,
      error: { code: "not_found", message: "This session has ended, so files can't be sent to it." },
    },
  ],
};

// A message's own id, so a send whose reply was lost is neither typed twice nor shown as "Couldn't send".
const sendId = "8f14e45f-ceea-467a-9575-6d0f5e1c3b2a";
const sends = {
  // The phone's id for the message; Try Again sends the same one.
  params: RpcSchemas["session.send"].parse({ sessionId: session.id, text: "Ship it", sendId }),
  result: SendResult.parse({ via: "tmux" }),
  // Waiting for a pause in your typing, typed then: the id is remembered all the same.
  resultQueued: SendResult.parse({ via: "queued" }),
  // Why it waits. Without a reason (an older helper) the phone says the Mac is locked.
  resultQueuedLocked: SendResult.parse({ via: "queued", reason: "locked" }),
  resultQueuedTyping: SendResult.parse({ via: "queued", reason: "typing" }),
  resultQueuedDraft: SendResult.parse({ via: "queued", reason: "draft" }),
  // The reason changing while it waits, then nothing waiting: the draft was sent at the Mac.
  waitingEvents: z.array(RelayEvent).parse([
    { seq: 50, ts: now, type: "reply.waiting", sessionId: session.id, reason: "draft" },
    { seq: 51, ts: now, type: "reply.waiting", sessionId: session.id, reason: "typing" },
    { seq: 52, ts: now, type: "reply.waiting", sessionId: session.id, reason: null },
  ]),
  // The same id again: nothing typed, the first send's answer.
  resultRepeat: SendResult.parse({ via: "tmux", repeat: true }),
  // No reply came: the phone asks once.
  check: RpcSchemas["session.delivered"].parse({ sessionId: session.id, sendId }),
  delivered: DeliveryCheck.parse({ delivered: true, via: "tmux" }),
  deliveredQueued: DeliveryCheck.parse({ delivered: true, via: "queued" }),
  notDelivered: DeliveryCheck.parse({ delivered: false }),
  // An older helper, without `session.delivered`: the phone says "Couldn't send", as it did.
  olderHelper: {
    type: "rpc",
    id: 71,
    error: { code: "bad_request", message: "unknown method session.delivered" },
  },
};

// recorded-transcripts: the turns the helper makes from real Claude Code transcripts (mac/test/fixtures/transcripts/,
// recorded by `bun run record:transcripts`), so the apps decode what a real session produces: an [Image #N] prompt, a
// stopped turn, an agent, a background shell, a failed tool. Oldest turn first, as the phone lists them.
const transcriptsDir = join(import.meta.dir, "..", "mac", "test", "fixtures", "transcripts");
const recordedIndex = JSON.parse(readFileSync(join(transcriptsDir, "index.json"), "utf8")) as Record<
  string,
  { about: string; claudeVersion: string }
>;
const recorded = Object.fromEntries(
  Object.entries(recordedIndex).map(([name, info]) => [
    name,
    {
      about: info.about,
      claudeVersion: info.claudeVersion,
      turns: z.array(Turn).parse(
        transcriptTurns(`rec-${name}`, join(transcriptsDir, `${name}.jsonl`), {
          limit: 10,
          previewChars: 600,
          working: false,
          cwd: "/Users/me/Projects/scratch",
        }).reverse(),
      ),
    },
  ]),
);

const dir = join(import.meta.dir, "fixtures");
mkdirSync(dir, { recursive: true });
const write = (name: string, value: unknown) =>
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
write("events.json", events);
write("sync.json", sync);
write("frames.json", frames);
write("turns.json", [turn]);
write("turn-full.json", turnFull);
write("steps.json", steps);
write("messages.json", messages);
write("timeline.json", { ...timeline, agent: agentProgress });
write("background.json", background);
write("attachments.json", attachments);
write("sends.json", sends);
write("recorded.json", recorded);
console.log(`wrote fixtures to ${dir}`);

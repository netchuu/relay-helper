import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

// Re-sent answers in every shape the phone sends, after a restart and over RPC: a phone that never got the
// reply to its answer sends the same answer again and gets ok; any other answer, or a prompt that the phone
// didn't close with that answer, is still a conflict. The first answer is applied once, however often it's re-sent.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(db: DB = openDb(":memory:")) {
  const events = new EventLog(db);
  const broker = new Broker(db, events);
  return { db, events, broker };
}

function openPrompt(
  h: ReturnType<typeof harness>,
  tool = "Bash",
  toolInput: Record<string, unknown> = { command: "ls" },
  extra: Record<string, unknown> = {},
) {
  const opened = h.broker.open({
    session_id: "s1",
    tool_name: tool,
    tool_input: toolInput,
    ...extra,
  } as never);
  const replies: string[] = [];
  void opened.reply.then((r) => replies.push(r.stdout));
  return { id: opened.prompt.id, replies };
}

const closedEvents = (h: ReturnType<typeof harness>, id: string) =>
  h.events.since(0).filter((e) => e.type === "prompt.closed" && e.promptId === id).length;
const auditRows = (h: ReturnType<typeof harness>) =>
  (h.db.query("SELECT COUNT(*) AS n FROM audit WHERE action = 'prompt.answer'").get() as { n: number }).n;

const QUESTIONS = {
  questions: [
    {
      question: "Which stack?",
      header: "Stack",
      multiSelect: true,
      options: [{ label: "Swift" }, { label: "Kotlin" }, { label: "Rust" }],
    },
    { question: "Name it?", header: "Name", options: [{ label: "Relay" }, { label: "Bridge" }] },
  ],
};
const PLAN = { plan: "# Port\n\n- step one" };

test("a plan answer with feedback re-sent in another key order is ok, and the hook is answered once", async () => {
  const h = harness();
  const p = openPrompt(h, "ExitPlanMode", PLAN);
  const first = { kind: "plan", action: "revise", feedback: "add tests 🧪 first" } as const;
  expect(h.broker.answer(p.id, first, "device:a")).toEqual({ ok: true });
  expect(
    h.broker.answer(
      p.id,
      { feedback: "add tests 🧪 first", action: "revise", kind: "plan" } as never,
      "device:a",
    ),
  ).toEqual({ ok: true });
  await Bun.sleep(0);
  expect(p.replies.length).toBe(1);
  expect(closedEvents(h, p.id)).toBe(1);
  expect(auditRows(h)).toBe(1);
});

test("a plan approve re-sent three times is ok each time; a reject after it is a conflict", () => {
  const h = harness();
  const p = openPrompt(h, "ExitPlanMode", PLAN);
  for (let i = 0; i < 3; i++)
    expect(h.broker.answer(p.id, { kind: "plan", action: "approve" }, "device:a")).toEqual({ ok: true });
  expect(h.broker.answer(p.id, { kind: "plan", action: "reject" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
  expect(auditRows(h)).toBe(1);
});

test("a multi-select question answer with free text and emoji re-sent is ok", async () => {
  const h = harness();
  const p = openPrompt(h, "AskUserQuestion", QUESTIONS);
  const answer = {
    kind: "question",
    answers: { "Which stack?": "Swift, Kotlin", "Name it?": "Relay 🚀 v2" },
  } as const;
  expect(h.broker.answer(p.id, answer, "device:a")).toEqual({ ok: true });
  expect(
    h.broker.answer(
      p.id,
      { answers: { "Name it?": "Relay 🚀 v2", "Which stack?": "Swift, Kotlin" }, kind: "question" } as never,
      "device:a",
    ),
  ).toEqual({ ok: true });
  await Bun.sleep(0);
  expect(p.replies.length).toBe(1);
});

test("a question answer that differs in one question, or leaves one out, is a conflict", () => {
  const h = harness();
  const p = openPrompt(h, "AskUserQuestion", QUESTIONS);
  h.broker.answer(
    p.id,
    { kind: "question", answers: { "Which stack?": "Swift", "Name it?": "Relay" } },
    "device:a",
  );
  expect(
    h.broker.answer(
      p.id,
      { kind: "question", answers: { "Which stack?": "Rust", "Name it?": "Relay" } },
      "device:a",
    ),
  ).toMatchObject({ ok: false, code: "conflict" });
  expect(
    h.broker.answer(p.id, { kind: "question", answers: { "Which stack?": "Swift" } }, "device:a"),
  ).toMatchObject({ ok: false, code: "conflict" });
});

test("a deny with a reason and the same deny without it are different answers", () => {
  const h = harness();
  const p = openPrompt(h);
  h.broker.answer(p.id, { kind: "permission", action: "deny", reason: "not now" }, "device:a");
  expect(h.broker.answer(p.id, { kind: "permission", action: "deny" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
  expect(
    h.broker.answer(p.id, { kind: "permission", action: "deny", reason: "Not now" }, "device:a"),
  ).toMatchObject({
    ok: false,
    code: "conflict",
  });
  expect(
    h.broker.answer(p.id, { kind: "permission", action: "deny", reason: "not now" }, "device:a"),
  ).toEqual({
    ok: true,
  });
});

test("Always allow re-sent is ok, recorded once, and the hook gets one reply", async () => {
  const h = harness();
  const p = openPrompt(
    h,
    "Bash",
    { command: "npm test" },
    {
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }] }],
    },
  );
  expect(h.broker.answer(p.id, { kind: "permission", action: "allow_always" }, "device:a")).toEqual({
    ok: true,
  });
  expect(h.broker.answer(p.id, { kind: "permission", action: "allow_always" }, "device:a")).toEqual({
    ok: true,
  });
  // "allow" is a different answer from "allow_always".
  expect(h.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
  await Bun.sleep(0);
  expect(p.replies.length).toBe(1);
  expect(auditRows(h)).toBe(1);
  expect(closedEvents(h, p.id)).toBe(1);
});

test("the same answer from a second phone is ok too (it's the decision that was made)", () => {
  const h = harness();
  const p = openPrompt(h);
  h.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a");
  expect(h.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:b")).toEqual({ ok: true });
  expect(auditRows(h)).toBe(1);
});

test("a prompt that timed out stays a conflict for the same answer re-sent", () => {
  const h = harness();
  const p = openPrompt(h);
  h.broker.expire(-1);
  expect(h.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({
    ok: false,
    code: "conflict",
    message: "already closed (timeout)",
  });
});

test("a question answered at the Mac stays a conflict even when the phone sends the very same answers", () => {
  const h = harness();
  const p = openPrompt(h, "AskUserQuestion", QUESTIONS);
  const answers = { "Which stack?": "Swift", "Name it?": "Relay" };
  h.broker.settleFromSessionEvent("s1", {
    hookEventName: "PostToolUse",
    toolName: "AskUserQuestion",
    toolInput: { ...QUESTIONS, answers },
    toolResponse: { answers },
  });
  expect(h.broker.get(p.id)?.resolvedBy).toBe("mac");
  expect(h.broker.answer(p.id, { kind: "question", answers }, "device:a")).toEqual({
    ok: false,
    code: "conflict",
    message: "already closed (mac)",
  });
});

test("an unknown prompt is not_found, re-sent or not", () => {
  const h = harness();
  for (let i = 0; i < 2; i++)
    expect(h.broker.answer("p_nope", { kind: "permission", action: "allow" }, "device:a")).toMatchObject({
      ok: false,
      code: "not_found",
    });
});

test("the tool running at the Mac after the phone's answer doesn't turn the re-send into a conflict", () => {
  const h = harness();
  const p = openPrompt(h);
  h.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a");
  // PostToolUse for the same tool and input, then the turn ends: the prompt is already closed by the phone.
  h.broker.settleFromSessionEvent("s1", {
    hookEventName: "PostToolUse",
    toolName: "Bash",
    toolInput: { command: "ls" },
  });
  h.broker.settleFromSessionEvent("s1", { hookEventName: "Stop" });
  expect(h.broker.stop("s1", "device:a")).toBeNull();
  expect(h.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({ ok: true });
});

test("a newer prompt in the session doesn't affect the re-send of an answered one", () => {
  const h = harness();
  const plan1 = openPrompt(h, "ExitPlanMode", PLAN);
  h.broker.answer(plan1.id, { kind: "plan", action: "revise", feedback: "shorter" }, "device:a");
  // The revised plan opens a new prompt (ExitPlanMode settles older open plans as "mac", but this one is closed).
  openPrompt(h, "ExitPlanMode", { plan: "# Port, shorter" });
  expect(
    h.broker.answer(plan1.id, { kind: "plan", action: "revise", feedback: "shorter" }, "device:a"),
  ).toEqual({
    ok: true,
  });
});

// Helper restart during the phone's retry.

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "relay-answer-retry-"));
  dirs.push(dir);
  return join(dir, "relay.db");
}

test("helper restart after the answer arrived: the re-send is ok, a different answer a conflict", () => {
  const path = fileDb();
  const before = harness(openDb(path));
  const p = openPrompt(before);
  before.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a");
  before.db.close();

  const after = harness(openDb(path));
  after.broker.closeOrphans();
  expect(after.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({
    ok: true,
  });
  expect(after.broker.answer(p.id, { kind: "permission", action: "deny" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
  after.db.close();
});

test("helper restart before the answer arrived: the answer and its re-send are both conflicts", () => {
  const path = fileDb();
  const before = harness(openDb(path));
  const p = openPrompt(before);
  before.db.close();

  const after = harness(openDb(path));
  after.broker.closeOrphans();
  for (let i = 0; i < 2; i++)
    expect(after.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({
      ok: false,
      code: "conflict",
      message: "already closed (superseded)",
    });
  after.db.close();
});

test("an answer in the window before orphans are closed: 'no longer waiting', and its re-send isn't ok", () => {
  const path = fileDb();
  const before = harness(openDb(path));
  const p = openPrompt(before);
  before.db.close();

  const after = harness(openDb(path));
  expect(after.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({
    ok: false,
    code: "conflict",
    message: "the session is no longer waiting for this answer",
  });
  expect(after.broker.answer(p.id, { kind: "permission", action: "allow" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
  after.db.close();
});

// Over the RPC layer, as the phone calls it.

function rpcFor(h: ReturnType<typeof harness>) {
  return createRpc({ db: h.db, events: h.events, broker: h.broker } as unknown as RpcDeps);
}

test("over RPC: the same prompt.answer twice returns ok twice; a different one returns a conflict error", async () => {
  const h = harness();
  const rpc = rpcFor(h);
  const p = openPrompt(h);
  const params = { promptId: p.id, answer: { kind: "permission", action: "allow" } };
  expect(await rpc("prompt.answer", params, "device:a")).toEqual({ result: { ok: true } });
  expect(await rpc("prompt.answer", params, "device:a")).toEqual({ result: { ok: true } });
  const other = await rpc(
    "prompt.answer",
    { promptId: p.id, answer: { kind: "permission", action: "deny" } },
    "device:a",
  );
  expect(other).toMatchObject({ error: { code: "conflict", message: "already closed (phone)" } });
});

test("over RPC: a field the helper doesn't know in the answer doesn't stop the re-send from matching", async () => {
  const h = harness();
  const rpc = rpcFor(h);
  const p = openPrompt(h);
  const params = { promptId: p.id, answer: { kind: "permission", action: "allow", sentAt: 123 } };
  expect(await rpc("prompt.answer", params, "device:a")).toEqual({ result: { ok: true } });
  expect(
    await rpc(
      "prompt.answer",
      { promptId: p.id, answer: { kind: "permission", action: "allow", sentAt: 456 } },
      "device:a",
    ),
  ).toEqual({ result: { ok: true } });
});

import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";

// A phone re-sends an answer whose reply it never got. The same answer again from a phone is a success;
// anything else after the first answer is still a conflict.

function setup(tool = "Bash", toolInput: Record<string, unknown> = { command: "ls" }) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const broker = new Broker(db, events);
  const opened = broker.open({ session_id: "s1", tool_name: tool, tool_input: toolInput });
  let replies = 0;
  void opened.reply.then(() => replies++);
  const closed = () =>
    events.since(0).filter((e) => e.type === "prompt.closed" && e.promptId === opened.prompt.id).length;
  return { broker, id: opened.prompt.id, replies: () => replies, closed };
}

test("the same answer twice from the phone: both succeed, the hook is answered and the prompt closed once", async () => {
  const t = setup();
  expect(t.broker.answer(t.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({ ok: true });
  expect(t.broker.answer(t.id, { kind: "permission", action: "allow" }, "device:a")).toEqual({ ok: true });
  await Bun.sleep(0);
  expect(t.replies()).toBe(1);
  expect(t.closed()).toBe(1);
});

test("a question's answers in another key order are the same answer", () => {
  const t = setup("AskUserQuestion", {
    questions: [
      { question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] },
      { question: "Where?", header: "W", options: [{ label: "Here" }] },
    ],
  });
  expect(
    t.broker.answer(t.id, { kind: "question", answers: { "Which?": "A", "Where?": "Here" } }, "device:a"),
  ).toEqual({ ok: true });
  expect(
    t.broker.answer(
      t.id,
      { answers: { "Where?": "Here", "Which?": "A" }, kind: "question" } as never,
      "device:a",
    ),
  ).toEqual({ ok: true });
});

test("a different answer after the first is still a conflict", () => {
  const t = setup();
  t.broker.answer(t.id, { kind: "permission", action: "allow" }, "device:a");
  expect(t.broker.answer(t.id, { kind: "permission", action: "deny" }, "device:b")).toEqual({
    ok: false,
    code: "conflict",
    message: "already closed (phone)",
  });
});

test("a prompt answered at the Mac or superseded stays a conflict, whatever the phone sends", () => {
  const t = setup();
  t.broker.close(t.id, "mac");
  expect(t.broker.answer(t.id, { kind: "permission", action: "allow" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
  const u = setup();
  u.broker.close(u.id, "superseded");
  expect(u.broker.answer(u.id, { kind: "permission", action: "allow" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
});

test("the phone's Stop on a prompt isn't mistaken for an answer", () => {
  const t = setup();
  expect(t.broker.stop("s1", "device:a")).toBe(t.id);
  expect(t.broker.answer(t.id, { kind: "permission", action: "allow" }, "device:a")).toMatchObject({
    ok: false,
    code: "conflict",
  });
});

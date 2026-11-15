import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";

// The phone shows a question redacted; the answer still has to reach Claude Code under the original text.

function ask(questions: unknown[]) {
  const db = openDb(":memory:");
  const broker = new Broker(db, new EventLog(db));
  const opened = broker.open({
    session_id: "s1",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  });
  return { broker, opened };
}

async function answers(questions: unknown[], pick: (shown: any[]) => Record<string, string>) {
  const { broker, opened } = ask(questions);
  const payload = opened.prompt.payload as any;
  expect(
    broker.answer(opened.prompt.id, { kind: "question", answers: pick(payload.questions) }, "device:a"),
  ).toEqual({
    ok: true,
  });
  const reply = await opened.reply;
  return JSON.parse(reply.stdout as string).hookSpecificOutput.decision.updatedInput.answers;
}

const Q = "Where should I keep the secret: environment variables or a config file?";

test("a redacted question and option come back under their original text", async () => {
  const questions = [
    { question: Q, options: [{ label: "password: hunter2hunter2" }, { label: "A config file" }] },
  ];
  const got = await answers(questions, (shown) => {
    expect(shown[0].question).not.toBe(Q);
    expect(shown[0].options[0].label).not.toContain("hunter2");
    return { [shown[0].question]: shown[0].options[0].label };
  });
  expect(got).toEqual({ [Q]: "password: hunter2hunter2" });
});

test("a redacted option in a multi-select list is restored", async () => {
  const questions = [
    {
      question: Q,
      multiSelect: true,
      options: [{ label: "password: hunter2hunter2" }, { label: "A config file" }],
    },
  ];
  const got = await answers(questions, (shown) => ({
    [shown[0].question]: `${shown[0].options[0].label}, A config file`,
  }));
  expect(got).toEqual({ [Q]: "password: hunter2hunter2, A config file" });
});

test("nothing to redact works as before, and free text passes through", async () => {
  const questions = [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }];
  expect(await answers(questions, () => ({ "Which?": "B" }))).toEqual({ "Which?": "B" });
  expect(await answers(questions, () => ({ "Which?": "something else" }))).toEqual({
    "Which?": "something else",
  });
  const redacted = [{ question: Q, options: [{ label: "A" }] }];
  expect(await answers(redacted, (shown) => ({ [shown[0].question]: "my own words" }))).toEqual({
    [Q]: "my own words",
  });
});

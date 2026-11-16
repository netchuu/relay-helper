import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { fitAlert, promptAlert } from "../src/daemon/notifier.ts";

// Two options that differ only inside a redacted secret show as the same button; the index must still pick its own.
const fake = (c: string) => `sk-ant-${"api03"}-${c.repeat(36)}`; // made-up, not a real key
const A = `Use key ${fake("A")}`;
const B = `Use key ${fake("B")}`;
const Q = "Which key?";

function ask(question = Q) {
  const db = openDb(":memory:");
  const broker = new Broker(db, new EventLog(db));
  const opened = broker.open({
    session_id: "s1",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{ question, header: "Key", multiSelect: false, options: [{ label: A }, { label: B }] }],
    },
  } as never);
  const replies: string[] = [];
  void opened.reply.then((r) => replies.push(r.stdout));
  return { broker, opened, replies };
}

const answersOf = (stdout: string) =>
  JSON.parse(stdout).hookSpecificOutput.decision.updatedInput.answers as Record<string, string>;

for (const [index, want] of [
  [0, A],
  [1, B],
] as const) {
  test(`button ${index} of two options that redact to the same text answers with its own option`, async () => {
    const { broker, opened, replies } = ask();
    const data = fitAlert(promptAlert(opened.prompt, "Mac")).data as { question: string; options: string[] };
    expect(data.options[0]).toBe(data.options[1]);
    expect(data.options[0]).toBe("Use key [redacted:anthropic-key]");
    const result = broker.answer(
      opened.prompt.id,
      {
        kind: "question",
        answers: { [data.question]: data.options[index] as string },
        choices: { [data.question]: index },
      },
      "device:a",
    );
    expect(result).toEqual({ ok: true });
    await Bun.sleep(0);
    expect(answersOf(replies[0] as string)).toEqual({ [Q]: want });
  });
}

test("without an index the first twin answers, as before", async () => {
  const { broker, opened, replies } = ask();
  const shown = "Use key [redacted:anthropic-key]";
  expect(broker.answer(opened.prompt.id, { kind: "question", answers: { [Q]: shown } }, "device:a")).toEqual({
    ok: true,
  });
  await Bun.sleep(0);
  expect(answersOf(replies[0] as string)).toEqual({ [Q]: A });
});

test("an index that names no option keeps the shown text's option", async () => {
  const { broker, opened, replies } = ask();
  const shown = "Use key [redacted:anthropic-key]";
  broker.answer(
    opened.prompt.id,
    { kind: "question", answers: { [Q]: shown }, choices: { [Q]: 7 } },
    "device:a",
  );
  await Bun.sleep(0);
  expect(answersOf(replies[0] as string)).toEqual({ [Q]: A });
});

test("a cut question's button with an index still answers with its own option", async () => {
  const long = "Which key should the service use? " + "Context: lorem ipsum dolor sit amet. ".repeat(120);
  const { broker, opened, replies } = ask(long);
  const data = fitAlert(promptAlert(opened.prompt, "Mac")).data as { question: string; options: string[] };
  expect(data.question).not.toBe(long);
  broker.answer(
    opened.prompt.id,
    {
      kind: "question",
      answers: { [data.question]: data.options[1] as string },
      choices: { [data.question]: 1 },
    },
    "device:a",
  );
  await Bun.sleep(0);
  expect(answersOf(replies[0] as string)).toEqual({ [long]: B });
});

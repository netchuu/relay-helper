import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { promptAlert } from "../src/daemon/notifier.ts";

// A notification button shows a short title, so the answer it sends names the option by its index; the hook gets
// that option's full label, even when two options share their first 40 characters.

const A = "Use the existing Postgres cluster in eu-west-1";
const B = "Use the existing Postgres cluster in eu-central-1";
const Q = "Which database?";

function ask() {
  const db = openDb(":memory:");
  const broker = new Broker(db, new EventLog(db));
  const opened = broker.open({
    session_id: "s1",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{ question: Q, header: "DB", multiSelect: false, options: [{ label: A }, { label: B }] }],
    },
  } as never);
  const replies: string[] = [];
  void opened.reply.then((r) => replies.push(r.stdout));
  return { broker, opened, replies };
}

const answersOf = (stdout: string) =>
  JSON.parse(stdout).hookSpecificOutput.decision.updatedInput.answers as Record<string, string>;

test("the second of two long options with the same start is what the hook gets", async () => {
  const { broker, opened, replies } = ask();
  const buttons = promptAlert(opened.prompt, "Mac").data.options as string[];
  expect(buttons[0]).toBe(buttons[1]);
  const result = broker.answer(
    opened.prompt.id,
    { kind: "question", answers: { [Q]: buttons[1] as string }, choices: { [Q]: 1 } },
    "device:a",
  );
  expect(result).toEqual({ ok: true });
  await Bun.sleep(0);
  expect(answersOf(replies[0] as string)).toEqual({ [Q]: B });
});

test("without an index the text counts, as an older phone sends it", async () => {
  const { broker, opened, replies } = ask();
  broker.answer(opened.prompt.id, { kind: "question", answers: { [Q]: B } }, "device:a");
  await Bun.sleep(0);
  expect(answersOf(replies[0] as string)).toEqual({ [Q]: B });
});

test("an index that names no option leaves the text", async () => {
  const { broker, opened, replies } = ask();
  broker.answer(
    opened.prompt.id,
    { kind: "question", answers: { [Q]: "Something else" }, choices: { [Q]: 9 } },
    "device:a",
  );
  await Bun.sleep(0);
  expect(answersOf(replies[0] as string)).toEqual({ [Q]: "Something else" });
});

import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { fitAlert, promptAlert } from "../src/daemon/notifier.ts";

// A question too long for one push goes out cut, with its buttons cut to 40 characters. A button still gives the
// hook the option's full label; typed text still arrives as typed.

const A = "Use the existing Postgres cluster in eu-central-1 with a new schema";
const B = "Use the existing Postgres cluster in eu-west-1 with a new schema";
const LONG = "Which database should the service use? " + "Context: lorem ipsum dolor sit amet. ".repeat(120);

function ask(question: string) {
  const db = openDb(":memory:");
  const broker = new Broker(db, new EventLog(db));
  const opened = broker.open({
    session_id: "s1",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{ question, header: "DB", multiSelect: false, options: [{ label: A }, { label: B }] }],
    },
  } as never);
  const replies: string[] = [];
  void opened.reply.then((r) => replies.push(r.stdout));
  return { broker, opened, replies };
}

const answersOf = (stdout: string) =>
  JSON.parse(stdout).hookSpecificOutput.decision.updatedInput.answers as Record<string, string>;

async function send(index: number | undefined, typed?: string) {
  const { broker, opened, replies } = ask(LONG);
  const data = fitAlert(promptAlert(opened.prompt, "Mac")).data;
  const shown = data.question as string;
  const buttons = data.options as string[];
  const text = typed ?? (buttons[index as number] as string);
  const result = broker.answer(
    opened.prompt.id,
    {
      kind: "question",
      answers: { [shown]: text },
      ...(index === undefined ? {} : { choices: { [shown]: index } }),
    },
    "device:a",
  );
  await Bun.sleep(0);
  return { shown, buttons, result, answers: answersOf(replies[0] as string) };
}

test("a cut question's buttons give the hook each option's full label", async () => {
  for (const [i, label] of [A, B].entries()) {
    const r = await send(i);
    expect(r.shown).not.toBe(LONG);
    expect(r.buttons[0]).toBe(r.buttons[1]);
    expect(r.result).toEqual({ ok: true });
    expect(r.answers).toEqual({ [LONG]: label });
  }
});

test("text typed into a cut question's notification reaches Claude as typed", async () => {
  const r = await send(undefined, "Something else entirely");
  expect(r.result).toEqual({ ok: true });
  expect(r.answers).toEqual({ [LONG]: "Something else entirely" });
});

test("an index that names no option leaves the text", async () => {
  const r = await send(7, "Something else");
  expect(r.result).toEqual({ ok: true });
  expect(r.answers).toEqual({ [LONG]: "Something else" });
});

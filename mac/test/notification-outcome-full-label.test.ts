import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { fitAlert, promptAlert } from "../src/daemon/notifier.ts";

// A notification button carries the option's cut title; the outcome (Inbox history, prompt.closed) names the whole option.

const A = "Use the existing Postgres cluster in eu-central-1 with a new schema";
const B = "Use the existing Postgres cluster in eu-west-1 with a new schema";
const SHORT = "Which database?";
const LONG = `Which database should the service use? ${"Context: lorem ipsum dolor sit amet. ".repeat(120)}`;

function ask(question: string) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const broker = new Broker(db, events);
  const opened = broker.open({
    session_id: "s1",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [{ question, header: "DB", multiSelect: false, options: [{ label: A }, { label: B }] }],
    },
  } as never);
  void opened.reply.then(() => {});
  const data = fitAlert(promptAlert(opened.prompt, "Mac")).data;
  return { events, broker, opened, shown: data.question as string, buttons: data.options as string[] };
}

async function outcomes(f: ReturnType<typeof ask>) {
  await Bun.sleep(0);
  const closed = f.events.since(0).find((e) => e.type === "prompt.closed") as
    | { outcome?: string }
    | undefined;
  return {
    outcome: f.broker.get(f.opened.prompt.id)?.outcome,
    recent: f.broker.listRecent(10)[0]?.outcome,
    event: closed?.outcome,
  };
}

for (const [name, question] of [
  ["short", SHORT],
  ["cut", LONG],
] as const)
  for (const [index, label] of [
    [0, A],
    [1, B],
  ] as const)
    test(`${name} question, button ${index}: the outcome names the whole option`, async () => {
      const f = ask(question);
      const answer = {
        kind: "question" as const,
        answers: { [f.shown]: f.buttons[index] as string },
        choices: { [f.shown]: index },
      };
      expect(f.broker.answer(f.opened.prompt.id, answer, "device:a")).toEqual({ ok: true });
      expect(await outcomes(f)).toEqual({ outcome: label, recent: label, event: label });
      // The phone repeating the notification answer still gets ok.
      expect(f.broker.answer(f.opened.prompt.id, answer, "device:a")).toEqual({ ok: true });
    });

test("a typed answer shows the text as sent", async () => {
  const f = ask(SHORT);
  f.broker.answer(f.opened.prompt.id, { kind: "question", answers: { [f.shown]: "Use SQLite" } }, "device:a");
  expect((await outcomes(f)).outcome).toBe("Use SQLite");
});

test("an index that names no option shows the text as sent", async () => {
  const f = ask(SHORT);
  f.broker.answer(
    f.opened.prompt.id,
    { kind: "question", answers: { [f.shown]: "Something else" }, choices: { [f.shown]: 7 } },
    "device:a",
  );
  expect((await outcomes(f)).outcome).toBe("Something else");
});

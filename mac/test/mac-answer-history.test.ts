// What a question answered at the Mac keeps in the history: whole characters at the 80-character cut, and no secrets,
// whether the answer came from the Mac or the phone.
import { describe, expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";

const QUESTION = { questions: [{ question: "Which?", header: "Q", options: [{ label: "A" }] }] };
function atMac(answers: Record<string, string>) {
  const db = openDb(":memory:");
  const broker = new Broker(db, new EventLog(db));
  const q = broker.open({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: QUESTION });
  broker.settleFromSessionEvent("s1", {
    hookEventName: "PostToolUse",
    toolName: "AskUserQuestion",
    toolInput: { ...QUESTION, answers },
    toolResponse: { answers },
  });
  return broker.listRecent(10).find((p) => p.id === q.prompt.id)?.outcome ?? "";
}

describe("what a question answered at the Mac keeps", () => {
  test("an emoji at the 80-character cut isn't split into half a character", () => {
    const outcome = atMac({ q: `${"a".repeat(78)}👍👍👍` });
    // No lone UTF-16 surrogate: the text is valid when encoded and decoded again.
    expect(new TextDecoder().decode(new TextEncoder().encode(outcome))).toBe(outcome);
  });

  test("a secret typed as a free-text answer at the Mac is redacted before it leaves the Mac", () => {
    const outcome = atMac({ q: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(outcome).not.toContain("sk-ant-api03");
  });

  test("a secret in a phone answer or plan feedback doesn't reach the history either", () => {
    const db = openDb(":memory:");
    const broker = new Broker(db, new EventLog(db));
    const q = broker.open({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: QUESTION });
    broker.answer(
      q.prompt.id,
      { kind: "question", answers: { "Which?": "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } },
      "test",
    );
    expect(broker.listRecent(10)[0]?.outcome).not.toContain("ghp_AAAA");
  });
});

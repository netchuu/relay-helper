import { describe, expect, test } from "bun:test";
import type { Prompt, RelayEvent } from "../../protocol/index.ts";
import { describePrompt, formatEvent } from "../src/tailFormat.ts";

const ev = (e: Record<string, unknown>) => ({ ts: 0, seq: 7, ...e }) as unknown as RelayEvent;
const ID = "0123456789abcdef";
const time = new Date(0).toLocaleTimeString();

describe("formatEvent", () => {
  test("a session upsert names the short id, project and status", () => {
    const line = formatEvent(
      ev({ type: "session.upsert", session: { id: ID, project: "relay", status: "idle" } }),
    );
    expect(line).toBe(`${time} #7 session 01234567 relay → idle`);
  });

  test("background work lists tasks, or says nothing is running", () => {
    const tasks = [
      { kind: "bash", title: "build" },
      { kind: "agent", title: "review" },
    ];
    expect(formatEvent(ev({ type: "session.background", sessionId: ID, tasks }))).toContain(
      "01234567 bash · build, agent · review",
    );
    expect(formatEvent(ev({ type: "session.background", sessionId: ID, tasks: [] }))).toContain(
      "nothing in the background",
    );
  });

  test("a waiting reply shows the reason, or that nothing waits", () => {
    expect(formatEvent(ev({ type: "reply.waiting", sessionId: ID, reason: "rate limit" }))).toContain(
      "waiting: rate limit",
    );
    expect(formatEvent(ev({ type: "reply.waiting", sessionId: ID, reason: null }))).toContain(
      "nothing waiting",
    );
  });

  test("a message that never ran shows its outcome, not its text", () => {
    const line = formatEvent(
      ev({ type: "reply.outcome", sessionId: ID, sendId: "s1", outcome: "blocked", text: "secret reason" }),
    );
    expect(line).toBe(`${time} #7 ⏳ 01234567 message blocked`);
    expect(line).not.toContain("secret reason");
  });

  test("a removed session", () => {
    expect(formatEvent(ev({ type: "session.removed", sessionId: ID }))).toBe(
      `${time} #7 session 01234567 removed`,
    );
  });

  test("a finished turn indents every line of its summary", () => {
    const line = formatEvent(
      ev({
        type: "turn.done",
        turn: { sessionId: ID, stats: { toolCalls: 3, filesEdited: ["a", "b"] }, summary: "one\ntwo" },
      }),
    );
    expect(line).toBe(`${time} #7 ✅ turn done 01234567 (3 tools, 2 files)\n    one\n    two`);
  });

  test("an action prints tool and title, the label when there is no title, and Failed", () => {
    const titled = formatEvent(
      ev({ type: "turn.action", sessionId: ID, step: { title: "a.ts", tool: "Edit" } }),
    );
    expect(titled).toBe(`${time} #7 ▸ 01234567 Edit · a.ts`);
    expect(formatEvent(ev({ type: "turn.action", sessionId: ID, step: { title: "a.ts" } }))).toContain(
      " · a.ts",
    );
    const labelled = formatEvent(
      ev({ type: "turn.action", sessionId: ID, step: { label: "Ran tests", failed: true } }),
    );
    expect(labelled).toBe(`${time} #7 ▸ 01234567 Ran tests · Failed`);
  });

  test("a step prints its label", () => {
    expect(formatEvent(ev({ type: "turn.step", sessionId: ID, step: { label: "Thinking" } }))).toBe(
      `${time} #7 · 01234567 Thinking`,
    );
  });

  test("a message prints its first non-blank line, cut at 100 characters", () => {
    const text = `\n  \nhello there\nsecond`;
    expect(formatEvent(ev({ type: "turn.message", sessionId: ID, message: { text } }))).toBe(
      `${time} #7 💬 01234567 hello there`,
    );
    const long = formatEvent(ev({ type: "turn.message", sessionId: ID, message: { text: "x".repeat(300) } }));
    expect(long.endsWith(`01234567 ${"x".repeat(100)}`)).toBe(true);
  });

  test("a message cut never splits an emoji, and an empty message prints nothing after the id", () => {
    const emoji = formatEvent(
      ev({ type: "turn.message", sessionId: ID, message: { text: "👨‍👩‍👧".repeat(120) } }),
    );
    expect(emoji.endsWith("👨‍👩‍👧")).toBe(true);
    expect([...emoji.split("01234567 ")[1]!.matchAll(/👨‍👩‍👧/g)]).toHaveLength(100);
    expect(formatEvent(ev({ type: "turn.message", sessionId: ID, message: { text: " \n " } }))).toBe(
      `${time} #7 💬 01234567 `,
    );
  });

  test("a started turn shows the first line of the prompt, cut at 80", () => {
    expect(formatEvent(ev({ type: "turn.started", sessionId: ID, prompt: "fix it\nplease" }))).toBe(
      `${time} #7 ▶ turn 01234567: fix it`,
    );
    expect(formatEvent(ev({ type: "turn.started", sessionId: ID, prompt: "y".repeat(200) }))).toContain(
      `: ${"y".repeat(80)}`,
    );
    expect(formatEvent(ev({ type: "turn.started", sessionId: ID, prompt: "" }))).toBe(
      `${time} #7 ▶ turn 01234567: `,
    );
  });

  test("prompt opened and closed", () => {
    const prompt = {
      id: "p1",
      kind: "permission",
      sessionId: ID,
      payload: { kind: "permission", toolName: "Bash", summary: "ls" },
    };
    expect(formatEvent(ev({ type: "prompt.opened", prompt }))).toContain(
      "❓ p1  [permission] session 01234567",
    );
    expect(formatEvent(ev({ type: "prompt.closed", promptId: "p1", resolvedBy: "phone" }))).toBe(
      `${time} #7 prompt p1 closed by phone`,
    );
  });

  test("presence here and away", () => {
    expect(
      formatEvent(ev({ type: "presence.changed", presence: { present: true, mode: "auto" } })),
    ).toContain("presence here (mode auto)");
    expect(
      formatEvent(ev({ type: "presence.changed", presence: { present: false, mode: "away" } })),
    ).toContain("presence away (mode away)");
  });

  test("a notice shows its level", () => {
    expect(formatEvent(ev({ type: "session.notice", sessionId: ID, level: "warn", text: "slow" }))).toBe(
      `${time} #7 [warn] 01234567 slow`,
    );
  });
});

describe("describePrompt", () => {
  const base = { id: "p2", kind: "question", sessionId: ID };
  test("a question numbers its questions, marks multi-select and lists options", () => {
    const p = {
      ...base,
      payload: {
        kind: "question",
        questions: [
          { question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
          { question: "Also?", multiSelect: true, options: [{ label: "C" }] },
        ],
      },
    } as unknown as Prompt;
    expect(describePrompt(p)).toBe(
      "p2  [question] session 01234567\n  1. Which?: A | B\n  2. Also? (multi): C",
    );
  });

  test("a question without questions prints only the head line", () => {
    const p = { ...base, payload: { kind: "question", questions: [] } } as unknown as Prompt;
    expect(describePrompt(p)).toBe("p2  [question] session 01234567\n");
  });

  test("a plan shows its first eight lines", () => {
    const plan = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`).join("\n");
    const out = describePrompt({
      ...base,
      kind: "plan",
      payload: { kind: "plan", plan },
    } as unknown as Prompt);
    expect(out).toContain("step 8");
    expect(out).not.toContain("step 9");
    expect(out.split("\n")[1]).toBe("  step 1");
  });

  test("a permission shows the tool and its summary", () => {
    const out = describePrompt({
      ...base,
      kind: "permission",
      payload: { kind: "permission", toolName: "Edit", summary: "a.ts" },
    } as unknown as Prompt);
    expect(out).toBe("p2  [permission] session 01234567\n  Edit: a.ts");
  });
});

import { describe, expect, test } from "bun:test";
import type { Turn } from "../../protocol/index.ts";
import { promptAlert, turnAlert } from "../src/daemon/notifier.ts";
import { compact, firstLine } from "../src/daemon/render.ts";
import { head } from "../src/daemon/text.ts";

describe("cuts land on whole characters", () => {
  test("head backs off a surrogate pair and leaves other cuts alone", () => {
    expect(head("ab😀cd", 3)).toBe("ab");
    expect(head("ab😀cd", 4)).toBe("ab😀");
    expect(head("abcdef", 3)).toBe("abc");
    expect(head("abc", 10)).toBe("abc");
    expect(head("abc", 0)).toBe("");
  });

  test("compact", () => {
    const a = compact("字".repeat(599) + "😀" + "字".repeat(50), 600);
    expect(a.text.isWellFormed()).toBe(true);
    expect(compact("Done " + "🎉".repeat(400), 600).text.isWellFormed()).toBe(true);
    expect(compact("x".repeat(700), 600).text).toBe(`${"x".repeat(600)} …`);
  });

  test("firstLine", () => {
    expect(firstLine("a".repeat(138) + "😀 tail", 140).isWellFormed()).toBe(true);
    expect(firstLine("a".repeat(200), 140)).toBe(`${"a".repeat(139)}…`);
  });

  test("notification text", () => {
    const turn = { summary: "a".repeat(178) + "😀 tail", stopped: false } as unknown as Turn;
    expect(turnAlert(turn, "s").body.isWellFormed()).toBe(true);
    const prompt = {
      sessionId: "s",
      kind: "question",
      payload: { kind: "question", questions: [{ question: "a".repeat(178) + "😀 tail", options: [] }] },
    } as unknown as Parameters<typeof promptAlert>[0];
    expect(promptAlert(prompt, "s").body.isWellFormed()).toBe(true);
  });
});

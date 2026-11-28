import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withoutIdeContext } from "../src/daemon/render.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";

const close = (id: string) => `</pasted_content id="${id}">`;

describe("pasted text shown without its wrapper", () => {
  test("prompts as Claude Code wrote them to a transcript", () => {
    const turns = transcriptTurns("paste", join(import.meta.dir, "fixtures", "pasted-content.jsonl"), {
      limit: 10,
      previewChars: 600,
      working: false,
      cwd: "/Users/me/Projects/scratch",
    }).reverse();
    expect(turns.map((t) => t.prompt)).toEqual([
      "line one\nline two",
      "Compare these\n\nfirst\n\nand\n\nsecond\n\nplease",
      "update these also \n\nline one\n\n, and think",
    ]);
  });

  test("a message that is only a paste", () => {
    expect(withoutIdeContext(`<pasted_content id="0952">\nline one\nline two\n${close("0952")}`)).toBe(
      "line one\nline two",
    );
  });

  test("a pasted line that looks like a bare close tag does not end the block", () => {
    const prompt = `<pasted_content id="1a1f">\nbefore\n</pasted_content>\nafter\n${close("1a1f")}`;
    expect(withoutIdeContext(prompt)).toBe("before\n</pasted_content>\nafter");
  });

  test("after IDE context, with Windows line breaks", () => {
    const prompt = `<ide_opened_file>The user opened /a.ts</ide_opened_file>\r\n<pasted_content id="7">\r\nlog\r\n${close("7")}`;
    expect(withoutIdeContext(prompt)).toBe("log");
  });

  test("a mention in prose or code keeps the tag", () => {
    for (const text of [
      `Claude wraps pastes in <pasted_content id="1"> and closes with ${close("1")} doesn't it?`,
      `Use \`<pasted_content id="1">x${close("1")}\` in the parser`,
      'An open tag alone:\n<pasted_content id="1">\nno close',
    ])
      expect(withoutIdeContext(text)).toBe(text);
  });
});

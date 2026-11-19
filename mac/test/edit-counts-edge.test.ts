import { describe, expect, test } from "bun:test";
import { actionFields, editCounts, lineCount } from "../src/daemon/timeline.ts";

// Line counts for unusual line endings and inputs: whatever the text, only two numbers leave the Mac.

const FILE = "/work/app/src/cart.ts";

describe("line endings", () => {
  test("Windows line endings count like line feeds", () => {
    const cases: [string, number][] = [
      ["a\r\nb", 2],
      ["a\r\nb\r\n", 2],
      ["a\r\n\r\nb", 3],
      ["\r\n", 1],
      ["\r\n\r\n", 2],
      ["a\r\n\r\n", 2],
    ];
    for (const [text, lines] of cases) expect([text, lineCount(text)]).toEqual([text, lines]);
  });

  test("a string of only line feeds has one line per line feed", () => {
    for (const n of [1, 2, 3, 10, 1000]) expect([n, lineCount("\n".repeat(n))]).toEqual([n, n]);
  });

  test("a very long single line is one line", () => {
    expect(lineCount("x".repeat(1_000_000))).toBe(1);
    expect(lineCount(`${"x".repeat(1_000_000)}\n`)).toBe(1);
    expect(lineCount(`${"x".repeat(500_000)}\n${"y".repeat(500_000)}`)).toBe(2);
  });

  test("a very long text of many lines counts them all", () => {
    expect(lineCount("a\n".repeat(200_000))).toBe(200_000);
    expect(lineCount(`${"a\n".repeat(200_000)}b`)).toBe(200_001);
  });

  test("whitespace and tabs on one line are one line", () => {
    expect(lineCount("\t")).toBe(1);
    expect(lineCount(" \t ")).toBe(1);
    expect(lineCount("é🙂‮مرحبا")).toBe(1);
    expect(lineCount("🙂\nمرحبا\nשלום")).toBe(3);
  });
});

describe("unusual inputs", () => {
  test("Edit with Windows line endings counts both sides the same way", () => {
    expect(editCounts("Edit", { old_string: "a\r\nb\r\n", new_string: "x\r\ny\r\nz" })).toEqual({
      added: 3,
      removed: 2,
    });
  });

  test("Edit with only line feeds on each side", () => {
    expect(editCounts("Edit", { old_string: "\n\n", new_string: "\n" })).toEqual({ added: 1, removed: 2 });
  });

  test("MultiEdit with one empty edit counts zero on both sides and sends it", () => {
    expect(editCounts("MultiEdit", { edits: [{ old_string: "", new_string: "" }] })).toEqual({
      added: 0,
      removed: 0,
    });
  });

  test("MultiEdit with an empty edit among others adds nothing for it", () => {
    expect(
      editCounts("MultiEdit", {
        edits: [
          { old_string: "a\nb", new_string: "c" },
          { old_string: "", new_string: "" },
        ],
      }),
    ).toEqual({ added: 1, removed: 2 });
  });

  test("MultiEdit with an edit that is an empty object has no counts", () => {
    expect(editCounts("MultiEdit", { edits: [{}] })).toEqual({});
    expect(editCounts("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, {}] })).toEqual({});
  });

  test("replace_all gives the same numbers as one occurrence", () => {
    const strings = { old_string: "a\nb\nc", new_string: "x\ny" };
    expect(editCounts("Edit", { ...strings, replace_all: true })).toEqual(editCounts("Edit", strings));
    expect(editCounts("Edit", { ...strings, replace_all: true })).toEqual({ added: 2, removed: 3 });
    expect(editCounts("Edit", { ...strings, replace_all: false })).toEqual({ added: 2, removed: 3 });
    expect(editCounts("MultiEdit", { edits: [{ ...strings, replace_all: true }, { ...strings }] })).toEqual({
      added: 4,
      removed: 6,
    });
  });

  test("Write with empty content sends added 0 and no removed", () => {
    const counts = editCounts("Write", { file_path: FILE, content: "" });
    expect(counts).toEqual({ added: 0 });
    expect("removed" in counts).toBe(false);
  });

  test("Write never has removed, whatever else the input carries", () => {
    const counts = editCounts("Write", { content: "a\nb", old_string: "x\ny\nz", new_string: "q" });
    expect(counts).toEqual({ added: 2 });
  });

  test("a tool input that is not an object has no counts and does not throw", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      "a\nb",
      5,
      true,
      [],
      ["a"],
      [{ old_string: "a", new_string: "b" }],
    ];
    for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"])
      for (const input of inputs)
        expect([tool, input, editCounts(tool, input as Record<string, unknown>)]).toEqual([tool, input, {}]);
  });

  test("an input that is not an object gives a step without counts", () => {
    for (const input of [null, "text", 7, []]) {
      const fields = actionFields("Edit", input as unknown as Record<string, unknown>, null);
      expect([input, fields.added, fields.removed]).toEqual([input, undefined, undefined]);
    }
  });

  test("numbers and arrays where strings belong have no counts", () => {
    expect(editCounts("Edit", { old_string: ["a"], new_string: ["b"] })).toEqual({});
    expect(editCounts("Edit", { old_string: 1, new_string: 2 })).toEqual({});
    expect(editCounts("Write", { content: 42 })).toEqual({});
    expect(editCounts("NotebookEdit", { new_source: ["x = 1"] })).toEqual({});
    expect(editCounts("MultiEdit", { edits: { old_string: "a", new_string: "b" } })).toEqual({});
  });
});

describe("counts stay on edit tools and never carry the text", () => {
  const input = {
    file_path: FILE,
    old_string: "a\nb",
    new_string: "c",
    content: "d\ne\nf",
    new_source: "g",
    edits: [{ old_string: "h", new_string: "i" }],
    command: "ls\npwd",
    pattern: "j\nk",
  };

  test("no other tool gets counts, whatever its input carries", () => {
    const tools = [
      "Read",
      "Bash",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
      "TodoWrite",
      "Skill",
      "mcp__fs__Write",
      "",
    ];
    for (const tool of tools) {
      const fields = actionFields(tool, input, "/work/app");
      expect([tool, "added" in fields, "removed" in fields]).toEqual([tool, false, false]);
      expect(editCounts(tool, input)).toEqual({});
    }
  });

  test("no fragment of the replaced or replacing text is in the serialized step", () => {
    const texts = {
      old_string: "OLD_FRAGMENT_1\nOLD_FRAGMENT_2",
      new_string: "NEW_FRAGMENT_1\nNEW_FRAGMENT_2",
      content: "CONTENT_FRAGMENT_1\nCONTENT_FRAGMENT_2",
      new_source: "SOURCE_FRAGMENT",
    };
    const calls: [string, Record<string, unknown>][] = [
      ["Edit", { file_path: FILE, old_string: texts.old_string, new_string: texts.new_string }],
      [
        "Edit",
        { file_path: FILE, old_string: texts.old_string, new_string: texts.new_string, replace_all: true },
      ],
      [
        "MultiEdit",
        { file_path: FILE, edits: [{ old_string: texts.old_string, new_string: texts.new_string }] },
      ],
      ["Write", { file_path: FILE, content: texts.content }],
      ["NotebookEdit", { notebook_path: "/work/app/a.ipynb", new_source: texts.new_source }],
    ];
    for (const [tool, call] of calls) {
      const json = JSON.stringify(actionFields(tool, call, "/work/app"));
      expect([tool, /FRAGMENT/.test(json)]).toEqual([tool, false]);
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayEvent, type Turn, TurnStep } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { actionFields, editCounts, lineCount, TimelineReader } from "../src/daemon/timeline.ts";

// An edit step says how many lines it put in and took out: the two numbers, never the text.

const CWD = "/Users/me/Projects/my-app";
const FILE = `${CWD}/src/cart.ts`;
const OLD = "MARKER_OLD_TEXT";
const NEW = "MARKER_NEW_TEXT";

describe("counting lines", () => {
  test("an empty text has none, and a line break at the end doesn't start a line", () => {
    const cases: [string, number][] = [
      ["", 0],
      ["a", 1],
      ["a\n", 1],
      ["a\nb", 2],
      ["a\nb\n", 2],
      ["a\nb\nc", 3],
      ["\n", 1],
      ["a\n\n", 2],
      ["\n\n\n", 3],
      ["a\r\nb\r\n", 2],
      ["  ", 1],
    ];
    for (const [text, lines] of cases) expect([text, lineCount(text)]).toEqual([text, lines]);
  });
});

describe("what each tool counts", () => {
  test("Edit: the lines of the new and of the old text", () => {
    expect(editCounts("Edit", { file_path: FILE, old_string: "a", new_string: "b" })).toEqual({
      added: 1,
      removed: 1,
    });
    expect(editCounts("Edit", { file_path: FILE, old_string: "a\nb\nc\n", new_string: "x\ny" })).toEqual({
      added: 2,
      removed: 3,
    });
  });

  test("Edit: an empty text counts 0, and 0 is sent", () => {
    expect(editCounts("Edit", { old_string: "a\nb", new_string: "" })).toEqual({ added: 0, removed: 2 });
    expect(editCounts("Edit", { old_string: "", new_string: "a\nb\n" })).toEqual({ added: 2, removed: 0 });
    expect(editCounts("Edit", { old_string: "", new_string: "" })).toEqual({ added: 0, removed: 0 });
  });

  test("Edit with replace_all counts one occurrence", () => {
    expect(editCounts("Edit", { old_string: "a\nb", new_string: "c", replace_all: true })).toEqual({
      added: 1,
      removed: 2,
    });
  });

  test("MultiEdit sums its edits", () => {
    expect(
      editCounts("MultiEdit", {
        file_path: FILE,
        edits: [
          { old_string: "a\nb", new_string: "c" },
          { old_string: "", new_string: "d\ne\nf\n" },
          { old_string: "g\n", new_string: "", replace_all: true },
        ],
      }),
    ).toEqual({ added: 4, removed: 3 });
  });

  test("Write counts the content's lines and has no removed", () => {
    expect(editCounts("Write", { file_path: FILE, content: "a\nb\nc\n" })).toEqual({ added: 3 });
    expect(editCounts("Write", { file_path: FILE, content: "one line" })).toEqual({ added: 1 });
    expect(editCounts("Write", { file_path: FILE, content: "" })).toEqual({ added: 0 });
  });

  test("NotebookEdit counts the new source; a deleted cell has no counts", () => {
    expect(editCounts("NotebookEdit", { notebook_path: "a.ipynb", new_source: "x = 1\ny = 2" })).toEqual({
      added: 2,
    });
    expect(
      editCounts("NotebookEdit", { notebook_path: "a.ipynb", new_source: "z", edit_mode: "insert" }),
    ).toEqual({ added: 1 });
    expect(
      editCounts("NotebookEdit", { notebook_path: "a.ipynb", new_source: "", edit_mode: "delete" }),
    ).toEqual({});
  });

  test("input the helper can't count has no counts", () => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      ["Edit", undefined],
      ["Edit", { file_path: FILE }],
      ["Edit", { old_string: "a" }],
      ["Edit", { old_string: "a", new_string: 5 }],
      ["MultiEdit", {}],
      ["MultiEdit", { edits: [] }],
      ["MultiEdit", { edits: "a\nb" }],
      ["MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, null] }],
      ["MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c" }] }],
      ["Write", { file_path: FILE }],
      ["Write", { content: ["a", "b"] }],
      ["NotebookEdit", { notebook_path: "a.ipynb" }],
    ];
    for (const [tool, input] of cases)
      expect([tool, input, editCounts(tool, input)]).toEqual([tool, input, {}]);
  });

  test("other tools have no counts, whatever their input", () => {
    const input = { old_string: "a", new_string: "b", content: "c\nd", command: "ls\npwd", file_path: FILE };
    for (const tool of ["Read", "Bash", "Grep", "Glob", "WebFetch", "Agent", "TodoWrite", "mcp__fs__Edit"]) {
      const fields = actionFields(tool, input, CWD);
      expect([tool, fields.added, fields.removed]).toEqual([tool, undefined, undefined]);
    }
  });

  test("the step's fields carry the numbers next to the path, and nothing of the text", () => {
    const fields = actionFields(
      "Edit",
      { file_path: FILE, old_string: `${OLD}\n${OLD}`, new_string: NEW },
      CWD,
    );
    expect(fields).toEqual({ tool: "Edit", detail: "src/cart.ts", added: 1, removed: 2 });
    expect(JSON.stringify(fields)).not.toContain("MARKER");
  });
});

describe("the protocol", () => {
  const step = { kind: "edit" as const, label: "Edited src/cart.ts", at: 1, id: "e", tool: "Edit" };

  test("a step without the fields still parses, and one with them keeps them", () => {
    expect(TurnStep.parse(step)).toEqual(step);
    expect(TurnStep.parse({ ...step, added: 48, removed: 6 })).toMatchObject({ added: 48, removed: 6 });
    expect(TurnStep.parse({ ...step, added: 12 }).removed).toBeUndefined();
    expect(TurnStep.parse({ ...step, added: 0, removed: 0 })).toMatchObject({ added: 0, removed: 0 });
  });

  test("counts are whole and not negative", () => {
    for (const bad of [-1, 1.5, "3", null, Number.NaN])
      for (const field of ["added", "removed"])
        expect([bad, field, TurnStep.safeParse({ ...step, [field]: bad }).success]).toEqual([
          bad,
          field,
          false,
        ]);
  });
});

const iso = (ms: number) => new Date(ms).toISOString();
const use = (id: string, name: string, input: object, at: number, extra: object = {}) => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name, input }] },
  ...extra,
});
const result = (id: string, isError: boolean, at: number) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "OUTPUT TEXT" }] },
});

const EDITS: [string, string, object, { added?: number; removed?: number }][] = [
  [
    "e",
    "Edit",
    { file_path: FILE, old_string: `${OLD}\n${OLD}\n`, new_string: `${NEW}\n${NEW}\n${NEW}` },
    { added: 3, removed: 2 },
  ],
  [
    "m",
    "MultiEdit",
    {
      file_path: FILE,
      edits: [
        { old_string: OLD, new_string: `${NEW}\n${NEW}` },
        { old_string: `${OLD}\n${OLD}`, new_string: "" },
      ],
    },
    { added: 2, removed: 3 },
  ],
  ["w", "Write", { file_path: FILE, content: `${NEW}\n${NEW}\n` }, { added: 2 }],
  [
    "n",
    "NotebookEdit",
    { notebook_path: `${CWD}/a.ipynb`, new_source: `${NEW}\n${NEW}\n${NEW}` },
    { added: 3 },
  ],
];
const counts = (s: TurnStep | undefined) => ({
  ...(s?.added !== undefined ? { added: s.added } : {}),
  ...(s?.removed !== undefined ? { removed: s.removed } : {}),
});

describe("the timeline reader", () => {
  test("an edit keeps its counts when it worked and drops them when it failed", () => {
    const r = new TimelineReader(CWD, 0);
    const [sent] = r.add(use("ok", "Edit", { file_path: FILE, old_string: "a\nb", new_string: "c" }, 10));
    expect(sent).toMatchObject({ kind: "edit", id: "ok", added: 1, removed: 2 });
    expect(r.add(result("ok", false, 20)).map((x) => x.id)).toEqual(["ok"]);
    expect(counts(r.actions[0])).toEqual({ added: 1, removed: 2 });

    r.add(use("bad", "Write", { file_path: FILE, content: "a\nb" }, 30));
    expect(counts(r.actions[1])).toEqual({ added: 2 });
    const [again] = r.add(result("bad", true, 40));
    expect(again).toMatchObject({ id: "bad", failed: true });
    expect(again).not.toHaveProperty("added");
    expect(again).not.toHaveProperty("removed");
    expect(TurnStep.safeParse(again).success).toBe(true);
  });

  test("an agent's own edits carry their counts in its steps, without the text", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-edit-counts-agent-"));
    dirs.push(dir);
    const path = join(dir, "sess.jsonl");
    const subs = join(dir, "sess", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(use("toolu_A", "Agent", { description: "Fix", prompt: "p" }, 0))}\n`,
    );
    writeFileSync(
      join(subs, "agent-a1.meta.json"),
      JSON.stringify({ toolUseId: "toolu_A", finished: false }),
    );
    writeFileSync(
      join(subs, "agent-a1.jsonl"),
      `${JSON.stringify(
        use("sub1", "Edit", { file_path: FILE, old_string: OLD, new_string: `${NEW}\n${NEW}` }, 1000, {
          isSidechain: true,
          agentId: "a1",
        }),
      )}\n`,
    );
    const reader = new TimelineReader(CWD, 0, { transcriptPath: path });
    reader.add(JSON.parse(readFileSync(path, "utf8")));
    reader.refreshAgents();
    const agent = reader.actions[0] as TurnStep;
    expect(agent).not.toHaveProperty("added");
    expect(agent.children).toHaveLength(1);
    expect(counts(agent.children?.[0])).toEqual({ added: 2, removed: 1 });
    expect(JSON.stringify(agent)).not.toContain("MARKER");
    expect(TurnStep.safeParse(agent).success).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-edit-counts-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: 0 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: "s1", cwd: CWD, transcript_path: path, ...fields },
        env: {},
      },
      new AbortController().signal,
    );
  const append = (...lines: object[]) =>
    appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const actions = () => seen.flatMap((e) => (e.type === "turn.action" ? [e] : []));
  const done = () =>
    (seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>).turn;
  const liveActions = async () => {
    const live = await rpc("session.live", { sessionId: "s1" }, "device:x");
    return ("result" in live ? (live.result as { actions?: TurnStep[] }).actions : undefined) ?? [];
  };
  const storedTurn = async () => {
    const res = await rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    return "result" in res ? (res.result as Turn[])[0] : undefined;
  };
  return { hook, append, actions, done, liveActions, storedTurn, seen };
}

const hookTool = (id: string, name: string, input: object) => ({
  tool_use_id: id,
  tool_name: name,
  tool_input: input,
});

describe("live and finished", () => {
  test("the live event, session.live, the finished turn and the stored turn agree, under the same id", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Fix it" });
    const s = Date.now();
    t.append(
      ...EDITS.flatMap(([id, name, input], i) => [
        use(id, name, input, s + 100 * (i + 1)),
        result(id, false, s + 100 * (i + 1) + 50),
      ]),
      use("r", "Read", { file_path: FILE }, s + 900),
      result("r", false, s + 950),
    );
    await t.hook("PreToolUse", hookTool("e", "Edit", EDITS[0]?.[2] ?? {}));
    const expected = [...EDITS.map(([id, , , c]) => [id, "edit", c]), ["r", "read", {}]];
    const shape = (steps: TurnStep[] | undefined) => steps?.map((x) => [x.id, x.kind, counts(x)]);

    const live = [...new Map(t.actions().map((e) => [e.step.id, e.step])).values()];
    expect(shape(live)).toEqual(expected);
    expect(shape(await t.liveActions())).toEqual(expected);

    await t.hook("Stop", { last_assistant_message: "Done." });
    const turn = t.done();
    expect(shape(turn.steps)).toEqual(expected);
    expect(shape((await t.storedTurn())?.steps)).toEqual(expected);

    for (const step of [...live, ...(turn.steps ?? [])]) expect(TurnStep.safeParse(step).success).toBe(true);
    expect(JSON.stringify(t.seen)).not.toContain("MARKER");
    expect(JSON.stringify(await t.storedTurn())).not.toContain("MARKER");
  });

  test("a failed edit is sent again without its counts, and the finished turn has none", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Fix it" });
    const s = Date.now();
    const input = { file_path: FILE, old_string: `${OLD}\n${OLD}`, new_string: NEW };
    t.append(use("f", "Edit", input, s + 100));
    await t.hook("PreToolUse", hookTool("f", "Edit", input));
    t.append(result("f", true, s + 200));
    await t.hook("PostToolUseFailure", hookTool("f", "Edit", input));
    expect(t.actions().map((e) => [e.step.id, e.step.failed ?? false, counts(e.step)])).toEqual([
      ["f", false, { added: 1, removed: 2 }],
      ["f", true, {}],
    ]);
    expect((await t.liveActions()).map((x) => [x.id, counts(x)])).toEqual([["f", {}]]);
    await t.hook("Stop", { last_assistant_message: "Could not." });
    expect(t.done().steps?.map((x) => [x.id, x.failed, counts(x)])).toEqual([["f", true, {}]]);
    expect(JSON.stringify(t.seen)).not.toContain("MARKER");
  });

  test("without a transcript, the hooks' steps carry the same counts, and a failed one none", async () => {
    const t = setup();
    const none = { transcript_path: "/nonexistent.jsonl" };
    await t.hook("UserPromptSubmit", { prompt: "x", ...none });
    for (const [id, name, input] of EDITS) {
      await t.hook("PreToolUse", { ...hookTool(id, name, input), ...none });
      await t.hook("PostToolUse", { ...hookTool(id, name, input), ...none });
    }
    const failing = hookTool("f", "Edit", { file_path: FILE, old_string: OLD, new_string: NEW });
    await t.hook("PreToolUse", { ...failing, ...none });
    await t.hook("PostToolUseFailure", { ...failing, ...none });
    await t.hook("Stop", { last_assistant_message: "Done.", ...none });
    const steps = t.done().steps ?? [];
    expect(steps.map((x) => [x.id, x.kind, counts(x)])).toEqual([
      ...EDITS.map(([id, , , c]) => [id, "edit", c]),
      ["f", "edit", {}],
    ]);
    expect(steps.at(-1)?.failed).toBe(true);
    for (const step of steps) expect(TurnStep.safeParse(step).success).toBe(true);
    expect(JSON.stringify(t.seen)).not.toContain("MARKER");
  });
});

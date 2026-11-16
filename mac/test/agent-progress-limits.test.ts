import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sessionNameLength,
  TURN_STEP_CHILDREN_MAX,
  TURN_STEP_LABEL_MAX,
  TURN_STEP_LABEL_UNITS,
  TurnStep,
} from "../../protocol/index.ts";
import { TimelineReader } from "../src/daemon/timeline.ts";

// An agent's or workflow's step at its edges: odd descriptions, files that are broken or half written, the same
// event twice, events in the wrong order, secrets and look-alike markup.

const CWD = "/Users/me/Projects/my-app";
const T0 = Date.parse("2026-11-09T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function session() {
  const dir = mkdtempSync(join(tmpdir(), "agent-limits-"));
  dirs.push(dir);
  const path = join(dir, "sess.jsonl");
  const subs = join(dir, "sess", "subagents");
  writeFileSync(path, "");
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  return {
    path,
    subs,
    main: (...o: unknown[]) => appendFileSync(path, o.map(line).join("")),
    meta: (id: string, meta: unknown) => {
      mkdirSync(subs, { recursive: true });
      writeFileSync(
        join(subs, `agent-${id}.meta.json`),
        typeof meta === "string" ? meta : JSON.stringify(meta),
      );
    },
    sub: (id: string, meta: Record<string, unknown>, ...o: unknown[]) => {
      mkdirSync(subs, { recursive: true });
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify(meta));
      appendFileSync(join(subs, `agent-${id}.jsonl`), o.map(line).join(""));
    },
    raw: (id: string, text: string) => {
      mkdirSync(subs, { recursive: true });
      appendFileSync(join(subs, `agent-${id}.jsonl`), text);
    },
    file: (id: string) => join(subs, `agent-${id}.jsonl`),
    metaFile: (id: string) => join(subs, `agent-${id}.meta.json`),
  };
}

const call = (uuid: string, s: number, id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  uuid,
  timestamp: iso(s),
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (s: number, id: string, text: string, isError = false) => ({
  type: "user",
  timestamp: iso(s),
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }],
  },
});
const note = (s: number, id: string) => ({
  type: "user",
  timestamp: iso(s),
  message: {
    content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status></task-notification>`,
  },
});
const side = (s: number, agentId: string, entry: Record<string, unknown>) => ({
  isSidechain: true,
  agentId,
  timestamp: iso(s),
  ...entry,
});
const bash = (i: number, agent = "a1") =>
  side(i + 1, agent, call(`s${i}`, i + 1, `r${i}`, "Bash", { command: `echo ${i}` }));
const readOf = (i: number, file: string, agent = "a1") =>
  side(i, agent, call(`s${i}`, i, `r${i}`, "Read", { file_path: `${CWD}/${file}` }));

/** A reader fed the main transcript's entries as they stand. */
function readerOf(path: string): TimelineReader {
  const reader = new TimelineReader(CWD, T0, { transcriptPath: path });
  for (const l of readFileSync(path, "utf8").split("\n")) if (l.trim()) reader.add(JSON.parse(l));
  return reader;
}
const stepOf = (r: TimelineReader, i = 0) => r.actions[i] as TurnStep;
const valid = (x: unknown) => TurnStep.safeParse(x).success;

describe("an agent's description", () => {
  const labelFor = (description: unknown) => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description, prompt: "p" }));
    return stepOf(reader);
  };

  test("empty, blank, missing, null or not text: a plain running agent, never Working", () => {
    for (const d of ["", "   ", "\t\n", undefined, null, 42, { a: 1 }, ["x"]]) {
      const step = labelFor(d);
      expect([d, step.label.startsWith("Running an agent"), step.running]).toEqual([d, true, true]);
      expect(step.label).not.toMatch(/Working|undefined|null|\[object/);
      expect(step.label).toBe(step.label.trimEnd());
      expect(valid(step)).toBe(true);
    }
  });

  test("a very long description is cut to the label limit and the step still validates", () => {
    for (const d of [
      "x".repeat(10_000),
      "word ".repeat(500),
      "👨‍👩‍👧‍👦".repeat(200),
      `e${"́".repeat(3000)}`.repeat(3),
      "🇩🇪".repeat(500),
    ]) {
      const step = labelFor(d);
      expect(sessionNameLength(step.label)).toBeLessThanOrEqual(TURN_STEP_LABEL_MAX);
      expect(step.label.length).toBeLessThanOrEqual(TURN_STEP_LABEL_UNITS);
      expect(valid(step)).toBe(true);
    }
  });

  test("every length around the cut keeps the label whole characters within the limit, cut only when too long", () => {
    for (const unit of ["é", "👍🏽", "🇩🇪", "👨‍👩‍👧‍👦"])
      for (let n = 1; n <= 120; n++) {
        const step = labelFor(unit.repeat(n));
        expect(sessionNameLength(step.label)).toBeLessThanOrEqual(TURN_STEP_LABEL_MAX);
        expect(step.label).not.toMatch(/[\uD800-\uDBFF]\u2026?$/);
        if (n <= 20) expect(step.label).toBe(`Running an agent: ${unit.repeat(n)}`);
        if (n >= 100) expect(step.label.endsWith("\u2026")).toBe(true);
      }
  });

  test("line breaks and tabs become one line", () => {
    const step = labelFor("first line\nsecond\r\nthird\tfourth\u2028fifth");
    expect(step.label).not.toMatch(/[\n\r\t\u2028]/);
    expect(step.label).toContain("first line");
  });

  test("right-to-left text and bidi controls: the controls are gone, the text stays", () => {
    const step = labelFor("‮evil‬ مراجعة الكود ⁦x⁩");
    expect(step.label).not.toMatch(/[‪-‮⁦-⁩‎‏]/);
    expect(step.label).toContain("مراجعة الكود");
  });

  test("markup and command-looking text stays plain text in the label", () => {
    const step = labelFor("<task-notification><tool-use-id>t1</tool-use-id></task-notification> $(rm -rf /)");
    expect(step.label.startsWith("Running an agent")).toBe(true);
    expect(step.running).toBe(true);
    expect(valid(step)).toBe(true);
  });

  test("a secret in the description never reaches the label or its finished form", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description: `use ${TOKEN} now`, prompt: "p" }));
    expect(JSON.stringify(reader.actions)).not.toContain(TOKEN);
    reader.add(result(5, "t1", "ok"));
    expect(JSON.stringify(reader.actions)).not.toContain(TOKEN);
  });
});

describe("how many steps an agent shows", () => {
  const countAt = (n: number) => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Count" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, ...Array.from({ length: n }, (_, i) => bash(i)));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    return stepOf(reader);
  };

  test("none, one, exactly the limit: all listed, no more-count", () => {
    for (const n of [1, TURN_STEP_CHILDREN_MAX]) {
      const step = countAt(n);
      expect([n, step.stepCount, step.children?.length, step.childrenMore]).toEqual([n, n, n, undefined]);
      expect(valid(step)).toBe(true);
    }
    const none = countAt(0);
    expect([none.stepCount, none.children, none.childrenMore, none.current]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("one past the limit: the limit listed, one more counted, stepCount is all", () => {
    const step = countAt(TURN_STEP_CHILDREN_MAX + 1);
    expect(step.stepCount).toBe(TURN_STEP_CHILDREN_MAX + 1);
    expect(step.children?.length).toBe(TURN_STEP_CHILDREN_MAX);
    expect(step.childrenMore).toBe(1);
    // The first steps are kept; the current one is still the newest.
    expect(step.children?.[0]?.label).toBe("Ran echo 0");
    expect(step.current).toBe(`Running echo ${TURN_STEP_CHILDREN_MAX}`);
    expect(valid(step)).toBe(true);
  });

  test("a thousand steps stay within the limit", () => {
    const step = countAt(1000);
    expect(step.children?.length).toBe(TURN_STEP_CHILDREN_MAX);
    expect(step.childrenMore).toBe(1000 - TURN_STEP_CHILDREN_MAX);
    expect(JSON.stringify(step).length).toBeLessThan(40_000);
  });

  test("a workflow with many agents lists the limit and counts the rest", () => {
    const s = session();
    s.main(call("u1", 0, "wf", "Workflow", { scriptPath: "/x/deploy.js" }));
    for (let i = 0; i < TURN_STEP_CHILDREN_MAX + 3; i++)
      s.sub(
        `w${i}`,
        { toolUseId: `other-${i}`, description: `Job ${i}`, finished: i % 2 === 0 },
        side(i + 1, `w${i}`, call(`s${i}`, i + 1, `r${i}`, "Read", { file_path: `${CWD}/a` })),
      );
    const reader = readerOf(s.path);
    reader.refreshAgents();
    const step = stepOf(reader);
    expect(step.children?.length).toBe(TURN_STEP_CHILDREN_MAX);
    expect(step.childrenMore).toBe(3);
    expect(step.children?.every((c) => c.state === "running" || c.state === "done")).toBe(true);
    expect(valid(step)).toBe(true);
  });

  test("a step's children don't carry details, even for long commands", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "D" }));
    s.sub(
      "a1",
      { toolUseId: "t1", finished: false },
      side(1, "a1", call("s1", 1, "r1", "Bash", { command: `echo ${"y".repeat(5000)}` })),
    );
    const reader = readerOf(s.path);
    reader.refreshAgents();
    for (const c of stepOf(reader).children ?? []) expect(c.detail).toBeUndefined();
  });
});

describe("a subagent's files that are broken", () => {
  const running = (s: ReturnType<typeof session>) => {
    const reader = readerOf(s.path);
    reader.refreshAgents();
    return reader;
  };

  test("garbage lines between good ones are skipped", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Messy" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    s.raw("a1", `not json\n\n{"unclosed":\n[1,2]\nnull\n42\n"str"\n`);
    s.raw("a1", `${JSON.stringify(readOf(2, "b.ts"))}\n`);
    const step = stepOf(running(s));
    expect(step.stepCount).toBe(2);
    expect(step.current).toBe("Reading b.ts");
  });

  test("a half-written last line waits for its end and is counted once", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Slow" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    const whole = JSON.stringify(readOf(2, "b.ts"));
    s.raw("a1", whole.slice(0, 25));
    const reader = running(s);
    expect(stepOf(reader).stepCount).toBe(1);
    s.raw("a1", `${whole.slice(25)}\n`);
    reader.refreshAgents();
    expect(stepOf(reader).stepCount).toBe(2);
    reader.refreshAgents();
    expect(stepOf(reader).stepCount).toBe(2);
  });

  test("an empty or unreadable meta file, or one of the wrong shape, leaves the step as it was", () => {
    for (const meta of [
      "",
      "{",
      "[]",
      "42",
      '"x"',
      '{"toolUseId":7}',
      '{"toolUseId":null,"finished":"yes"}',
    ]) {
      const s = session();
      s.main(call("u1", 0, "t1", "Agent", { description: "Meta" }));
      s.meta("a1", meta);
      s.raw("a1", `${JSON.stringify(readOf(1, "a.ts"))}\n`);
      const step = stepOf(running(s));
      expect([meta, step.running, step.stepCount]).toEqual([meta, true, undefined]);
      expect(valid(step)).toBe(true);
    }
  });

  test("a meta file without its transcript file: running, no count", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Early" }));
    s.meta("a1", { toolUseId: "t1", finished: false });
    const step = stepOf(running(s));
    expect(step).toMatchObject({ running: true });
    expect(step.stepCount).toBeUndefined();
  });

  test("the subagents folder missing or a plain file: no error", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "NoDir" }));
    expect(stepOf(running(s)).running).toBe(true);
    mkdirSync(join(s.subs, ".."), { recursive: true });
    writeFileSync(s.subs, "not a folder");
    expect(stepOf(running(s)).running).toBe(true);
  });

  test("a transcript that shrinks (rewritten) is read from the start", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Shrink" }));
    s.sub(
      "a1",
      { toolUseId: "t1", finished: false },
      readOf(1, "a.ts"),
      readOf(2, "b.ts"),
      readOf(3, "c.ts"),
    );
    const reader = running(s);
    expect(stepOf(reader).stepCount).toBe(3);
    writeFileSync(s.file("a1"), `${JSON.stringify(readOf(4, "z.ts"))}\n`);
    reader.refreshAgents();
    expect(stepOf(reader).current).toBe("Reading z.ts");
  });

  test("the transcript file deleted after a read keeps what the step knew", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Gone" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    const reader = running(s);
    unlinkSync(s.file("a1"));
    reader.refreshAgents();
    expect(stepOf(reader)).toMatchObject({ running: true, stepCount: 1 });
  });
});

describe("the same thing twice, and things that end underneath", () => {
  test("refreshing with nothing new reports no change", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Same" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    const reader = readerOf(s.path);
    expect(reader.refreshAgents().length).toBe(1);
    for (let i = 0; i < 3; i++) expect(reader.refreshAgents()).toEqual([]);
  });

  test("a task notification twice, or the result twice: the end time doesn't move", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Twice" }));
    const reader = readerOf(s.path);
    reader.add(result(10, "t1", "Async agent launched successfully."));
    reader.add(note(60, "t1"));
    const first = JSON.stringify(stepOf(reader));
    reader.add(note(900, "t1"));
    reader.add(result(1000, "t1", "again"));
    expect(JSON.stringify(stepOf(reader))).toBe(first);
    expect(stepOf(reader)).toMatchObject({ label: "Ran an agent: Twice", durationMs: 60_000 });
  });

  test("a notification for an unknown call id changes nothing and throws nothing", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description: "Mine" }));
    reader.add(note(5, "no-such-call"));
    reader.add({
      type: "user",
      timestamp: iso(6),
      message: { content: "<task-notification></task-notification>" },
    });
    reader.add({
      type: "user",
      timestamp: iso(7),
      message: { content: "<task-notification><tool-use-id></tool-use-id></task-notification>" },
    });
    expect(stepOf(reader)).toMatchObject({ label: "Running an agent: Mine", running: true });
  });

  test("a result for an unknown call id changes nothing", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description: "Mine" }));
    reader.add(result(5, "other", "x"));
    expect(stepOf(reader).running).toBe(true);
  });

  test("the same Agent call seen twice is one step", () => {
    const reader = new TimelineReader(CWD, T0);
    const c = call("u1", 0, "t1", "Agent", { description: "Dup" });
    reader.add(c);
    reader.add(c);
    expect(reader.actions.length).toBe(1);
  });

  test("a failed agent call is failed and no longer running", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description: "Bad" }));
    reader.add(result(3, "t1", "Error: boom", true));
    const step = stepOf(reader);
    expect(step.failed).toBe(true);
    expect(step.running).toBeUndefined();
    expect(step.label.startsWith("Ran an agent")).toBe(true);
    expect(valid(step)).toBe(true);
  });

  test("restarting the helper: a new reader over the same files shows the same step", () => {
    const s = session();
    s.main(
      call("u1", 0, "t1", "Agent", { description: "Restart" }),
      call("u2", 1, "wf", "Workflow", { scriptPath: "/x/w.js" }),
    );
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"), readOf(2, "b.ts"));
    s.sub("w1", { toolUseId: "o1", description: "Job", finished: false }, readOf(3, "c.ts", "w1"));
    const before = readerOf(s.path);
    before.refreshAgents();
    const after = readerOf(s.path);
    after.refreshAgents();
    expect(JSON.stringify(after.actions)).toBe(JSON.stringify(before.actions));
    expect(stepOf(after).stepCount).toBe(2);
  });

  test("an agent that finished while the helper was down is not shown as running", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Over" }), result(30, "t1", "all done"));
    s.sub("a1", { toolUseId: "t1", finished: true }, readOf(1, "a.ts"));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    const step = stepOf(reader);
    expect(step.running).toBeUndefined();
    expect(step.current).toBeUndefined();
    expect(step).toMatchObject({ label: "Ran an agent: Over", stepCount: 1, durationMs: 30_000 });
  });

  test("a meta that says finished ends a background agent without a notification", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "BG" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    const reader = readerOf(s.path);
    reader.add(result(1, "t1", "Async agent launched successfully."));
    reader.refreshAgents();
    expect(stepOf(reader).running).toBe(true);
    s.meta("a1", { toolUseId: "t1", finished: true });
    reader.refreshAgents();
    expect(stepOf(reader).running).toBeUndefined();
    expect(stepOf(reader).label).toBe("Ran an agent: BG");
  });

  test("the turn ending finalizes every step: none runs, none keeps a current step", () => {
    const s = session();
    s.main(
      call("u1", 0, "t1", "Agent", { description: "A" }),
      call("u2", 0, "t2", "Agent", { description: "B" }),
    );
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    s.sub("b1", { toolUseId: "t2", finished: false }, readOf(2, "b.ts", "b1"));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    reader.finish();
    reader.actions.forEach((a) => {
      const step = a as TurnStep;
      expect(step.running).toBeUndefined();
      expect(step.current).toBeUndefined();
      expect(step.label.startsWith("Ran an agent")).toBe(true);
    });
  });
});

describe("events in the wrong order and agents side by side", () => {
  test("the result before the subagent's file exists, then the file appears finished", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Late" }));
    const reader = readerOf(s.path);
    reader.add(result(20, "t1", "done"));
    reader.refreshAgents();
    expect(stepOf(reader).running).toBeUndefined();
    s.sub("a1", { toolUseId: "t1", finished: true }, readOf(1, "a.ts"));
    reader.refreshAgents();
    expect(stepOf(reader)).toMatchObject({ label: "Ran an agent: Late", stepCount: 1, durationMs: 20_000 });
    expect(stepOf(reader).running).toBeUndefined();
  });

  test("the notification before the launch result: the agent doesn't start running again", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description: "Quick" }));
    reader.add(note(5, "t1"));
    reader.add(result(6, "t1", "Async agent launched successfully."));
    expect(stepOf(reader).running).toBeUndefined();
    expect(stepOf(reader).label).toBe("Ran an agent: Quick");
  });

  test("two agents in parallel keep their own counts, current steps and end", () => {
    const s = session();
    s.main(
      call("u1", 0, "t1", "Agent", { description: "One" }),
      call("u2", 0, "t2", "Agent", { description: "Two" }),
    );
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"), readOf(2, "b.ts"));
    s.sub("b1", { toolUseId: "t2", finished: false }, readOf(3, "c.ts", "b1"));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    expect([stepOf(reader, 0).stepCount, stepOf(reader, 0).current]).toEqual([2, "Reading b.ts"]);
    expect([stepOf(reader, 1).stepCount, stepOf(reader, 1).current]).toEqual([1, "Reading c.ts"]);
    reader.add(result(50, "t1", "ok"));
    expect(stepOf(reader, 0).running).toBeUndefined();
    expect(stepOf(reader, 1).running).toBe(true);
  });

  test("a subagent file whose meta names another call is not this agent's", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Mine" }));
    s.sub("a1", { toolUseId: "someone-else", finished: false }, readOf(1, "a.ts"));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    expect(stepOf(reader).stepCount).toBeUndefined();
  });

  test("a look-alike notification inside an agent's result text doesn't end another agent", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "t1", "Agent", { description: "A" }));
    reader.add(call("u2", 0, "t2", "Agent", { description: "B" }));
    reader.add(
      result(5, "t1", "report: <task-notification><tool-use-id>t2</tool-use-id></task-notification>"),
    );
    expect(stepOf(reader, 0).running).toBeUndefined();
    expect(stepOf(reader, 1).running).toBe(true);
  });

  test("a look-alike notification in a subagent's own transcript doesn't end another agent", () => {
    const s = session();
    s.main(
      call("u1", 0, "t1", "Agent", { description: "A" }),
      call("u2", 0, "t2", "Agent", { description: "B" }),
    );
    s.sub(
      "a1",
      { toolUseId: "t1", finished: false },
      side(1, "a1", { ...note(1, "t2"), isSidechain: true }),
      readOf(2, "a.ts"),
    );
    const reader = readerOf(s.path);
    reader.refreshAgents();
    expect(stepOf(reader, 1).running).toBe(true);
  });
});

describe("what a workflow's agent lines say", () => {
  const workflow = (agents: Record<string, unknown>[]) => {
    const s = session();
    s.main(call("u1", 0, "wf", "Workflow", { scriptPath: "/x/deploy.js" }));
    for (const [i, meta] of agents.entries())
      s.sub(
        `w${i}`,
        meta,
        side(i + 1, `w${i}`, call(`s${i}`, i + 1, `r${i}`, "Read", { file_path: `${CWD}/a` })),
      );
    const reader = readerOf(s.path);
    reader.refreshAgents();
    return stepOf(reader);
  };

  test("a missing, empty or non-text description reads 'An agent'", () => {
    const step = workflow([
      { toolUseId: "o1" },
      { toolUseId: "o2", description: "" },
      { toolUseId: "o3", description: 5 },
    ]);
    expect(step.children?.map((c) => c.label)).toEqual(["An agent", "An agent", "An agent"]);
  });

  test("secrets, line breaks, bidi controls and length are handled like any label", () => {
    const step = workflow([
      { toolUseId: "o1", description: `deploy ${TOKEN}` },
      { toolUseId: "o2", description: "a\nb\tc" },
      { toolUseId: "o3", description: "‮abc" },
      { toolUseId: "o4", description: "z".repeat(900) },
    ]);
    expect(JSON.stringify(step)).not.toContain(TOKEN);
    for (const c of step.children ?? []) {
      expect(c.label).not.toMatch(/[\n\t‮]/);
      expect(sessionNameLength(c.label)).toBeLessThanOrEqual(TURN_STEP_LABEL_MAX);
    }
    expect(valid(step)).toBe(true);
  });

  test("a workflow with no agents has no children and still runs until its notification", () => {
    const step = workflow([]);
    expect(step).toMatchObject({ running: true });
    expect(step.children).toBeUndefined();
    expect(step.childrenMore).toBeUndefined();
    expect(step.stepCount).toBeUndefined();
  });

  test("an agent of an earlier call is not listed by a workflow that started later", () => {
    const s = session();
    s.main(
      call("u1", 0, "t1", "Agent", { description: "Plain" }),
      call("u2", 100, "wf", "Workflow", { scriptPath: "/x/w.js" }),
    );
    s.sub("a1", { toolUseId: "t1", finished: true }, readOf(1, "a.ts"));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    expect(stepOf(reader, 1).children).toBeUndefined();
  });
});

describe("older phones and the schema", () => {
  const base = { kind: "agent", label: "Ran an agent: X", at: T0 };

  test("a step without any progress field is valid", () => {
    expect(valid(base)).toBe(true);
  });

  test("progress fields are optional one by one", () => {
    for (const extra of [
      { running: true },
      { state: "done" },
      { stepCount: 0 },
      { current: "Reading a.ts" },
      { children: [] },
      { childrenMore: 1 },
      { durationMs: 0 },
    ])
      expect(valid({ ...base, ...extra })).toBe(true);
  });

  test("fields of a later version don't make an older step fail", () => {
    expect(valid({ ...base, running: true, somethingNew: { a: 1 } })).toBe(true);
  });

  test("the limits are enforced: children, more-count, state, step count, duration, wrong types", () => {
    const child = { kind: "read", label: "Read a", at: T0 };
    const many = (n: number) => Array.from({ length: n }, () => child);
    expect(valid({ ...base, children: many(TURN_STEP_CHILDREN_MAX) })).toBe(true);
    expect(valid({ ...base, children: many(TURN_STEP_CHILDREN_MAX + 1) })).toBe(false);
    expect(valid({ ...base, childrenMore: 0 })).toBe(false);
    expect(valid({ ...base, childrenMore: -1 })).toBe(false);
    expect(valid({ ...base, childrenMore: 1.5 })).toBe(false);
    expect(valid({ ...base, state: "x".repeat(41) })).toBe(false);
    expect(valid({ ...base, state: "x".repeat(40) })).toBe(true);
    expect(valid({ ...base, stepCount: -1 })).toBe(false);
    expect(valid({ ...base, stepCount: 1.5 })).toBe(false);
    expect(valid({ ...base, durationMs: -1 })).toBe(false);
    expect(valid({ ...base, running: "yes" })).toBe(false);
    expect(valid({ ...base, current: 5 })).toBe(false);
    expect(valid({ ...base, current: "x".repeat(TURN_STEP_LABEL_MAX + 1) })).toBe(false);
  });

  test("a live agent's step as sent is plain JSON that survives a round trip", () => {
    const s = session();
    s.main(call("u1", 0, "t1", "Agent", { description: "Trip" }));
    s.sub("a1", { toolUseId: "t1", finished: false }, readOf(1, "a.ts"));
    const reader = readerOf(s.path);
    reader.refreshAgents();
    const step = stepOf(reader);
    expect(TurnStep.parse(JSON.parse(JSON.stringify(step)))).toEqual(step);
  });
});

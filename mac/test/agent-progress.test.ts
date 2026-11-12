import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayEvent, TURN_STEP_CHILDREN_MAX, TurnStep } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { turnFromTranscript } from "../src/daemon/render.ts";
import { stepFor } from "../src/daemon/steps.ts";
import { TimelineReader } from "../src/daemon/timeline.ts";

// Every tool says what it does; an agent's or workflow's step shows its progress.

const CWD = "/Users/me/Projects/my-app";
const T0 = Date.parse("2026-11-09T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

const live = (n: string, i?: Record<string, unknown>) => stepFor(n, i, CWD, "live").label;
const done = (n: string, i?: Record<string, unknown>) => stepFor(n, i, CWD, "done").label;

describe("tools say what they do", () => {
  test("each named tool, live and finished", () => {
    const cases: [string, Record<string, unknown> | undefined, string, string][] = [
      ["Skill", { skill: "review" }, "Running the review skill", "Ran the review skill"],
      ["Skill", {}, "Running a skill", "Ran a skill"],
      [
        "Workflow",
        { scriptPath: "/x/.claude/workflows/deploy.js" },
        "Running the deploy workflow",
        "Ran the deploy workflow",
      ],
      ["Workflow", undefined, "Running a workflow", "Ran a workflow"],
      ["SendMessage", { to: "abc" }, "Messaging another session", "Messaged another session"],
      [
        "Monitor",
        { description: "test failures" },
        "Watching for test failures",
        "Watched for test failures",
      ],
      ["Monitor", {}, "Watching for output", "Watched for output"],
      ["TaskStop", { task_id: "b1" }, "Stopping a background task", "Stopped a background task"],
      ["TaskOutput", {}, "Checking a background task", "Checked a background task"],
      ["ToolSearch", { query: "select:WebSearch" }, "Loading tools", "Loaded tools"],
      ["ScheduleWakeup", { delaySeconds: 60 }, "Scheduling a wake-up", "Scheduled a wake-up"],
    ];
    for (const [name, input, l, d] of cases)
      expect([name, live(name, input), done(name, input)]).toEqual([name, l, d]);
  });

  test("an unknown tool keeps its name and is never just Working", () => {
    expect([live("FutureTool"), done("FutureTool")]).toEqual(["Using FutureTool", "Used FutureTool"]);
    expect(live("mcp__linear__save_issue")).toBe("Using save_issue (linear)");
    expect(live("")).toBe("Using a tool");
    for (const n of ["Skill", "Workflow", "FutureTool", "mcp__a__b", "Monitor"])
      expect(live(n)).not.toBe("Working");
  });

  test("a Workflow counts as an agent step, a skill as other", () => {
    expect(stepFor("Workflow", {}, CWD, "live").kind).toBe("agent");
    expect(stepFor("Skill", {}, CWD, "live").kind).toBe("other");
  });

  test("a secret in a skill name or monitor description is redacted", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";
    expect(live("Monitor", { description: `watch ${token}` })).not.toContain(token);
  });
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  resetLiveMessages();
});

function session() {
  const dir = mkdtempSync(join(tmpdir(), "agent-progress-"));
  dirs.push(dir);
  const path = join(dir, "sess.jsonl");
  const subs = join(dir, "sess", "subagents");
  writeFileSync(path, "");
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  return {
    dir,
    path,
    subs,
    main: (...o: unknown[]) => appendFileSync(path, o.map(line).join("")),
    sub: (id: string, meta: Record<string, unknown>, ...o: unknown[]) => {
      mkdirSync(subs, { recursive: true });
      writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify(meta));
      appendFileSync(join(subs, `agent-${id}.jsonl`), o.map(line).join(""));
    },
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
const side = (s: number, agentId: string, entry: Record<string, unknown>) => ({
  isSidechain: true,
  agentId,
  timestamp: iso(s),
  ...entry,
});
const readCall = (s: number, uuid: string, id: string, file: string) =>
  side(s, "a1", call(uuid, s, id, "Read", { file_path: `${CWD}/${file}` }));

describe("an agent's step from its own transcript file", () => {
  test("running: count, current step and its steps; finished: count, time, no current", () => {
    const s = session();
    s.main(call("u1", 0, "toolu_A", "Agent", { description: "Review PR #30", prompt: "do it" }));
    s.sub(
      "a1",
      { toolUseId: "toolu_A", description: "Review PR #30", finished: false },
      readCall(1, "s1", "r1", "lib.ts"),
      readCall(2, "s2", "r2", "app.ts"),
    );
    const reader = new TimelineReader(CWD, T0, { transcriptPath: s.path });
    for (const l of require("node:fs").readFileSync(s.path, "utf8").trim().split("\n"))
      reader.add(JSON.parse(l));
    const changed = reader.refreshAgents();
    const step = reader.actions[0] as TurnStep;
    expect(changed).toContain(step);
    expect(step).toMatchObject({
      kind: "agent",
      label: "Running an agent: Review PR #30",
      running: true,
      stepCount: 2,
      current: "Reading app.ts",
    });
    expect(step.children?.map((c) => c.label)).toEqual(["Read lib.ts", "Read app.ts"]);
    expect(step.children?.some((c) => c.detail !== undefined)).toBe(false);
    expect(TurnStep.safeParse(step).success).toBe(true);

    // The agent finishes: the sync result arrives.
    s.sub(
      "a1",
      { toolUseId: "toolu_A", description: "Review PR #30", finished: true },
      readCall(5, "s3", "r3", "x.ts"),
    );
    reader.add(result(240, "toolu_A", "All good."));
    reader.refreshAgents();
    expect(step.running).toBeUndefined();
    expect(step.current).toBeUndefined();
    expect(step).toMatchObject({ label: "Ran an agent: Review PR #30", stepCount: 3, durationMs: 240_000 });
  });

  test("a background agent runs until its task notification; the launch result doesn't end it", () => {
    const s = session();
    s.main(call("u1", 0, "toolu_B", "Agent", { description: "Dig", prompt: "p" }));
    s.sub(
      "b1",
      { toolUseId: "toolu_B", finished: false },
      side(1, "b1", call("s1", 1, "r1", "Grep", { pattern: "foo" })),
    );
    const reader = new TimelineReader(CWD, T0, { transcriptPath: s.path });
    reader.add(JSON.parse(readLine(s.path, 0)));
    reader.add(result(1, "toolu_B", "Async agent launched successfully.\nagentId: b1"));
    reader.refreshAgents();
    const step = reader.actions[0] as TurnStep;
    expect(step.running).toBe(true);
    expect(step.current).toBe("Searching for “foo”");
    reader.add({
      type: "user",
      timestamp: iso(90),
      message: {
        content:
          "<task-notification>\n<tool-use-id>toolu_B</tool-use-id>\n<status>completed</status></task-notification>",
      },
    });
    expect(step.running).toBeUndefined();
    expect(step).toMatchObject({ label: "Ran an agent: Dig", durationMs: 90_000 });
  });

  test("steps beyond the cap are counted, not sent", () => {
    const s = session();
    s.main(call("u1", 0, "toolu_C", "Agent", { description: "Big" }));
    const many = Array.from({ length: TURN_STEP_CHILDREN_MAX + 7 }, (_, i) =>
      side(i + 1, "c1", call(`s${i}`, i + 1, `r${i}`, "Bash", { command: `echo ${i}` })),
    );
    s.sub("c1", { toolUseId: "toolu_C", finished: false }, ...many);
    const reader = new TimelineReader(CWD, T0, { transcriptPath: s.path });
    reader.add(JSON.parse(readLine(s.path, 0)));
    reader.refreshAgents();
    const step = reader.actions[0] as TurnStep;
    expect(step.stepCount).toBe(TURN_STEP_CHILDREN_MAX + 7);
    expect(step.children?.length).toBe(TURN_STEP_CHILDREN_MAX);
    expect(step.childrenMore).toBe(7);
    expect(TurnStep.safeParse(step).success).toBe(true);
  });

  test("a secret in an agent's command never reaches the children", () => {
    const s = session();
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";
    s.main(call("u1", 0, "toolu_D", "Agent", { description: "Leak" }));
    s.sub(
      "d1",
      { toolUseId: "toolu_D", finished: false },
      side(1, "d1", call("s1", 1, "r1", "Bash", { command: `curl -H "Authorization: ${token}" x` })),
    );
    const reader = new TimelineReader(CWD, T0, { transcriptPath: s.path });
    reader.add(JSON.parse(readLine(s.path, 0)));
    reader.refreshAgents();
    expect(JSON.stringify(reader.actions[0])).not.toContain(token);
  });

  test("older transcripts: sidechain entries in the main transcript", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "toolu_E", "Task", { description: "Old style", prompt: "the prompt" }));
    reader.add({
      isSidechain: true,
      parentUuid: null,
      type: "user",
      uuid: "p1",
      timestamp: iso(1),
      message: { content: "the prompt" },
    });
    reader.add({
      ...call("s1", 2, "r1", "Read", { file_path: `${CWD}/a.ts` }),
      isSidechain: true,
      parentUuid: "p1",
    });
    reader.add({
      ...call("s2", 3, "r2", "Read", { file_path: `${CWD}/b.ts` }),
      isSidechain: true,
      parentUuid: "s1",
    });
    const step = reader.actions[0] as TurnStep;
    // Only the main conversation's calls are the turn's steps.
    expect(reader.actions.length).toBe(1);
    expect(step).toMatchObject({ running: true, stepCount: 2, current: "Reading b.ts" });
    reader.add(result(60, "toolu_E", "done"));
    expect(step).toMatchObject({ label: "Ran an agent: Old style", durationMs: 60_000, stepCount: 2 });
  });

  test("an agent step without progress (no file, no entries) stays as before, only running until its result", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "toolu_F", "Agent", { description: "Quiet" }));
    const step = reader.actions[0] as TurnStep;
    expect(step).toMatchObject({ label: "Running an agent: Quiet", running: true });
    expect(step.stepCount).toBeUndefined();
    reader.add(result(5, "toolu_F", "ok"));
    expect(step.label).toBe("Ran an agent: Quiet");
    expect(step.children).toBeUndefined();
  });

  test("turns without agents have none of the new fields", () => {
    const reader = new TimelineReader(CWD, T0);
    reader.add(call("u1", 0, "toolu_G", "Read", { file_path: `${CWD}/a.ts` }));
    reader.add(result(1, "toolu_G", "x"));
    expect(Object.keys(reader.actions[0] as object).sort()).toEqual([
      "at",
      "detail",
      "id",
      "kind",
      "label",
      "tool",
    ]);
  });
});

describe("a workflow's step", () => {
  test("one line per agent with label and state; running until its notification", () => {
    const s = session();
    s.main(call("u1", 0, "toolu_W", "Workflow", { scriptPath: "/x/deploy.js" }));
    s.sub(
      "w1",
      { toolUseId: "other-1", description: "Build #5", finished: true },
      side(2, "w1", call("s1", 2, "r1", "Read", { file_path: `${CWD}/a` })),
    );
    s.sub(
      "w2",
      { toolUseId: "other-2", description: "Build #6", finished: false },
      side(3, "w2", call("s2", 3, "r2", "Read", { file_path: `${CWD}/b` })),
    );
    const reader = new TimelineReader(CWD, T0, { transcriptPath: s.path });
    reader.add(JSON.parse(readLine(s.path, 0)));
    reader.add(result(1, "toolu_W", "Workflow started. Task id: wf1"));
    reader.refreshAgents();
    const step = reader.actions[0] as TurnStep;
    expect(step).toMatchObject({ kind: "agent", label: "Running the deploy workflow", running: true });
    expect(step.children?.map((c) => [c.label, c.state])).toEqual([
      ["Build #5", "done"],
      ["Build #6", "running"],
    ]);
    expect(TurnStep.safeParse(step).success).toBe(true);
    reader.add({
      type: "user",
      timestamp: iso(100),
      message: { content: "<task-notification><tool-use-id>toolu_W</tool-use-id></task-notification>" },
    });
    expect(step.running).toBeUndefined();
    expect(step.label).toBe("Ran the deploy workflow");
    expect(step.children?.every((c) => c.state === "done")).toBe(true);
    expect(step.durationMs).toBe(100_000);
  });
});

function readLine(path: string, n: number): string {
  return require("node:fs").readFileSync(path, "utf8").trim().split("\n")[n];
}

describe("live and finished", () => {
  test("turn.action goes out again by the same id as the agent progresses", () => {
    const s = session();
    const events = new EventLog(openDb(":memory:"));
    const sent: RelayEvent[] = [];
    events.subscribe((e) => sent.push(e));
    const tracker = new MessageTracker(events, { pollMs: 0 });
    tracker.turnStarted("sess", "t1", s.path, T0 - 1000, CWD);
    s.main(call("u1", 0, "toolu_L", "Agent", { description: "Live one", prompt: "p" }));
    tracker.poll("sess");
    s.sub(
      "l1",
      { toolUseId: "toolu_L", finished: false },
      side(1, "l1", call("s1", 1, "r1", "Read", { file_path: `${CWD}/a.ts` })),
    );
    tracker.poll("sess");
    appendFileSync(
      join(s.subs, "agent-l1.jsonl"),
      `${JSON.stringify(side(2, "l1", call("s2", 2, "r2", "Bash", { command: "bun test" })))}\n`,
    );
    tracker.poll("sess");
    const actions = sent
      .filter((e) => e.type === "turn.action")
      .map((e) => (e as Extract<RelayEvent, { type: "turn.action" }>).step);
    expect(actions.map((a) => a.id)).toEqual(["toolu_L", "toolu_L", "toolu_L"]);
    expect(actions.map((a) => a.stepCount)).toEqual([undefined, 1, 2]);
    expect(actions.at(-1)).toMatchObject({ running: true, current: "Running bun test" });
    for (const a of actions) expect(TurnStep.safeParse(a).success).toBe(true);
    tracker.clear("sess");
  });

  test("the finished turn keeps the agent's progress and nothing still runs", () => {
    const s = session();
    s.main(
      { type: "user", uuid: "p", timestamp: iso(-1), message: { content: "go" } },
      call("u1", 0, "toolu_M", "Agent", { description: "Gone", prompt: "p" }),
    );
    s.sub("m1", { toolUseId: "toolu_M", finished: false }, readCall(1, "s1", "r1", "a.ts"));
    // The turn ends while the background agent still goes on.
    s.main(result(2, "toolu_M", "Async agent launched successfully."));
    const turn = turnFromTranscript(s.path, T0 - 1000, CWD);
    const step = turn?.steps[0] as TurnStep;
    expect(step).toMatchObject({ label: "Ran an agent: Gone", stepCount: 1 });
    expect(step.running).toBeUndefined();
    expect(step.current).toBeUndefined();
  });
});

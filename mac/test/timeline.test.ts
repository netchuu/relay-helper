import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphemes,
  type RelayEvent,
  TURN_ACTIONS_LIVE_MAX,
  TURN_STEP_DETAIL_MAX,
  type Turn,
  TurnStep,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { actionFields, durationText, TimelineReader } from "../src/daemon/timeline.ts";
import { formatEvent } from "../src/tailFormat.ts";

// Turn timeline: each action with its tool, title and detail, and each thinking line, live and in the finished turn.

const CWD = "/Users/me/Projects/my-app";
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";

describe("what an action shows", () => {
  test("Bash: its own description as the title, the whole command as the detail", () => {
    expect(
      actionFields(
        "Bash",
        { command: "cd ios && swift build\necho done", description: "Rebuild the app" },
        CWD,
      ),
    ).toEqual({ tool: "Bash", title: "Rebuild the app", detail: "cd ios && swift build\necho done" });
  });

  test("Bash without a description has no title (the step label is shown)", () => {
    expect(actionFields("Bash", { command: "bun test" }, CWD)).toEqual({ tool: "Bash", detail: "bun test" });
  });

  test("reads and edits show the path: relative inside the project, ~ in the home folder, else in full", () => {
    expect(actionFields("Read", { file_path: `${CWD}/src/cart.ts` }, CWD).detail).toBe("src/cart.ts");
    expect(
      actionFields("Edit", { file_path: `${homedir()}/.zshrc`, old_string: "a", new_string: "b" }, CWD),
    ).toEqual({ tool: "Edit", detail: "~/.zshrc" });
    expect(actionFields("Write", { file_path: "/etc/hosts", content: "SECRET CONTENT" }, CWD)).toEqual({
      tool: "Write",
      detail: "/etc/hosts",
    });
    expect(actionFields("NotebookEdit", { notebook_path: `${CWD}/a/../b.ipynb` }, CWD).detail).toBe(
      "b.ipynb",
    );
  });

  test("searches show the pattern and the folder; the web its site; agents their description as the title", () => {
    expect(actionFields("Grep", { pattern: "liveTurns", path: `${CWD}/app` }, CWD).detail).toBe(
      "liveTurns in app",
    );
    expect(actionFields("Glob", { pattern: "**/*.swift" }, CWD).detail).toBe("**/*.swift");
    expect(actionFields("WebFetch", { url: "https://www.example.com/a?token=x", prompt: "p" }, CWD)).toEqual({
      tool: "WebFetch",
      detail: "example.com",
    });
    expect(actionFields("WebSearch", { query: "secret plans" }, CWD)).toEqual({ tool: "WebSearch" });
    expect(actionFields("Agent", { description: "Explore iOS", prompt: "long private prompt" }, CWD)).toEqual(
      {
        tool: "Agent",
        title: "Explore iOS",
      },
    );
    expect(actionFields("mcp__github__search_code", { query: "x" }, CWD)).toEqual({ tool: "search_code" });
  });

  test("secrets are redacted in titles and details, also when the cut falls inside one", () => {
    const f = actionFields(
      "Bash",
      { command: `curl -H "Authorization: token ${TOKEN}" x`, description: `use ${TOKEN}` },
      CWD,
    );
    expect(f.title).not.toContain("ghp_");
    expect(f.detail).not.toContain("ghp_");
    const long = actionFields("Bash", { command: `${"x ".repeat(998)}${TOKEN} tail` }, CWD).detail ?? "";
    expect(long).not.toContain("ghp_");
    expect(graphemes(long).length).toBeLessThanOrEqual(TURN_STEP_DETAIL_MAX);
    expect(TurnStep.safeParse({ kind: "run", label: "Ran x", at: 1, detail: long }).success).toBe(true);
  });

  test("a 2000-character emoji command keeps whole characters and passes the schema", () => {
    const family = "👨‍👩‍👧‍👦";
    const d = actionFields("Bash", { command: family.repeat(2500) }, CWD).detail ?? "";
    const g = graphemes(d);
    expect(g.length).toBeLessThanOrEqual(TURN_STEP_DETAIL_MAX);
    for (const ch of g.slice(0, -1)) expect(ch).toBe(family);
    expect(TurnStep.safeParse({ kind: "run", label: "Ran x", at: 1, detail: d }).success).toBe(true);
  });

  test("thinking durations read as people say them", () => {
    expect([durationText(400), durationText(4200), durationText(65_000)]).toEqual(["1s", "4s", "1m 5s"]);
  });
});

const iso = (ms: number) => new Date(ms).toISOString();
const prompt = (t: string, at: number) => ({
  type: "user",
  uuid: `u-${t}`,
  timestamp: iso(at),
  message: { content: t },
});
const thinking = (uuid: string, at: number) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { content: [{ type: "thinking", thinking: "" }] },
});
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
const text = (uuid: string, t: string, at: number) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { content: [{ type: "text", text: t }] },
});

describe("the timeline reader", () => {
  test("thinking lines are timed from the previous entry (at least 1 s); actions get ids; errors mark them failed", () => {
    const r = new TimelineReader(CWD, 1000);
    r.add(prompt("Fix it", 1000));
    expect(r.add(thinking("th1", 5200))).toEqual([
      { kind: "thinking", label: "Thought for 4s", id: "th1", at: 5200, durationMs: 4200 },
    ]);
    r.add(use("a", "Bash", { command: "bun test", description: "Run the tests" }, 5300));
    const failed = r.add(result("a", true, 6000));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: "a", failed: true, tool: "Bash", title: "Run the tests" });
    expect(r.add(thinking("th2", 6100))[0]?.durationMs).toBe(1000);
    expect(r.actions.map((s) => s.id)).toEqual(["a"]);
    expect(r.thoughts.map((s) => s.id)).toEqual(["th1", "th2"]);
  });

  test("subagent entries are left out, and nothing private is kept", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("s", "Bash", { command: "secret-subagent-thing" }, 10, { isSidechain: true }));
    r.add(use("w", "Write", { file_path: `${CWD}/a.ts`, content: "FILE CONTENTS" }, 20));
    r.add(result("w", false, 30));
    expect(r.actions.map((s) => s.id)).toEqual(["w"]);
    expect(JSON.stringify(r.actions)).not.toMatch(/FILE CONTENTS|OUTPUT TEXT|secret-subagent/);
  });
});

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-timeline-"));
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
  const rows = () =>
    (db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.action'").get() as { n: number }).n;
  return { db, rpc, hook, append, actions, done, rows, path };
}

const hookTool = (id: string, name = "Bash", input: object = { command: "ls" }) => ({
  tool_use_id: id,
  tool_name: name,
  tool_input: input,
});

describe("live", () => {
  test("each action and thinking line is sent once, a failed action again with its id, in order", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Fix it" });
    const s = Date.now();
    t.append(
      prompt("Fix it", s + 1),
      thinking("th1", s + 3000),
      use("a", "Bash", { command: "swift build", description: "Rebuild" }, s + 3100),
      use("b", "Read", { file_path: `${CWD}/src/cart.ts` }, s + 3200),
    );
    await t.hook("PreToolUse", hookTool("a"));
    t.append(result("a", true, s + 4000));
    await t.hook("PostToolUseFailure", hookTool("a"));
    expect(t.actions().map((e) => [e.step.id, e.step.kind, e.step.label, e.step.failed ?? false])).toEqual([
      ["th1", "thinking", "Thought for 3s", false],
      ["a", "run", "Ran swift build", false],
      ["b", "read", "Read src/cart.ts", false],
      ["a", "run", "Ran swift build", true],
    ]);
    expect(t.actions()[1]?.step).toMatchObject({ tool: "Bash", title: "Rebuild", detail: "swift build" });
    const live = await t.rpc("session.live", { sessionId: "s1" }, "device:x");
    const reply = "result" in live ? (live.result as { actions?: TurnStep[] }) : null;
    expect(reply?.actions?.map((a) => [a.id, a.failed ?? false])).toEqual([
      ["th1", false],
      ["a", true],
      ["b", false],
    ]);
    for (const e of t.actions()) expect(alertFor(e, () => "x")).toBeNull();
  });

  test("entries from before the turn are not sent, and at most 200 items a turn", async () => {
    const t = setup();
    t.append(use("old", "Bash", { command: "old" }, Date.now() - 60_000));
    await t.hook("UserPromptSubmit", { prompt: "Many" });
    const s = Date.now() + 5;
    t.append(
      ...Array.from({ length: TURN_ACTIONS_LIVE_MAX + 5 }, (_, i) =>
        use(`x${i}`, "Bash", { command: `c${i}` }, s + i),
      ),
    );
    await t.hook("PreToolUse", hookTool("x0"));
    expect(t.actions()).toHaveLength(TURN_ACTIONS_LIVE_MAX);
    expect(t.actions().some((e) => e.step.id === "old")).toBe(false);
  });

  test("the finished turn has the same ids, titles and details, its thinking lines apart, and the live rows go", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Fix it" });
    const s = Date.now();
    t.append(
      prompt("Fix it", s + 1),
      thinking("th1", s + 2000),
      text("m1", "Looking.", s + 2050),
      use("a", "Bash", { command: "swift build", description: "Rebuild" }, s + 2100),
      result("a", false, s + 2500),
      text("ans", "Done.", s + 2600),
    );
    await t.hook("PreToolUse", hookTool("a"));
    expect(t.rows()).toBeGreaterThan(0);
    await t.hook("Stop", { last_assistant_message: "Done." });
    const turn = t.done();
    expect(turn.steps).toEqual([
      expect.objectContaining({
        id: "a",
        tool: "Bash",
        title: "Rebuild",
        detail: "swift build",
        label: "Ran swift build",
      }),
    ]);
    expect(turn.thoughts).toEqual([
      expect.objectContaining({ id: "th1", kind: "thinking", label: "Thought for 2s" }),
    ]);
    expect(turn.steps?.length).toBe(turn.stats.toolCalls);
    expect(t.rows()).toBe(0);
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    const stored = "result" in res ? (res.result as Turn[])[0] : undefined;
    expect(stored?.thoughts?.map((x) => x.id)).toEqual(["th1"]);
    expect(stored?.steps?.[0]?.detail).toBe("swift build");
  });

  test("without a transcript, the hooks' steps still get their id, tool, title and detail", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: "/nonexistent.jsonl" });
    await t.hook("PreToolUse", {
      ...hookTool("h1", "Bash", { command: "make", description: "Build it" }),
      transcript_path: "/nonexistent.jsonl",
    });
    await t.hook("PostToolUse", {
      ...hookTool("h1", "Bash", { command: "make", description: "Build it" }),
      transcript_path: "/nonexistent.jsonl",
    });
    await t.hook("Stop", { last_assistant_message: "Built.", transcript_path: "/nonexistent.jsonl" });
    expect(t.done().steps?.[0]).toMatchObject({ id: "h1", tool: "Bash", title: "Build it", detail: "make" });
  });

  test("relay tail prints an action as one line", () => {
    const line = formatEvent({
      seq: 9,
      ts: 1,
      type: "turn.action",
      sessionId: "4375b77a-1111",
      turnId: "t1",
      step: { kind: "run", label: "Ran make", at: 1, tool: "Bash", title: "Build it", failed: true },
    });
    expect(line).toContain("4375b77a Bash · Build it · Failed");
    expect(line).not.toContain("\n");
  });
});

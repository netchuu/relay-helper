import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type RelayEvent,
  RelayEvent as RelayEventSchema,
  type Session,
  Session as SessionSchema,
  type Turn,
  Turn as TurnSchema,
  type TurnStep,
  TurnStep as TurnStepSchema,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker, stepFor } from "../src/daemon/steps.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";
import { countHooks, mergeHooks, relayHooks } from "../src/install.ts";

// Turn steps, case by case: the words for every tool, files, commands, the 80-character limit, what is never sent,
// live steps, sync, a finished turn's list, the hooks, the fixtures, and the same end to end over the hook socket.

const CWD = "/Users/me/Projects/my-app";
const live = (tool: string, input: Record<string, unknown> = {}) => stepFor(tool, input, CWD, "live");
const done = (tool: string, input: Record<string, unknown> = {}) => stepFor(tool, input, CWD, "done");
const both = (tool: string, input: Record<string, unknown> = {}) => [
  live(tool, input).label,
  done(tool, input).label,
];

describe("words for every tool, live and finished", () => {
  test("Read, Edit, MultiEdit, Write and NotebookEdit name the file", () => {
    const f = { file_path: `${CWD}/mac/src/daemon/steps.ts` };
    expect(both("Read", f)).toEqual(["Reading mac/src/daemon/steps.ts", "Read mac/src/daemon/steps.ts"]);
    for (const t of ["Edit", "MultiEdit", "Write"])
      expect(both(t, f)).toEqual(["Editing mac/src/daemon/steps.ts", "Edited mac/src/daemon/steps.ts"]);
    expect(both("NotebookEdit", { notebook_path: `${CWD}/nb/x.ipynb` })).toEqual([
      "Editing nb/x.ipynb",
      "Edited nb/x.ipynb",
    ]);
    expect(live("Read", f).kind).toBe("read");
    for (const t of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) expect(live(t, f).kind).toBe("edit");
  });

  test("Bash, Grep and Glob", () => {
    expect(both("Bash", { command: "git status" })).toEqual(["Running git status", "Ran git status"]);
    expect(both("Grep", { pattern: "liveStep" })).toEqual([
      "Searching for “liveStep”",
      "Searched for “liveStep”",
    ]);
    expect(both("Glob", { pattern: "**/*.kt" })).toEqual([
      "Searching for “**/*.kt”",
      "Searched for “**/*.kt”",
    ]);
    expect([live("Bash").kind, live("Grep").kind, live("Glob").kind]).toEqual(["run", "search", "search"]);
  });

  test("Agent and Task show the short description, or none", () => {
    expect(both("Agent", { description: "Find the reducer", prompt: "LONG PROMPT" })).toEqual([
      "Running an agent: Find the reducer",
      "Ran an agent: Find the reducer",
    ]);
    expect(both("Task", { description: "Find the reducer" })[0]).toBe("Running an agent: Find the reducer");
    expect(both("Agent", {})).toEqual(["Running an agent", "Ran an agent"]);
    expect(both("Agent", { description: "   " })).toEqual(["Running an agent", "Ran an agent"]);
    expect(live("Task").kind).toBe("agent");
  });

  test("WebFetch shows the host only; WebSearch never shows its query", () => {
    expect(
      both("WebFetch", { url: "https://developer.apple.com/documentation/swiftui/view?lang=en#x" }),
    ).toEqual(["Reading developer.apple.com", "Read developer.apple.com"]);
    expect(
      live("WebFetch", { url: "https://user:hunter2@WWW.Example.COM:8443/private?token=abc" }).label,
    ).toBe("Reading example.com");
    expect(both("WebSearch", { query: "how to leak the secret plan" })).toEqual([
      "Searching the web",
      "Searched the web",
    ]);
    expect([live("WebFetch").kind, live("WebSearch").kind]).toEqual(["web", "web"]);
  });

  test("an unparseable or missing WebFetch URL reads as searching the web", () => {
    for (const url of ["not a url", "", 42, null, undefined, "javascript:alert(1)", "file:///etc/passwd"])
      expect(both("WebFetch", { url })).toEqual(["Searching the web", "Searched the web"]);
  });

  test("TodoWrite, AskUserQuestion and ExitPlanMode", () => {
    expect(both("TodoWrite", { todos: [{ content: "secret todo" }] })).toEqual([
      "Updating the to-do list",
      "Updated the to-do list",
    ]);
    expect(both("AskUserQuestion", { questions: [{ question: "Q?" }] })).toEqual([
      "Asking you a question",
      "Asked you a question",
    ]);
    expect(both("ExitPlanMode", { plan: "PLAN TEXT" })).toEqual([
      "Showing you the plan",
      "Showed you the plan",
    ]);
    expect([live("TodoWrite").kind, live("AskUserQuestion").kind, live("ExitPlanMode").kind]).toEqual([
      "todo",
      "question",
      "plan",
    ]);
  });

  test("MCP and unknown tools: Using <tool> live, Used <tool> (<server>) when finished", () => {
    expect(both("mcp__claude_ai_Linear__save_issue", { title: "x" })).toEqual([
      "Using save_issue (claude_ai_Linear)",
      "Used save_issue (claude_ai_Linear)",
    ]);
    expect(both("Skill", { skill: "ship" })).toEqual(["Running the ship skill", "Ran the ship skill"]);
    expect(both("SomeToolFromTheFuture")).toEqual([
      "Using SomeToolFromTheFuture",
      "Used SomeToolFromTheFuture",
    ]);
    expect(live("mcp__x__y").kind).toBe("other");
    expect(done("").label.length).toBeGreaterThan(0);
  });

  test("tool_input fields of the wrong type don't crash and show no value", () => {
    expect(live("Read", { file_path: 123 }).label).toBe("Reading");
    expect(live("Bash", { command: ["rm", "-rf"] }).label).toBe("Running a command");
    expect(live("Grep", { pattern: { $re: 1 } }).label).toBe("Searching");
    expect(live("Agent", { description: 7 }).label).toBe("Running an agent");
    expect(stepFor("Read", undefined, null, "live").label).toBe("Reading");
  });

  test("every label is a valid TurnStep for the protocol", () => {
    for (const tool of ["Read", "Edit", "Bash", "Grep", "WebFetch", "Agent", "TodoWrite", "mcp__a__b", "X"])
      for (const tense of ["live", "done"] as const)
        expect(
          TurnStepSchema.safeParse({
            ...stepFor(tool, { file_path: `${CWD}/a`, command: "ls" }, CWD, tense),
            at: 1,
          }).success,
        ).toBe(true);
  });
});

describe("files: inside the project relative, outside only the name", () => {
  test("a file outside the project shows only its name, never the folder", () => {
    expect(live("Read", { file_path: "/Users/me/.ssh/id_ed25519" }).label).toBe("Reading id_ed25519");
    expect(live("Read", { file_path: "/Users/me/Projects/client-acme/secret-plan.md" }).label).toBe(
      "Reading secret-plan.md",
    );
    // A sibling folder whose name starts like the project's.
    expect(live("Read", { file_path: `${CWD}-private/notes.md` }).label).toBe("Reading notes.md");
  });

  test("a trailing slash on the session folder doesn't matter", () => {
    expect(stepFor("Read", { file_path: `${CWD}/a/b.ts` }, `${CWD}/`, "live").label).toBe("Reading a/b.ts");
  });

  test("no session folder known: only the name", () => {
    expect(stepFor("Read", { file_path: `${CWD}/a/b.ts` }, null, "live").label).toBe("Reading b.ts");
  });

  test("a path at 60 characters shows whole; a longer one keeps its end", () => {
    const exactly60 = `${"a".repeat(51)}/file.swift`; // 51 + 11 = 62? keep exact below
    const rel = exactly60.slice(exactly60.length - 60);
    expect(rel.length).toBe(60);
    expect(live("Read", { file_path: `${CWD}/${rel}` }).label).toBe(`Reading ${rel}`);
    const long = live("Read", {
      file_path: `${CWD}/app/${"Deep/".repeat(15)}Screens/DetailView.swift`,
    }).label;
    const shown = long.replace(/^Reading /, "");
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("Screens/DetailView.swift")).toBe(true);
  });

  test("a very long file name alone is cut at the start too", () => {
    const shown = live("Read", { file_path: `${CWD}/${"n".repeat(120)}.ts` }).label.replace(/^Reading /, "");
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown.endsWith(".ts")).toBe(true);
  });

  test("right-to-left file names stay as they are, on one line", () => {
    expect(live("Read", { file_path: `${CWD}/docs/שלום.md` }).label).toBe("Reading docs/שלום.md");
    expect(live("Edit", { file_path: "/tmp/مرحبا.txt" }).label).toBe("Editing مرحبا.txt");
  });
});

describe("commands: first words, no cd, no assignments", () => {
  const cmd = (command: string) => live("Bash", { command }).label;

  test("leading cd … && and cd …; are dropped, with quotes and several in a row", () => {
    expect(cmd("cd /Users/me/client-secret && bun test")).toBe("Running bun test");
    expect(cmd("cd '/a b/c' && cd d && git log")).toBe("Running git log");
    expect(cmd("cd /a&&ls -la")).toBe("Running ls -la");
    expect(cmd("cd /x; make")).toBe("Running make");
  });

  test("leading VAR=value assignments are dropped, quoted or exported", () => {
    expect(cmd("GITHUB_TOKEN=abc123 gh pr list")).toBe("Running gh pr list");
    expect(cmd("A=1 B=\"two words\" C='x' bun run build")).toBe("Running bun run build");
    expect(cmd("export PASSWORD=hunter2hunter2 && bun x")).not.toContain("hunter2");
    expect(cmd("cd /tmp && SECRET=zzz bun test")).toBe("Running bun test");
  });

  test("stops at |, &&, ||, ; and >", () => {
    expect(cmd("cat .env | grep KEY")).toBe("Running cat .env");
    expect(cmd("bun test && git push")).toBe("Running bun test");
    expect(cmd("bun test || echo failed")).toBe("Running bun test");
    expect(cmd("bun test; rm -rf /")).toBe("Running bun test");
    expect(cmd("echo $TOKEN > ~/.netrc")).toBe("Running echo $TOKEN");
  });

  test("only the first line, whatever the line breaks", () => {
    expect(cmd("git status\nrm -rf ~")).toBe("Running git status");
    expect(cmd("git status\r\nrm -rf ~")).toBe("Running git status");
    expect(cmd("\n\n  \n bun test\nsecond")).toBe("Running bun test");
    expect(cmd("git\tlog\t--oneline")).toBe("Running git log --oneline");
    expect(cmd('git commit -m "first line\nsecond line"')).not.toContain("second");
  });

  test("40 characters: at the limit whole, one past cut at a word", () => {
    const forty = "git push origin feature/abcdefghijklmnop";
    expect(forty.length).toBe(40);
    expect(cmd(forty)).toBe(`Running ${forty}`);
    const shown = cmd(`${forty}x`).replace(/^Running /, "");
    expect(shown.length).toBeLessThanOrEqual(40);
    expect(shown).toBe("git push origin…");
  });

  test("a secret in the command is redacted", () => {
    expect(cmd("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'")).not.toContain(
      "abcdefghijklmnop",
    );
    expect(cmd("env API_KEY=sk-proj-abcdefghijklmnopqrstuvwx bun x")).not.toContain("sk-proj-abcdefghij");
    expect(cmd("psql postgres://admin:hunter2pass@db/x")).not.toContain("hunter2");
    expect(cmd("echo ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("ghp_abc");
  });

  test("an empty or whitespace-only command", () => {
    expect(both("Bash", { command: "" })).toEqual(["Running a command", "Ran a command"]);
    expect(both("Bash", { command: " \n\t " })).toEqual(["Running a command", "Ran a command"]);
    expect(cmd("cd /tmp && ")).toBe("Running a command");
  });

  test("right-to-left text in a command stays on one line", () => {
    expect(cmd('git commit -m "שלום"')).toBe('Running git commit -m "שלום"');
  });
});

describe("patterns, agents and the 80-character limit", () => {
  test("a pattern at 30 characters shows whole; one past is cut to 30 with …", () => {
    expect(live("Grep", { pattern: "p".repeat(30) }).label).toBe(`Searching for “${"p".repeat(30)}”`);
    expect(live("Grep", { pattern: "p".repeat(31) }).label).toBe(`Searching for “${"p".repeat(29)}…”`);
  });

  test("a pattern with a line break is one line", () => {
    expect(live("Grep", { pattern: "a\nb\tc" }).label).toBe("Searching for “a b c”");
  });

  test("an agent description over 50 characters is cut; at 50 it is whole", () => {
    const d50 = "d".repeat(50);
    expect(live("Agent", { description: d50 }).label).toBe(`Running an agent: ${d50}`);
    const shown = live("Agent", { description: "d".repeat(51) }).label.replace(/^Running an agent: /, "");
    expect(shown).toBe(`${"d".repeat(49)}…`);
  });

  test("no label is over 80 characters or has a line break", () => {
    const inputs: [string, Record<string, unknown>][] = [
      ["Bash", { command: `x ${"y ".repeat(200)}` }],
      ["Read", { file_path: `${CWD}/${"z/".repeat(200)}f` }],
      ["Agent", { description: `a\nb\r\n${"w ".repeat(100)}` }],
      ["Glob", { pattern: "*".repeat(500) }],
      ["mcp__server__", {}],
      [`mcp__${"s".repeat(60)}__${"t".repeat(60)}`, {}],
      ["T".repeat(300), {}],
    ];
    for (const [tool, input] of inputs)
      for (const tense of ["live", "done"] as const) {
        const { label } = stepFor(tool, input, CWD, tense);
        expect(label.length).toBeLessThanOrEqual(80);
        expect(label).not.toMatch(/[\r\n]/);
      }
  });
});

describe("never sent", () => {
  test("file contents, edit text, tool output, URL paths, queries, prompts, plans", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["Write", { file_path: `${CWD}/a.ts`, content: "CONTENTX" }],
      ["Edit", { file_path: `${CWD}/a.ts`, old_string: "OLDX", new_string: "NEWX" }],
      ["MultiEdit", { file_path: `${CWD}/a.ts`, edits: [{ old_string: "OLDX", new_string: "NEWX" }] }],
      ["NotebookEdit", { notebook_path: `${CWD}/a.ipynb`, new_source: "NEWX" }],
      ["Read", { file_path: `${CWD}/a.ts`, offset: 1, limit: 2 }],
      ["Bash", { command: "ls", description: "DESCX" }],
      ["WebFetch", { url: "https://a.dev/PATHX?QUERYX=1", prompt: "PROMPTX" }],
      ["WebSearch", { query: "QUERYX" }],
      ["Agent", { prompt: "PROMPTX" }],
      ["ExitPlanMode", { plan: "PLANX" }],
      ["TodoWrite", { todos: [{ content: "TODOX" }] }],
      ["AskUserQuestion", { questions: [{ question: "QX" }] }],
      ["mcp__s__t", { body: "BODYX" }],
    ];
    const text = calls.flatMap(([t, i]) => [live(t, i).label, done(t, i).label]).join(" ");
    for (const word of [
      "CONTENTX",
      "OLDX",
      "NEWX",
      "DESCX",
      "PATHX",
      "QUERYX",
      "PROMPTX",
      "PLANX",
      "TODOX",
      "QX",
      "BODYX",
    ])
      expect(text).not.toContain(word);
  });
});

// ---------------------------------------------------------------------------------------------------

function setup(opts: { throttleMs?: number; thinkingDelayMs?: number; defaults?: boolean } = {}) {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = opts.defaults
    ? new StepTracker(events)
    : new StepTracker(events, {
        throttleMs: opts.throttleMs ?? 0,
        thinkingDelayMs: opts.thinkingDelayMs ?? 30,
      });
  const presence = {
    noteLocalActivity() {},
    get: () => ({ mode: "auto", away: false }),
  } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: { at: number; e: RelayEvent }[] = [];
  events.subscribe((e) => seen.push({ at: Date.now(), e }));
  const signal = new AbortController().signal;
  const hook = (event: string, fields: Record<string, unknown> = {}, sid = "s1") =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: sid, cwd: CWD, ...fields }, env: {} },
      signal,
    );
  const tool = (
    event: string,
    id: string,
    name: string,
    input: Record<string, unknown> = {},
    extra = {},
    sid = "s1",
  ) => hook(event, { tool_use_id: id, tool_name: name, tool_input: input, ...extra }, sid);
  const stepEvents = (sid?: string) =>
    seen.flatMap(({ at, e }) =>
      e.type === "turn.step" && (!sid || e.sessionId === sid) ? [{ at, e }] : [],
    ) as { at: number; e: Extract<RelayEvent, { type: "turn.step" }> }[];
  const labels = (sid?: string) => stepEvents(sid).map(({ e }) => e.step.label);
  const session = (sid = "s1") => publicSession(registry.get(sid) as SessionRecord);
  const call = async <T>(method: string, params: object): Promise<T> => {
    const res = await rpc(method as never, params as never, "device:x");
    if (!("result" in res)) throw new Error(JSON.stringify(res));
    return res.result as T;
  };
  const storedSteps = () =>
    (db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.step'").get() as { n: number }).n;
  const lastTurn = (): Turn => {
    const found = seen.findLast(({ e }) => e.type === "turn.done")?.e;
    if (found?.type !== "turn.done") throw new Error("no turn.done");
    return found.turn;
  };
  return {
    db,
    events,
    registry,
    steps,
    rpc,
    seen,
    hook,
    tool,
    stepEvents,
    labels,
    session,
    call,
    storedSteps,
    lastTurn,
  };
}

afterEach(() => resetLiveSteps());

describe("Thinking and live steps", () => {
  test("Thinking at the start, after a tool once the delay passes, and not before", async () => {
    const t = setup({ thinkingDelayMs: 150 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    expect(t.session().step?.kind).toBe("thinking");
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await Bun.sleep(60);
    expect(t.session().step?.label).toBe("Reading a.ts");
    await Bun.sleep(150);
    expect(t.session().step).toMatchObject({ kind: "thinking", label: "Thinking" });
    expect(t.labels()).toEqual(["Thinking", "Reading a.ts", "Thinking"]);
  });

  test("the real timings: one second throttle, Thinking 1.5 s after the last tool", async () => {
    const t = setup({ defaults: true });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Bash", { command: "bun test" });
    await t.tool("PostToolUse", "a", "Bash", { command: "bun test" });
    const ended = Date.now();
    await Bun.sleep(1200);
    expect(t.labels()).toEqual(["Thinking", "Running bun test"]);
    // Thinking is due at 1.5 s, and the throttle holds it to a second after "Running bun test" (sent at 1 s).
    await Bun.sleep(1000);
    expect(t.labels()).toEqual(["Thinking", "Running bun test", "Thinking"]);
    const thinkingAt = t.stepEvents().at(-1)?.at ?? 0;
    expect(thinkingAt - ended).toBeGreaterThanOrEqual(1450);
    const at = t.stepEvents().map((s) => s.at);
    for (let i = 1; i < at.length; i++) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(990);
  });

  test("a new tool inside the delay cancels Thinking", async () => {
    const t = setup({ thinkingDelayMs: 80 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    for (let i = 0; i < 5; i++) {
      await t.tool("PreToolUse", `r${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
      await t.tool("PostToolUse", `r${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
      await Bun.sleep(20);
    }
    expect(t.labels().slice(1)).not.toContain("Thinking");
    await Bun.sleep(120);
    expect(t.labels().at(-1)).toBe("Thinking");
  });

  test("Thinking doesn't come while a parallel tool still runs", async () => {
    const t = setup({ thinkingDelayMs: 20 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Bash", { command: "bun test" });
    await t.tool("PreToolUse", "b", "Read", { file_path: `${CWD}/b.ts` });
    await t.tool("PostToolUse", "b", "Read", { file_path: `${CWD}/b.ts` });
    await Bun.sleep(60);
    expect(t.session().step?.label).toBe("Running bun test");
  });

  test("a failed tool (PostToolUseFailure) ends the step like a finished one", async () => {
    const t = setup({ thinkingDelayMs: 20 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Bash", { command: "bun test" });
    await t.tool("PostToolUseFailure", "a", "Bash", { command: "bun test" }, { error: "exit 1" });
    await Bun.sleep(60);
    expect(t.session().step?.label).toBe("Thinking");
  });

  test("the live step never carries failed", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PostToolUseFailure", "a", "Bash", { command: "false" });
    for (const { e } of t.stepEvents()) expect("failed" in e.step).toBe(false);
  });

  test("the same line twice in a row is sent once", async () => {
    const t = setup({ thinkingDelayMs: 10_000 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PreToolUse", "b", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PreToolUse", "c", "Skill", {});
    await t.tool("PreToolUse", "d", "mcp__x__y", {});
    expect(t.labels()).toEqual(["Thinking", "Reading a.ts", "Running a skill", "Using y (x)"]);
  });

  test("two sessions are throttled separately", async () => {
    const t = setup({ throttleMs: 1000 });
    await t.hook("UserPromptSubmit", { prompt: "a" }, "s1");
    await t.hook("UserPromptSubmit", { prompt: "b" }, "s2");
    await t.tool("PreToolUse", "x", "Read", { file_path: `${CWD}/x.ts` }, {}, "s1");
    expect(t.labels("s1")).toEqual(["Thinking"]);
    expect(t.labels("s2")).toEqual(["Thinking"]);
    expect(t.session("s2").step?.label).toBe("Thinking");
    expect(t.session("s1").step?.label).toBe("Reading x.ts");
  });

  test("200 tool calls in a burst: at most one event a second, the newest wins", async () => {
    const t = setup({ throttleMs: 300, thinkingDelayMs: 10_000 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      await t.tool("PreToolUse", `t${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
      await t.tool("PostToolUse", `t${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
      if (i % 40 === 0) await Bun.sleep(100);
    }
    await Bun.sleep(400);
    const elapsed = Date.now() - start;
    const ev = t.stepEvents();
    expect(ev.length).toBeLessThanOrEqual(Math.ceil(elapsed / 300) + 1);
    for (let i = 1; i < ev.length; i++)
      expect((ev[i]?.at ?? 0) - (ev[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(290);
    expect(t.session().step?.label).toBe("Reading f199.ts");
    expect(ev.at(-1)?.e.step.label).toBe("Reading f199.ts");
  });

  test("a late PreToolUse for a tool that already finished doesn't bring it back", async () => {
    const t = setup({ thinkingDelayMs: 20 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PreToolUse", "b", "Bash", { command: "bun test" });
    await t.tool("PostToolUse", "b", "Bash", { command: "bun test" });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await Bun.sleep(50);
    await t.tool("PreToolUse", "b", "Bash", { command: "bun test" });
    await Bun.sleep(50);
    expect(t.session().step?.label).toBe("Thinking");
  });

  test("a PreToolUse that comes after Stop is dropped, and so is a late PostToolUse", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.hook("Stop", { last_assistant_message: "Done." });
    const n = t.labels().length;
    await t.tool("PreToolUse", "late", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "late2", "Read", { file_path: `${CWD}/a.ts` });
    expect(t.labels().length).toBe(n);
    expect("step" in t.session()).toBe(false);
    expect(t.storedSteps()).toBe(0);
  });

  test("Stop cancels a step still waiting for the throttle: nothing comes after turn.done", async () => {
    const t = setup({ throttleMs: 1000 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.hook("Stop", { last_assistant_message: "Done." });
    await Bun.sleep(1100);
    const types = t.seen.map(({ e }) => e.type);
    expect(types.lastIndexOf("turn.step")).toBeLessThan(types.indexOf("turn.done"));
    expect(t.storedSteps()).toBe(0);
  });

  test("a subagent's tools (agent_id) leave the agent's line and its list alone, whatever the order", async () => {
    const t = setup({ thinkingDelayMs: 20 });
    await t.hook("UserPromptSubmit", { prompt: "go", transcript_path: "/nonexistent.jsonl" });
    await t.tool("PreToolUse", "ag", "Agent", { description: "Survey the store" });
    const sub = { agent_id: "a1", agent_type: "Explore" };
    await t.tool("PreToolUse", "i1", "Read", { file_path: `${CWD}/x.ts` }, sub);
    await t.tool("PostToolUseFailure", "i1", "Read", { file_path: `${CWD}/x.ts` }, sub);
    await t.tool("PreToolUse", "i2", "Bash", { command: "ls" }, sub);
    expect(t.session().step?.label).toBe("Running an agent: Survey the store");
    await t.tool("PostToolUse", "ag", "Agent", { description: "Survey the store" });
    // The subagent's last tool's PostToolUse arrives after the Agent's own.
    await t.tool("PostToolUse", "i2", "Bash", { command: "ls" }, sub);
    await Bun.sleep(50);
    expect(t.labels()).not.toContain("Reading x.ts");
    expect(t.labels()).not.toContain("Running ls");
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(t.lastTurn().steps?.map((s) => s.label)).toEqual(["Ran an agent: Survey the store"]);
    expect(t.lastTurn().stats.toolCalls).toBe(1);
  });

  test("a session without PreToolUse moves with each PostToolUse and never shows Thinking between", async () => {
    const t = setup({ thinkingDelayMs: 10 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PostToolUse", "a", "Grep", { pattern: "foo" });
    await Bun.sleep(30);
    await t.tool("PostToolUse", "b", "Edit", { file_path: `${CWD}/a.ts` });
    await Bun.sleep(30);
    expect(t.labels()).toEqual(["Thinking", "Searching for “foo”", "Editing a.ts"]);
  });

  test("tool calls without a tool_use_id still show and end", async () => {
    const t = setup({ thinkingDelayMs: 20 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: `${CWD}/a.ts` } });
    expect(t.session().step?.label).toBe("Reading a.ts");
  });

  test("a step's label and kind match the TurnStep schema in every turn.step event", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "WebFetch", { url: "https://www.example.com/x" });
    for (const { e } of t.stepEvents()) {
      expect(RelayEventSchema.safeParse(e).success).toBe(true);
      expect(e.turnId).toMatch(/^t_/);
      expect(typeof e.seq).toBe("number");
    }
  });

  test("turn.step seqs keep rising, so apps never drop one as old", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    for (let i = 0; i < 5; i++) await t.tool("PreToolUse", `a${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
    const seqs = t.seen.map(({ e }) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("never pushed: no alert for any turn.step", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "AskUserQuestion", { questions: [] });
    await t.tool("PreToolUse", "b", "ExitPlanMode", { plan: "p" });
    expect(t.stepEvents().length).toBeGreaterThan(1);
    for (const { e } of t.stepEvents()) expect(alertFor(e, () => "Session")).toBeNull();
  });

  test("a new prompt while a turn is open starts over with Thinking and forgets the old turn's steps", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "one" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.hook("UserPromptSubmit", { prompt: "two" });
    expect(t.session().step?.label).toBe("Thinking");
    const turnIds = new Set(t.stepEvents().map(({ e }) => e.turnId));
    expect(turnIds.size).toBe(2);
    const rows = t.db.query("SELECT data_json FROM events WHERE type = 'turn.step'").all() as {
      data_json: string;
    }[];
    expect(rows.every((r) => !r.data_json.includes("Reading a.ts"))).toBe(true);
  });

  test("SessionEnd clears the live step and its stored events", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.hook("SessionEnd", { reason: "exit" });
    expect("step" in t.session()).toBe(false);
    expect(t.storedSteps()).toBe(0);
  });

  test("StopFailure ends the turn's steps like Stop", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go", transcript_path: "/nonexistent.jsonl" });
    await t.tool("PreToolUse", "a", "Bash", { command: "bun test" });
    await t.tool("PostToolUse", "a", "Bash", { command: "bun test" });
    await t.hook("StopFailure", { error: "rate_limit" });
    expect(t.lastTurn().failed).toBe(true);
    expect(t.lastTurn().steps?.map((s) => s.label)).toEqual(["Ran bun test"]);
    expect("step" in t.session()).toBe(false);
    expect(t.storedSteps()).toBe(0);
  });
});

describe("what a phone sees when it connects mid-turn", () => {
  test("session.live and Session.step carry the live form; the session.upsert of the turn carries it too", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    const upsert = t.seen.findLast(({ e }) => e.type === "session.upsert")?.e as Extract<
      RelayEvent,
      { type: "session.upsert" }
    >;
    expect(upsert.session.step?.label).toBe("Thinking");
    await t.tool("PreToolUse", "a", "Edit", { file_path: `${CWD}/a.ts` });
    const liveNow = await t.call<{ turnId: string; step?: TurnStep }>("session.live", { sessionId: "s1" });
    expect(liveNow.step).toMatchObject({ kind: "edit", label: "Editing a.ts" });
    expect(SessionSchema.safeParse(t.session()).success).toBe(true);
  });

  test("a sync snapshot (phone far behind) carries Session.step", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    const res = await t.call<{ snapshot?: { sessions: Session[] } }>("sync", { sinceSeq: 0 });
    if (res.snapshot)
      expect(res.snapshot.sessions.find((s) => s.id === "s1")?.step?.label).toBe("Reading a.ts");
  });

  test("a waiting session (an open prompt) still has its step for the snapshot", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Bash", { command: "rm x" });
    t.registry.setStatus("s1", "waiting");
    expect(t.session().step?.label).toBe("Running rm x");
  });

  test("after a helper restart nothing live is left: no step, no stale Thinking", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    resetLiveSteps();
    expect("step" in t.session()).toBe(false);
    const res = await t.call<{ step?: TurnStep } | null>("session.live", { sessionId: "s1" });
    expect(res && "step" in res).toBe(false);
  });

  test("unknown session: session.live is null or an error, never a step", async () => {
    const t = setup();
    const res = await t.rpc("session.live" as never, { sessionId: "nope" } as never, "device:x");
    if ("result" in res) expect(res.result).toBeNull();
  });
});

describe("sync and the events table", () => {
  test("1500 steps in a running turn don't push real events out of a 1000-event replay", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    const turnId = t.stepEvents()[0]?.e.turnId as string;
    const from = t.seen.at(-1)?.e.seq ?? 0;
    for (let i = 0; i < 1500; i++)
      t.events.emit({
        type: "turn.step",
        sessionId: "s1",
        turnId,
        step: { kind: "read", label: `Reading f${i}`, at: i },
      });
    t.events.emit({ type: "session.notice", sessionId: "s1", level: "info", text: "after the steps" });
    const res = await t.call<{ events: RelayEvent[] }>("sync", { sinceSeq: from });
    const steps = res.events.filter((e) => e.type === "turn.step");
    expect(steps.length).toBe(1);
    expect(steps[0]?.type === "turn.step" && steps[0].step.label).toBe("Reading f1499");
    expect(res.events.some((e) => e.type === "session.notice")).toBe(true);
  });

  test("two running turns in two sessions: the newest step of each", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "a" }, "s1");
    await t.hook("UserPromptSubmit", { prompt: "b" }, "s2");
    await t.tool("PreToolUse", "x", "Read", { file_path: `${CWD}/x.ts` }, {}, "s1");
    await t.tool("PreToolUse", "y", "Read", { file_path: `${CWD}/y.ts` }, {}, "s2");
    await t.tool("PreToolUse", "z", "Read", { file_path: `${CWD}/z.ts` }, {}, "s2");
    const res = await t.call<{ events: RelayEvent[] }>("sync", { sinceSeq: 1 });
    const labels = res.events.flatMap((e) =>
      e.type === "turn.step" ? [`${e.sessionId}:${e.step.label}`] : [],
    );
    expect(labels.sort()).toEqual(["s1:Reading x.ts", "s2:Reading z.ts"]);
  });

  test("a phone already past the newest step gets no step again", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    const last = t.seen.at(-1)?.e.seq ?? 0;
    await t.hook("Notification", { notification_type: "idle_prompt", message: "hi" });
    const res = await t.call<{ events: RelayEvent[] }>("sync", { sinceSeq: last });
    expect(res.events.some((e) => e.type === "turn.step")).toBe(false);
  });

  test("a finished turn's steps are deleted, its turn.done and other events stay", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go", transcript_path: "/nonexistent.jsonl" });
    for (let i = 0; i < 3; i++) {
      await t.tool("PreToolUse", `a${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
      await t.tool("PostToolUse", `a${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
    }
    expect(t.storedSteps()).toBeGreaterThan(0);
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(t.storedSteps()).toBe(0);
    const types = (t.db.query("SELECT type FROM events").all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.done");
  });
});

describe("a finished turn's list", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ts = (s: number) => new Date(1793620000000 + s * 1000).toISOString();
  function transcript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "relay-turn-steps-"));
    dirs.push(dir);
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
  }
  const prompt = (text = "Fix the cart", s = 0) => ({
    type: "user",
    timestamp: ts(s),
    message: { content: text },
  });
  const use = (id: string, name: string, input: object, s: number, extra = {}) => ({
    type: "assistant",
    timestamp: ts(s),
    message: { content: [{ type: "tool_use", id, name, input }] },
    ...extra,
  });
  const result = (id: string, isError: boolean, s: number, content = "OUTPUTX") => ({
    type: "user",
    timestamp: ts(s),
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] },
  });
  const answer = (s: number) => ({
    type: "assistant",
    timestamp: ts(s),
    message: { content: [{ type: "text", text: "Done." }] },
  });
  const thinking = (s: number) => ({
    type: "assistant",
    timestamp: ts(s),
    message: { content: [{ type: "thinking", thinking: "THINKINGX secret reasoning" }] },
  });

  async function stopWith(t: ReturnType<typeof setup>, path: string | null): Promise<Turn> {
    await t.hook("Stop", { last_assistant_message: "Done.", ...(path ? { transcript_path: path } : {}) });
    return t.lastTurn();
  }

  test("from the transcript: oldest first, Thinking left out, failed marked, at from the tool call", async () => {
    const t = setup();
    const path = transcript([
      prompt(),
      thinking(1),
      use("a", "Grep", { pattern: "total" }, 2),
      result("a", false, 3),
      thinking(4),
      use("b", "Edit", { file_path: `${CWD}/src/cart.ts`, old_string: "OLDX", new_string: "NEWX" }, 5),
      result("b", true, 6, "ERRORX"),
      use("c", "Bash", { command: "bun test" }, 7),
      result("c", false, 8),
      answer(9),
    ]);
    await t.hook("UserPromptSubmit", { prompt: "Fix the cart", transcript_path: path });
    const turn = await stopWith(t, path);
    expect(turn.steps?.map((s) => [s.kind, s.label, s.failed ?? false])).toEqual([
      ["search", "Searched for “total”", false],
      ["edit", "Edited src/cart.ts", true],
      ["run", "Ran bun test", false],
    ]);
    expect(turn.steps?.[0]?.at).toBe(Date.parse(ts(2)));
    expect(turn.stats.toolCalls).toBe(3);
    const json = JSON.stringify(turn);
    for (const w of ["THINKINGX", "OLDX", "NEWX", "OUTPUTX", "ERRORX"]) expect(json).not.toContain(w);
    expect(TurnSchema.safeParse(turn).success).toBe(true);
  });

  test("only the latest turn's tools, not the previous turn's", async () => {
    const t = setup();
    const path = transcript([
      prompt("first", 0),
      use("old", "Read", { file_path: `${CWD}/old.ts` }, 1),
      answer(2),
      prompt("second", 3),
      use("new", "Read", { file_path: `${CWD}/new.ts` }, 4),
      answer(5),
    ]);
    await t.hook("UserPromptSubmit", { prompt: "second", transcript_path: path });
    const turn = await stopWith(t, path);
    expect(turn.steps?.map((s) => s.label)).toEqual(["Read new.ts"]);
  });

  test("exactly 100 steps: no stepsMore; 101: stepsMore 1; steps + stepsMore equals toolCalls", async () => {
    for (const n of [100, 101]) {
      const t = setup();
      const lines: object[] = [prompt()];
      for (let i = 0; i < n; i++) lines.push(use(`u${i}`, "Read", { file_path: `${CWD}/f${i}.ts` }, 1));
      lines.push(answer(2));
      const path = transcript(lines);
      await t.hook("UserPromptSubmit", { prompt: "Fix the cart", transcript_path: path });
      const turn = await stopWith(t, path);
      expect(turn.steps?.length).toBe(100);
      expect(turn.steps?.[0]?.label).toBe("Read f0.ts");
      expect(turn.steps?.[99]?.label).toBe("Read f99.ts");
      expect(turn.stepsMore).toBe(n === 100 ? undefined : 1);
      expect((turn.steps?.length ?? 0) + (turn.stepsMore ?? 0)).toBe(turn.stats.toolCalls);
      expect(TurnSchema.safeParse(turn).success).toBe(true);
    }
  });

  test("without a transcript, 120 tool calls from the hooks: 100 steps, stepsMore 20, toolCalls 120", async () => {
    const t = setup({ throttleMs: 1000 });
    await t.hook("UserPromptSubmit", { prompt: "go", transcript_path: "/nonexistent.jsonl" });
    for (let i = 0; i < 120; i++) {
      await t.tool("PreToolUse", `h${i}`, "Read", { file_path: `${CWD}/f${i}.ts` });
      await t.tool(i === 5 ? "PostToolUseFailure" : "PostToolUse", `h${i}`, "Read", {
        file_path: `${CWD}/f${i}.ts`,
      });
    }
    const turn = await stopWith(t, null);
    expect(turn.steps?.length).toBe(100);
    expect(turn.stepsMore).toBe(20);
    expect(turn.stats.toolCalls).toBe(120);
    expect(turn.steps?.[5]?.failed).toBe(true);
    expect(turn.steps?.filter((s) => s.failed).length).toBe(1);
    expect(turn.steps?.every((s) => s.kind !== "thinking")).toBe(true);
  });

  test("the stored list comes back after a restart (file database reopened)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-steps-restart-"));
    dirs.push(dir);
    const file = join(dir, "relay.db");
    resetLiveSteps();
    let db = openDb(file);
    let events = new EventLog(db);
    const registry = new Registry(db, events);
    const hooks = new HookHandler({
      db,
      events,
      registry,
      broker: new Broker(db, events),
      presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
      config: { previewChars: 600 } as RelayConfig,
      steps: new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 }),
    });
    const h = (event: string, f: Record<string, unknown>) =>
      hooks.handle(
        { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...f }, env: {} },
        new AbortController().signal,
      );
    await h("UserPromptSubmit", { prompt: "go", transcript_path: "/nonexistent.jsonl" });
    await h("PreToolUse", { tool_use_id: "a", tool_name: "Bash", tool_input: { command: "bun test" } });
    await h("PostToolUseFailure", {
      tool_use_id: "a",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
    });
    await h("Stop", { last_assistant_message: "Done." });
    db.close();
    db = openDb(file);
    events = new EventLog(db);
    const rpc = createRpc({ db, events, registry: new Registry(db, events) } as unknown as RpcDeps);
    const res = await rpc("session.turns" as never, { sessionId: "s1", limit: 5 } as never, "device:x");
    const turn = ("result" in res ? (res.result as Turn[]) : [])[0];
    expect(turn?.steps).toEqual([
      expect.objectContaining({ kind: "run", label: "Ran bun test", failed: true }),
    ]);
    expect(turn && "stepsMore" in turn).toBe(false);
    db.close();
  });

  test("the database has turns.steps_json, and a corrupt or empty value gives no steps", async () => {
    const db = openDb(":memory:");
    const cols = (db.query("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("steps_json");
    const insert = db.query(
      "INSERT INTO turns (id, session_id, summary, stats_json, started_at, ended_at, steps_json) VALUES (?, 's1', 'x', NULL, ?, ?, ?)",
    );
    insert.run("t_bad", 1, 2, "{not json");
    insert.run("t_empty", 3, 4, JSON.stringify({ steps: [] }));
    insert.run("t_null", 5, 6, null);
    const events = new EventLog(db);
    const rpc = createRpc({ db, events, registry: new Registry(db, events) } as unknown as RpcDeps);
    const res = await rpc("session.turns" as never, { sessionId: "s1", limit: 10 } as never, "device:x");
    const turns = "result" in res ? (res.result as Turn[]) : [];
    expect(turns.length).toBe(3);
    for (const turn of turns) {
      expect("steps" in turn).toBe(false);
      expect("stepsMore" in turn).toBe(false);
    }
  });

  test("older turns read from the transcript: failed steps, 100 cap, no Thinking", () => {
    const lines: object[] = [
      prompt("one", 0),
      thinking(1),
      use("x", "Bash", { command: "make" }, 2),
      result("x", true, 3),
      answer(4),
      prompt("two", 5),
    ];
    for (let i = 0; i < 105; i++) lines.push(use(`r${i}`, "Read", { file_path: `${CWD}/r${i}.ts` }, 6));
    lines.push(answer(7));
    const turns = transcriptTurns("s1", transcript(lines), {
      limit: 5,
      previewChars: 600,
      working: false,
      cwd: CWD,
    });
    const one = turns.find((t) => t.steps?.[0]?.label === "Ran make");
    expect(one?.steps).toEqual([expect.objectContaining({ kind: "run", label: "Ran make", failed: true })]);
    const two = turns.find((t) => t.steps?.length === 100);
    expect(two?.stepsMore).toBe(5);
  });
});

describe("hooks and doctor", () => {
  test("PreToolUse is installed async; there are 11 Relay hook events", () => {
    const hooks = relayHooks("/x/relay-hook") as Record<string, { hooks: { async?: boolean }[] }[]>;
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.async).toBe(true);
    expect(Object.keys(hooks).length).toBe(11);
  });

  test("an install from before (10 hooks) counts short of 11; updating adds PreToolUse once", () => {
    const all = relayHooks("/x/relay-hook");
    const { PreToolUse: _, ...old } = all;
    const before = { hooks: old };
    expect(countHooks(before)).toBe(10);
    expect(countHooks(before)).toBeLessThan(Object.keys(all).length);
    const after = mergeHooks(before, "/x/relay-hook");
    expect(countHooks(after)).toBe(11);
    const again = mergeHooks(after, "/x/relay-hook");
    expect(countHooks(again)).toBe(11);
    expect(Object.keys(again.hooks as object)).toContain("PreToolUse");
  });
});

describe("fixtures: what the apps decode", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../protocol/fixtures/steps.json"), "utf8"),
  ) as { events: unknown[]; turn: unknown; session: unknown; live: { step?: unknown } };

  test("steps.json parses with the protocol: two events (thinking, then read), a turn, a session, a live reply", () => {
    const events = fixture.events.map((e) => RelayEventSchema.parse(e));
    expect(events.map((e) => (e.type === "turn.step" ? e.step.kind : e.type))).toEqual(["thinking", "read"]);
    const turn = TurnSchema.parse(fixture.turn);
    expect(turn.steps?.length).toBe(3);
    expect(turn.steps?.filter((s) => s.failed).length).toBe(1);
    expect(turn.stepsMore).toBe(37);
    expect(SessionSchema.parse(fixture.session).step).toBeTruthy();
    expect(TurnStepSchema.parse(fixture.live.step)).toBeTruthy();
  });

  test("an older app's shape: the turn and session without the new fields are still valid", () => {
    const { steps: _s, stepsMore: _m, ...oldTurn } = fixture.turn as Record<string, unknown>;
    const { step: _p, ...oldSession } = fixture.session as Record<string, unknown>;
    expect(TurnSchema.safeParse(oldTurn).success).toBe(true);
    expect(SessionSchema.safeParse(oldSession).success).toBe(true);
  });

  test("events.json has no turn.step (the apps count its events)", () => {
    const events = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../protocol/fixtures/events.json"), "utf8"),
    ) as {
      type: string;
    }[];
    expect(events.some((e) => e.type === "turn.step")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Over the real sockets: the daemon process and the hook client, in a throwaway RELAY_HOME and HOME.

const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const IT_HOME = join(ROOT, `relay-ts-${process.pid}`);
const PORT = 20000 + ((process.pid + 7919) % 20000);
const REPO = resolve(import.meta.dir, "../..");
const env: Record<string, string> = { RELAY_HOME: IT_HOME, HOME: IT_HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
const SOCK = join(IT_HOME, "hook.sock");

describe("end to end over the hook socket", () => {
  let daemon: ReturnType<typeof Bun.spawn> | null = null;
  const sid = "steps-e2e-1";
  const base = (event: string) => ({
    session_id: sid,
    hook_event_name: event,
    cwd: REPO,
    transcript_path: "/nonexistent.jsonl",
  });
  const runHook = async (payload: object) => {
    const proc = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
      stdin: new Blob([JSON.stringify(payload)]),
      stdout: "pipe",
      env,
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  };
  const admin = async <T>(method: string, params: object = {}): Promise<T> => {
    const res = await fetch("http://relay/admin/rpc", {
      method: "POST",
      unix: SOCK,
      body: JSON.stringify({ method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 6000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn().catch(() => null);
      if (v) return v;
      await Bun.sleep(50);
    }
    throw new Error("timed out waiting");
  };
  const liveStep = () => admin<{ step?: TurnStep } | null>("session.live", { sessionId: sid });

  beforeAll(async () => {
    rmSync(IT_HOME, { recursive: true, force: true });
    mkdirSync(IT_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(IT_HOME, "config.json"),
      JSON.stringify({ port: PORT, claudeBin: "/usr/bin/false", preferTyping: false }),
    );
    daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
      env,
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitFor(() => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok));
  });

  afterAll(() => {
    daemon?.kill();
    rmSync(IT_HOME, { recursive: true, force: true });
  });

  test("a turn's steps: live line over the socket, redacted, then the finished list and no step rows", async () => {
    await runHook(base("SessionStart"));
    await runHook({ ...base("UserPromptSubmit"), prompt: "Fix it" });
    await waitFor(async () => (await liveStep())?.step?.label === "Thinking");
    const pre = {
      ...base("PreToolUse"),
      tool_use_id: "toolu_1",
      tool_name: "Read",
      tool_input: { file_path: join(REPO, "protocol/index.ts") },
    };
    expect((await runHook(pre)).stdout).toBe("");
    await waitFor(async () => (await liveStep())?.step?.label === "Reading protocol/index.ts");
    const sessions = await admin<Session[]>("sessions.list");
    expect(sessions.find((s) => s.id === sid)?.step?.label).toBe("Reading protocol/index.ts");
    await runHook({
      ...base("PostToolUse"),
      tool_use_id: "toolu_1",
      tool_name: "Read",
      tool_input: pre.tool_input,
      tool_response: { file: "CONTENTX" },
    });
    await Bun.sleep(1100);
    const bash = {
      command:
        "cd /Users/me/secret && API_TOKEN=xyz123456 curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x",
    };
    await runHook({
      ...base("PreToolUse"),
      tool_use_id: "toolu_2",
      tool_name: "Bash",
      tool_input: bash,
    });
    const step = await waitFor(async () => {
      const s = (await liveStep())?.step;
      return s?.kind === "run" ? s : null;
    });
    expect(step.label.startsWith("Running curl")).toBe(true);
    for (const w of ["secret", "API_TOKEN", "xyz123456", "abcdefghijklmnop"])
      expect(step.label).not.toContain(w);
    await runHook({
      ...base("PostToolUseFailure"),
      tool_use_id: "toolu_2",
      tool_name: "Bash",
      tool_input: bash,
      error: "exit 7",
    });
    await runHook({ ...base("Stop"), last_assistant_message: "Done." });
    await waitFor(async () => (await liveStep()) === null);
    const turns = await admin<Turn[]>("session.turns", { sessionId: sid, limit: 5 });
    expect(turns[0]?.steps?.map((s) => [s.label, s.failed ?? false])).toEqual([
      ["Read protocol/index.ts", false],
      ["Ran curl -H 'Authorization: Bearer…", true],
    ]);
    expect(JSON.stringify(turns)).not.toContain("CONTENTX");
    const res = await admin<{ events?: RelayEvent[] }>("sync", { sinceSeq: 1 });
    expect((res.events ?? []).some((e) => e.type === "turn.step")).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------------
// Secrets cut at a limit, paths, wide characters, and a turn that ends mid-step.

describe("secrets cut at a limit, paths, wide characters, ending mid-step", () => {
  const SECRETS = [
    "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "sk_live_ABCDEFGHIJKLMNOPQRSTUVWX",
    "xoxb-1234567890-ABCDEFGHIJKLMNOP",
    "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij",
    "glpat-ABCDEFGHIJKLMNOPQRSTUV",
    "AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ012345678",
    "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.ABCDEFGHIJKLMNOP",
  ];
  const leaks = (label: string, secret: string) => label.includes(secret.slice(0, 12));

  test("no secret shape leaks its start when the 40-character cut falls inside it", () => {
    for (const secret of SECRETS)
      for (const command of [
        `curl https://h.dev/?k=${secret}`,
        `curl -sS ${secret}`,
        `echo ${secret}`,
        `X=1 wget -q https://api.x.io/${secret}/v1`,
      ])
        for (const tense of ["live", "done"] as const) {
          const { label } = stepFor("Bash", { command }, CWD, tense);
          expect(leaks(label, secret)).toBe(false);
        }
  });

  test("a Bearer token in a header flag doesn't leak, quoted or not", () => {
    const tok = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (const command of [
      `curl -H "Authorization: Bearer ${tok}" https://x`,
      `curl -H'Authorization: Bearer ${tok}' https://x`,
      `curl --header Authorization:\\ Bearer\\ ${tok}`,
      `http GET x Authorization:"Bearer ${tok}"`,
    ])
      expect(live("Bash", { command }).label).not.toContain(tok.slice(0, 10));
  });

  test("secrets in an agent description or a search pattern cut at 50 or 30 don't leak either", () => {
    for (const secret of SECRETS) {
      expect(leaks(live("Agent", { description: `Deploy with ${secret} now` }).label, secret)).toBe(false);
      expect(leaks(live("Grep", { pattern: `key ${secret}` }).label, secret)).toBe(false);
      expect(leaks(done("Read", { file_path: `${CWD}/${secret}.txt` }).label, secret)).toBe(false);
    }
  });

  test("relative paths and .. resolve against the project before choosing what to show", () => {
    const r = (file_path: string, cwd: string | null = CWD) =>
      stepFor("Read", { file_path }, cwd, "live").label;
    expect(r("../other-project/secret.md")).toBe("Reading secret.md");
    expect(r("src/../../../.aws/credentials")).toBe("Reading credentials");
    expect(r("./src/a.ts")).toBe("Reading src/a.ts");
    expect(r("src/./lib/../a.ts")).toBe("Reading src/a.ts");
    expect(r(`${CWD}/a/../b.ts`)).toBe("Reading b.ts");
    expect(r(`${CWD}//src///a.ts`)).toBe("Reading src/a.ts");
    expect(r(`${CWD}/src/a.ts`, `${CWD}/.`)).toBe("Reading src/a.ts");
    expect(r(`${CWD}/src/a.ts`, `${CWD}/sub/..`)).toBe("Reading src/a.ts");
    expect(r("../../x.ts", null)).toBe("Reading x.ts");
    expect(r(CWD)).toBe("Reading my-app");
  });

  test("a symlinked project folder: the other spelling shows only the name, never a folder", () => {
    // macOS: /tmp is /private/tmp; Claude Code may report either spelling.
    expect(stepFor("Read", { file_path: "/private/tmp/proj/src/a.ts" }, "/tmp/proj", "live").label).toBe(
      "Reading a.ts",
    );
    expect(stepFor("Read", { file_path: "/tmp/proj/src/a.ts" }, "/private/tmp/proj", "live").label).toBe(
      "Reading a.ts",
    );
  });

  test("no file label ever starts with / or names the home folder", () => {
    const files = [
      "/Users/me/.ssh/id_rsa",
      `${CWD}/../../Documents/tax.pdf`,
      "../../../../etc/passwd",
      `${CWD}-evil/x`,
      "/",
      "~/secret.txt",
    ];
    for (const file_path of files)
      for (const tool of ["Read", "Edit", "Write"]) {
        const shown = stepFor(tool, { file_path }, CWD, "done").label.replace(/^(Read|Edited) /, "");
        expect(shown.startsWith("/")).toBe(false);
        expect(shown).not.toContain("/Users");
        expect(shown).not.toContain("..");
      }
  });

  test("an 80-character label of ZWJ emoji: 80 characters, no split emoji, passes the schema", () => {
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const seg = (s: string) =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment);
    for (const e of ["👨‍👩‍👧‍👦", "👨🏻‍👩🏻‍👧🏻‍👦🏻", "🏳️‍🌈", "🇰🇿", "👩🏽‍💻"]) {
      const step = stepFor(`mcp__${e.repeat(90)}__x`, {}, CWD, "done");
      const chars = seg(step.label);
      expect(chars.length).toBe(80);
      expect(chars.at(-1)).toBe("…");
      expect(chars.slice(8, -1).every((c) => c === e)).toBe(true);
      expect(step.label).not.toMatch(loneSurrogate);
      expect(TurnStepSchema.safeParse({ ...step, at: 1 }).success).toBe(true);
      const agent = live("Agent", { description: e.repeat(60) }).label;
      expect(seg(agent.replace(/^Running an agent: /, ""))).toEqual([...Array(49).fill(e), "…"]);
      expect(TurnStepSchema.safeParse({ kind: "agent", label: agent, at: 1 }).success).toBe(true);
    }
  });

  test("the session ends (reconcile) mid-step: no more steps, no live step, no step rows", async () => {
    const t = setup({ thinkingDelayMs: 30 });
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Bash", { command: "bun test" });
    await t.tool("PreToolUse", "b", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "b", "Read", { file_path: `${CWD}/a.ts` });
    t.registry.setStatus("s1", "ended");
    const n = t.stepEvents().length;
    await t.tool("PostToolUse", "a", "Bash", { command: "bun test" });
    await t.tool("PreToolUse", "c", "Read", { file_path: `${CWD}/c.ts` });
    await Bun.sleep(80);
    expect(t.stepEvents().length).toBe(n);
    expect("step" in t.session()).toBe(false);
    const res = await t.call<{ step?: TurnStep } | null>("session.live", { sessionId: "s1" });
    expect(res?.step).toBeUndefined();
    expect(t.storedSteps()).toBe(0);
  });

  test("ending while a step waits for the throttle: nothing is sent after", async () => {
    for (const status of ["ended", "idle"] as const) {
      const t = setup({ throttleMs: 300 });
      await t.hook("UserPromptSubmit", { prompt: "go" });
      await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
      expect(t.labels()).toEqual(["Thinking"]);
      t.registry.setStatus("s1", status);
      await Bun.sleep(400);
      expect(t.labels()).toEqual(["Thinking"]);
      expect(t.storedSteps()).toBe(0);
    }
  });

  test("after going idle without a Stop, the next prompt starts a fresh line and list", async () => {
    const t = setup({ thinkingDelayMs: 10_000 });
    await t.hook("UserPromptSubmit", { prompt: "one", transcript_path: "/nonexistent.jsonl" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    await t.tool("PostToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    t.registry.setStatus("s1", "idle");
    await t.hook("UserPromptSubmit", { prompt: "two", transcript_path: "/nonexistent.jsonl" });
    expect(t.session().step?.label).toBe("Thinking");
    await t.tool("PreToolUse", "b", "Bash", { command: "make" });
    expect(t.session().step?.label).toBe("Running make");
    await t.tool("PostToolUse", "b", "Bash", { command: "make" });
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(t.lastTurn().steps?.map((s) => s.label)).toEqual(["Ran make"]);
  });

  test("a rename or pin while working (an upsert that isn't idle) keeps the live step", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.tool("PreToolUse", "a", "Read", { file_path: `${CWD}/a.ts` });
    t.registry.setStatus("s1", "waiting");
    t.registry.setStatus("s1", "working");
    expect(t.session().step?.label).toBe("Reading a.ts");
    expect(t.storedSteps()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Labels fit both 80 characters and the schema's size cap.

describe("labels made of heavy characters still fit the schema", () => {
  const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const chars = (s: string) =>
    [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
  const heavy = (base: string, marks: number, n: number) => (base + "́".repeat(marks)).repeat(n);
  const cases: [string, Record<string, unknown>][] = [
    ["Agent", { description: heavy("e", 80, 60) }],
    ["Agent", { description: heavy("e", 5000, 1) }],
    ["Bash", { command: `echo ${heavy("x", 200, 40)}` }],
    ["Bash", { command: heavy("x", 9000, 1) }],
    ["Grep", { pattern: heavy("😀", 200, 40) }],
    ["Read", { file_path: `/p/${heavy("a", 300, 100)}` }],
    [`mcp__${heavy("s", 6000, 1)}__t`, {}],
    [`mcp__${"👨🏻‍👩🏻‍👧🏻‍👦🏻".repeat(90)}__x`, {}],
  ];

  test("every tense: at most 80 characters, within the size cap, never half a character, valid", () => {
    for (const [tool, input] of cases)
      for (const tense of ["live", "done"] as const) {
        const step = stepFor(tool, input, "/p", tense);
        expect(chars(step.label)).toBeLessThanOrEqual(80);
        expect(step.label.length).toBeLessThanOrEqual(4000);
        expect(step.label).not.toMatch(loneSurrogate);
        expect(TurnStepSchema.safeParse({ ...step, at: 1 }).success).toBe(true);
      }
  });

  test("a label cut for size keeps its words and ends with one …", () => {
    const agent = live("Agent", { description: heavy("e", 80, 60) }).label;
    expect(agent.startsWith("Running an agent: ")).toBe(true);
    expect(agent.endsWith("…")).toBe(true);
    expect(agent.endsWith("……")).toBe(false);
    expect(live("Agent", { description: heavy("e", 5000, 1) }).label).toBe("Running an agent: …");
  });

  test("the cap: 4000 units pass the schema, 4001 don't; 80 skin-tone families fit", () => {
    expect(TurnStepSchema.safeParse({ kind: "other", label: `${"x".repeat(79)}…`, at: 1 }).success).toBe(
      true,
    );
    const fam = "👨🏻‍👩🏻‍👧🏻‍👦🏻".repeat(80);
    expect(TurnStepSchema.safeParse({ kind: "other", label: fam, at: 1 }).success).toBe(true);
    const at4000 = heavy("e", 3999, 1);
    expect(at4000.length).toBe(4000);
    expect(TurnStepSchema.safeParse({ kind: "other", label: at4000, at: 1 }).success).toBe(true);
    expect(TurnStepSchema.safeParse({ kind: "other", label: heavy("e", 4000, 1), at: 1 }).success).toBe(
      false,
    );
  });

  test("a heavy label survives a Stop: the finished turn is valid and stored", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go", transcript_path: "/nonexistent.jsonl" });
    const input = { description: heavy("e", 80, 60) };
    await t.tool("PreToolUse", "a", "Agent", input);
    await t.tool("PostToolUse", "a", "Agent", input);
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(TurnSchema.safeParse(t.lastTurn()).success).toBe(true);
    for (const { e } of t.stepEvents()) expect(RelayEventSchema.safeParse(e).success).toBe(true);
    const turns = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 5 });
    expect(turns[0]?.steps?.[0]?.label).toBe(t.lastTurn().steps?.[0]?.label);
  });
});

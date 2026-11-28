import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphemes,
  RELAY_FRAME_BYTES,
  type RelayEvent,
  TURN_ACTIONS_LIVE_MAX,
  TURN_STEP_OUTPUT_LINES,
  TURN_STEP_OUTPUT_MAX,
  TURN_STEP_OUTPUT_UNITS,
  TURN_STEPS_MAX,
  type Turn,
  TurnStep,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { alertFor, apnsPayload, fcmMessage, fitAlert } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { fitEvent } from "../src/daemon/promptFit.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps, type RpcOpts } from "../src/daemon/rpc.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { shownOutput, TimelineReader } from "../src/daemon/timeline.ts";
import { formatEvent } from "../src/tailFormat.ts";

// A shell command's step carries the end of what the command printed, once it has ended: redacted and cleaned.

const CWD = "/Users/me/Projects/my-app";
const MARKER = "MARKER_OUTPUT_TEXT";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyzTAILMARK99";
const ESC = "\x1b";

const iso = (at: number) => new Date(at).toISOString();
const use = (id: string, name: string, input: object, at: number, extra: object = {}) => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name, input }] },
  ...extra,
});
/** A command that ended, as Claude Code writes it: the text for Claude, and the entry's own `toolUseResult`. */
const ended = (id: string, at: number, stdout: string, stderr = "", more: object = {}) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: iso(at),
  message: {
    content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: `${stdout}${stderr}` }],
  },
  toolUseResult: { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false, ...more },
});
/** A call that failed: its text starts with "Exit code N" when the command ran, and `toolUseResult` is a string. */
const failed = (id: string, at: number, text: string) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] },
  toolUseResult: `Error: ${text}`,
});
const bash = (id: string, at: number, command = "bun test") => use(id, "Bash", { command }, at);
const outputOf = (s: TurnStep | undefined) => ({
  ...(s?.output !== undefined ? { output: s.output } : {}),
  ...(s?.outputCut !== undefined ? { outputCut: s.outputCut } : {}),
});
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
/** Exactly the cap: TURN_STEP_OUTPUT_LINES lines and TURN_STEP_OUTPUT_MAX characters, line breaks included. */
const AT_CAP = Array.from({ length: TURN_STEP_OUTPUT_LINES }, (_, i) =>
  `${i}`.padEnd(TURN_STEP_OUTPUT_MAX / TURN_STEP_OUTPUT_LINES - 1, "x"),
)
  .join("\n")
  .concat("x");

describe("cleaning", () => {
  test("a short output is sent as it is, without the line break at its end", () => {
    expect(shownOutput("2 pass\n0 fail\n")).toEqual({ output: "2 pass\n0 fail" });
    expect(shownOutput("\tindented\n\n  kept")).toEqual({ output: "\tindented\n\n  kept" });
  });

  test("an output that is empty or only white space sends nothing", () => {
    for (const text of ["", "\n", "  \n\t\n  ", "\r\n\r\n", `${ESC}[0m\n`, "\x00\x07"])
      expect([text, shownOutput(text)]).toEqual([text, {}]);
  });

  test("a secret in the output is redacted", () => {
    const shown = shownOutput(
      `deploying\nGITHUB_TOKEN=${TOKEN}\nAuthorization: Bearer abc123def456ghi789\ndone`,
    );
    expect(shown.output).toContain("[redacted:");
    expect(shown.output).toContain("done");
    expect(shown.output).not.toContain("TAILMARK");
    expect(shown.output).not.toContain("abc123def456ghi789");
  });

  test("a secret across the cut leaves neither of its halves", () => {
    for (const after of [TURN_STEP_OUTPUT_MAX - 10, TURN_STEP_OUTPUT_MAX - 30, TURN_STEP_OUTPUT_MAX - 39]) {
      const shown = shownOutput(`${"a ".repeat(3000)}${TOKEN}${" b".repeat(after / 2)}`);
      expect(shown.outputCut).toBe(true);
      expect(shown.output).not.toContain("TAILMARK");
      expect(shown.output).not.toContain("MARK99");
      expect(shown.output).not.toContain("ghp_");
    }
    const key = `-----BEGIN PRIVATE KEY-----\n${numbered(40).join("\n")}\nKEYTAIL\n-----END PRIVATE KEY-----`;
    const lines = shownOutput(`${key}\nok`);
    expect(lines.output).toBe("[redacted:private-key]\nok");
  });

  test("a secret that an escape sequence splits or colours is still redacted", () => {
    for (const text of [
      `ghp_abcdefghij${ESC}[0mklmnopqrstuvwxyzTAILMARK99`,
      `GITHUB_TOKEN${ESC}[m=${ESC}[32m${TOKEN}${ESC}[0m`,
      `API_KEY=${ESC}[1mtailmark-Zx81kQp2${ESC}[0m`,
      "API_KEY=tailma\x08rk-Zx81kQp2",
    ]) {
      const shown = shownOutput(text).output ?? "";
      expect([text, shown.toLowerCase().includes("tailmark")]).toEqual([text, false]);
      expect(shown).toContain("[redacted:");
    }
  });

  test("escape sequences and control characters are removed; line breaks and tabs stay", () => {
    const text = [
      `${ESC}[1;32m✓${ESC}[0m passed${ESC}[K`,
      `${ESC}]0;window title\x07title gone`,
      `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`,
      `${ESC}(Bcharset ${ESC}[?25hcursor ${ESC}Mindex`,
      "bell\x07 back\x08space null\x00 del\x7f c1\x9b form\x0c feed",
      "tab\there ‮reversed",
    ].join("\n");
    expect(shownOutput(text).output).toBe(
      [
        "✓ passed",
        "title gone",
        "link",
        "charset cursor index",
        "bell backspace null del c1 form feed",
        "tab\there reversed",
      ].join("\n"),
    );
  });

  test("Windows line endings become line breaks, and a rewritten line keeps its last text", () => {
    expect(shownOutput("a\r\nb\r\n\r\nc\r\n")).toEqual({ output: "a\nb\n\nc" });
    expect(shownOutput("10%\r50%\r100%\r\ndone\r")).toEqual({ output: "100%\ndone" });
  });

  test("more lines than the cap: the last ones are kept and the step says it was cut", () => {
    const shown = shownOutput(numbered(TURN_STEP_OUTPUT_LINES + 10).join("\n"));
    expect(shown).toEqual({
      output: numbered(TURN_STEP_OUTPUT_LINES + 10)
        .slice(10)
        .join("\n"),
      outputCut: true,
    });
    expect(shownOutput(numbered(TURN_STEP_OUTPUT_LINES).join("\n"))).toEqual({
      output: numbered(TURN_STEP_OUTPUT_LINES).join("\n"),
    });
  });

  test("more characters than the cap: the end is kept, from the start of a line", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i}:${"x".repeat(400)}`);
    const shown = shownOutput(lines.join("\n"));
    expect(shown.outputCut).toBe(true);
    expect(shown.output).toBe(lines.slice(-4).join("\n"));
    expect(graphemes(shown.output ?? "").length).toBeLessThanOrEqual(TURN_STEP_OUTPUT_MAX);
  });

  test("an output of exactly the cap is sent whole, and one character more is cut", () => {
    expect(AT_CAP.length).toBe(TURN_STEP_OUTPUT_MAX);
    expect(shownOutput(AT_CAP)).toEqual({ output: AT_CAP });
    expect(shownOutput(`${AT_CAP}\n`)).toEqual({ output: AT_CAP });
    const over = shownOutput(`y${AT_CAP}`);
    expect(over.outputCut).toBe(true);
    expect(over.output).toBe(AT_CAP.slice(AT_CAP.indexOf("\n") + 1));
  });

  test("one very long line keeps its last characters", () => {
    const shown = shownOutput(`${"x".repeat(5000)}END`);
    expect(shown.outputCut).toBe(true);
    expect(shown.output).toHaveLength(TURN_STEP_OUTPUT_MAX);
    expect(shown.output?.endsWith("xEND")).toBe(true);
  });

  test("characters are never split, and the result fits the protocol", () => {
    for (const ch of ["👨‍👩‍👧‍👦", "🇰🇿", "é", "é̂̃", "😀"]) {
      const shown = shownOutput(ch.repeat(TURN_STEP_OUTPUT_MAX + 500));
      const g = graphemes(shown.output ?? "");
      expect(shown.outputCut).toBe(true);
      expect(g.length).toBeLessThanOrEqual(TURN_STEP_OUTPUT_MAX);
      expect(shown.output?.length).toBeLessThanOrEqual(TURN_STEP_OUTPUT_UNITS);
      expect([ch, g.every((x) => x === ch)]).toEqual([ch, true]);
      expect(TurnStep.safeParse({ kind: "run", label: "Ran x", at: 1, ...shown }).success).toBe(true);
    }
  });

  test("an output that looks binary leaves only what can be shown", () => {
    const bytes = Array.from({ length: 4096 }, (_, i) => String.fromCharCode((i * 37) % 256)).join("");
    const shown = shownOutput(`\x7fELF\x02\x01\x01\x00${bytes}��`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must be gone
    expect(shown.output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(TurnStep.safeParse({ kind: "run", label: "Ran x", at: 1, ...shown }).success).toBe(true);
  });

  test("a huge output is cut fast", () => {
    const inputs = [
      `${"2026-11-19 12:00:00 INFO request took 12ms\n".repeat(24_000)}${MARKER}`,
      `${"x".repeat(1_000_000)}${MARKER}`,
      `${"\r".repeat(1_000_000)}${MARKER}`,
      `${`${ESC}]`.repeat(500_000)}\n${MARKER}`,
      `${`${ESC}[32mok${ESC}[0m\r\n`.repeat(70_000)}${MARKER}`,
    ];
    for (const text of inputs) {
      const started = performance.now();
      const shown = shownOutput(text);
      expect(performance.now() - started).toBeLessThan(3000);
      expect(shown.output?.endsWith(MARKER)).toBe(true);
      expect(graphemes(shown.output ?? "").length).toBeLessThanOrEqual(TURN_STEP_OUTPUT_MAX);
    }
  });
});

describe("the timeline reader", () => {
  test("a command's step is returned again with its output when the result arrives", () => {
    const r = new TimelineReader(CWD, 0);
    const [sent] = r.add(bash("b", 10));
    expect(sent).toMatchObject({ kind: "run", id: "b" });
    expect(sent).not.toHaveProperty("output");
    const [again] = r.add(ended("b", 20, "2 pass\n0 fail\n"));
    expect(again).toMatchObject({ kind: "run", id: "b", output: "2 pass\n0 fail" });
    expect(again).not.toHaveProperty("outputCut");
    expect(again).not.toHaveProperty("failed");
    expect(r.add(ended("b", 30, "2 pass\n0 fail\n"))).toEqual([]);
    expect(TurnStep.safeParse(again).success).toBe(true);
  });

  test("standard output comes first, then standard error; standard error alone is sent too", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(bash("both", 10));
    r.add(ended("both", 20, "built\n", "warning: unused\n"));
    r.add(bash("err", 30));
    r.add(ended("err", 40, "", "warning: only this\n"));
    expect(r.actions.map(outputOf)).toEqual([
      { output: "built\nwarning: unused" },
      { output: "warning: only this" },
    ]);
  });

  test("Claude Code's own note about the folder is not the command's output", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(bash("n", 10));
    expect(r.add(ended("n", 20, "", `\nShell cwd was reset to ${CWD}`)).map(outputOf)).toEqual([{}]);
    r.add(bash("o", 30));
    r.add(ended("o", 40, "ok", `\nShell cwd was reset to ${CWD}`));
    expect(r.actions.map(outputOf)).toEqual([{}, { output: "ok" }]);
    expect(JSON.stringify(r.actions)).not.toContain("Shell cwd");
  });

  test("a command that printed nothing gets a second event for its time only", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(bash("q", 10));
    expect(r.add(ended("q", 20, "", "")).map(outputOf)).toEqual([{}]);
    r.add(bash("bg", 30));
    expect(r.add(ended("bg", 40, "", "", { backgroundTaskId: "bx1" }))).toEqual([]);
    expect(r.actions.map(outputOf)).toEqual([{}, {}]);
  });

  test("a command moved to the background is still running: what it printed so far is not sent", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(bash("bg", 10, "bun run dev"));
    expect(
      r.add(ended("bg", 20, `${MARKER}\n`, "", { backgroundTaskId: "bx1", timedOutAfterMs: 120_000 })),
    ).toEqual([]);
    expect(JSON.stringify(r.actions)).not.toContain(MARKER);
  });

  test("a failed command keeps its output, without the exit code line", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(bash("f", 10));
    const [again] = r.add(failed("f", 20, `Exit code 1\n${numbered(25).join("\n")}\nerror: ${MARKER}`));
    expect(again).toMatchObject({ id: "f", failed: true, outputCut: true });
    expect(again?.output?.split("\n")).toEqual([...numbered(25).slice(6), `error: ${MARKER}`]);
    r.add(bash("silent", 30));
    const [silent] = r.add(failed("silent", 40, "Exit code 2"));
    expect(silent).toMatchObject({ id: "silent", failed: true });
    expect(outputOf(silent)).toEqual({});
  });

  test("a failed command's output ends with the command's last line, not with Claude Code's own", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(bash("note", 10));
    const [noted] = r.add(
      failed("note", 20, `Exit code 1\nerror: no such file\n\nShell cwd was reset to ${CWD}`),
    );
    expect(outputOf(noted)).toEqual({ output: "error: no such file" });
    r.add(bash("long", 30));
    const [long] = r.add(
      failed("long", 40, `Exit code 1\n<persisted-output>\nOutput too large. ${MARKER}\n</persisted-output>`),
    );
    expect(long).toMatchObject({ id: "long", failed: true });
    expect(JSON.stringify(r.actions)).not.toContain(MARKER);
  });

  test("a call that never ran has no output: what Claude Code says about it is not sent", () => {
    const r = new TimelineReader(CWD, 0);
    const refusals = [
      `The user doesn't want to proceed with this tool use. ${MARKER}`,
      `Permission to use Bash has been denied. ${MARKER}`,
      `<tool_use_error>${MARKER}</tool_use_error>`,
    ];
    refusals.forEach((text, i) => {
      r.add(bash(`x${i}`, i * 10 + 1));
      const [again] = r.add(failed(`x${i}`, i * 10 + 2, text));
      expect(again).toMatchObject({ failed: true });
    });
    expect(JSON.stringify(r.actions)).not.toContain(MARKER);
  });

  test("output on a tool that isn't a shell command is never sent", () => {
    const r = new TimelineReader(CWD, 0);
    const tools: [string, object][] = [
      ["Read", { file_path: `${CWD}/a.ts` }],
      ["Edit", { file_path: `${CWD}/a.ts`, old_string: "a", new_string: "b" }],
      ["Write", { file_path: `${CWD}/a.ts`, content: "a" }],
      ["Grep", { pattern: "x" }],
      ["Glob", { pattern: "*.ts" }],
      ["WebFetch", { url: "https://example.com/a" }],
      ["WebSearch", { query: "x" }],
      ["Agent", { description: "Look", prompt: "p" }],
      ["TaskOutput", { task_id: "b1" }],
      ["PowerShell", { command: "Get-ChildItem" }],
      ["mcp__server__run", { command: "ls" }],
    ];
    tools.forEach(([name, input], i) => {
      r.add(use(`t${i}`, name, input, i * 10 + 1));
      r.add(ended(`t${i}`, i * 10 + 2, `${MARKER}\n`, MARKER));
    });
    expect(r.actions).toHaveLength(tools.length);
    expect(r.actions.some((s) => s.kind === "run")).toBe(false);
    expect(JSON.stringify(r.actions)).not.toContain(MARKER);
    r.add(use("bad", "Read", { file_path: `${CWD}/a.ts` }, 500));
    r.add(failed("bad", 501, `Exit code 1\n${MARKER}`));
    expect(JSON.stringify(r.actions)).not.toContain(MARKER);
  });

  test("a result without the command's own record sends nothing", () => {
    const r = new TimelineReader(CWD, 0);
    const plain = (id: string, at: number, extra: object = {}) => ({
      type: "user",
      uuid: `r-${id}`,
      timestamp: iso(at),
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: MARKER }] },
      ...extra,
    });
    r.add(bash("none", 1));
    r.add(plain("none", 2));
    r.add(bash("text", 3));
    r.add(plain("text", 4, { toolUseResult: MARKER }));
    r.add(bash("list", 5));
    r.add(plain("list", 6, { toolUseResult: [{ type: "text", text: MARKER }] }));
    r.add(bash("image", 7));
    r.add(ended("image", 8, MARKER, "", { isImage: true }));
    r.add(bash("start", 9));
    r.add(ended("start", 10, MARKER, "", { persistedOutputPath: "/tmp/o.txt", persistedOutputSize: 90_000 }));
    r.add(bash("odd", 11));
    r.add(plain("odd", 12, { toolUseResult: { stdout: 7, stderr: null } }));
    r.add(bash("two-a", 13));
    r.add(bash("two-b", 14));
    r.add({
      type: "user",
      uuid: "r-two",
      timestamp: iso(15),
      message: {
        content: [
          { type: "tool_result", tool_use_id: "two-a", content: "a" },
          { type: "tool_result", tool_use_id: "two-b", content: "b" },
        ],
      },
      toolUseResult: { stdout: MARKER, stderr: "" },
    });
    expect(r.actions).toHaveLength(8);
    expect(JSON.stringify(r.actions)).not.toContain(MARKER);
  });

  test("an agent's own commands don't carry output into its steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-command-output-agent-"));
    dirs.push(dir);
    const path = join(dir, "sess.jsonl");
    const subs = join(dir, "sess", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(use("toolu_A", "Agent", { description: "Test", prompt: "p" }, 0))}\n`,
    );
    writeFileSync(
      join(subs, "agent-a1.meta.json"),
      JSON.stringify({ toolUseId: "toolu_A", finished: false }),
    );
    const side = { isSidechain: true, agentId: "a1" };
    writeFileSync(
      join(subs, "agent-a1.jsonl"),
      [
        use("sub1", "Bash", { command: "bun test" }, 1000, side),
        { ...ended("sub1", 1100, `${MARKER}\n`), ...side },
        use("sub2", "Bash", { command: "bun run build" }, 1200, side),
        { ...failed("sub2", 1300, `Exit code 1\n${MARKER}`), ...side },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join(""),
    );
    const reader = new TimelineReader(CWD, 0, { transcriptPath: path });
    reader.add(JSON.parse(readFileSync(path, "utf8")));
    reader.refreshAgents();
    const agent = reader.actions[0] as TurnStep;
    expect(agent.children?.map((c) => [c.kind, c.failed ?? false])).toEqual([
      ["run", false],
      ["run", true],
    ]);
    expect(JSON.stringify(agent)).not.toContain(MARKER);
    expect(TurnStep.safeParse(agent).success).toBe(true);
  });
});

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PHONE: RpcOpts = { overRelay: true, pieces: true };
const OLD_PHONE: RpcOpts = { overRelay: true };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-command-output-"));
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
    seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>;
  const liveActions = async (opts: RpcOpts = PHONE) => {
    const live = await rpc("session.live", { sessionId: "s1" }, "device:x", opts);
    return ("result" in live ? (live.result as { actions?: TurnStep[] } | null)?.actions : undefined) ?? [];
  };
  const storedTurn = async (opts: RpcOpts = PHONE) => {
    const res = await rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x", opts);
    return "result" in res ? (res.result as Turn[])[0] : undefined;
  };
  return { hook, append, actions, done, liveActions, storedTurn, seen, rpc, events };
}

const hookTool = (id: string, command: string) => ({
  tool_use_id: id,
  tool_name: "Bash",
  tool_input: { command },
});

describe("live and finished", () => {
  test("the step is sent again with the same id when the command ends, and every copy agrees", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Test it" });
    const s = Date.now();
    t.append(bash("b", s + 100));
    await t.hook("PreToolUse", hookTool("b", "bun test"));
    expect(t.actions().map((e) => [e.step.id, outputOf(e.step)])).toEqual([["b", {}]]);
    expect((await t.liveActions()).map(outputOf)).toEqual([{}]);

    t.append(ended("b", s + 200, `${numbered(30).join("\r\n")}\r\n`));
    await t.hook("PostToolUse", hookTool("b", "bun test"));
    const expected = { output: numbered(30).slice(10).join("\n"), outputCut: true };
    expect(t.actions().map((e) => [e.step.id, outputOf(e.step)])).toEqual([
      ["b", {}],
      ["b", expected],
    ]);
    expect((await t.liveActions()).map((x) => [x.id, outputOf(x)])).toEqual([["b", expected]]);

    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(t.done().turn.steps?.map((x) => [x.id, outputOf(x)])).toEqual([["b", expected]]);
    expect((await t.storedTurn())?.steps?.map((x) => [x.id, outputOf(x)])).toEqual([["b", expected]]);
    for (const step of [...t.actions().map((e) => e.step), ...(t.done().turn.steps ?? [])])
      expect(TurnStep.safeParse(step).success).toBe(true);
  });

  test("a failed command is sent again once, failed and with its output", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Build it" });
    const s = Date.now();
    t.append(bash("f", s + 100, "bun run build"));
    await t.hook("PreToolUse", hookTool("f", "bun run build"));
    t.append(failed("f", s + 200, "Exit code 1\nerror: no such file"));
    await t.hook("PostToolUseFailure", hookTool("f", "bun run build"));
    const expected = { output: "error: no such file" };
    expect(t.actions().map((e) => [e.step.id, e.step.failed ?? false, outputOf(e.step)])).toEqual([
      ["f", false, {}],
      ["f", true, expected],
    ]);
    expect((await t.liveActions()).map((x) => [x.failed, outputOf(x)])).toEqual([[true, expected]]);
    await t.hook("Stop", { last_assistant_message: "Could not." });
    expect(t.done().turn.steps?.map((x) => [x.id, x.failed, outputOf(x)])).toEqual([["f", true, expected]]);
    expect((await t.storedTurn())?.steps?.map(outputOf)).toEqual([expected]);
  });

  test("a command with no output is sent again for its time only, and other tools stay as they were", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x" });
    const s = Date.now();
    t.append(
      bash("quiet", s + 100, "mkdir out"),
      ended("quiet", s + 150, ""),
      use("r", "Read", { file_path: `${CWD}/a.ts` }, s + 200),
      ended("r", s + 250, MARKER),
    );
    await t.hook("PostToolUse", hookTool("quiet", "mkdir out"));
    expect(t.actions().map((e) => [e.step.id, outputOf(e.step)])).toEqual([
      ["quiet", {}],
      ["quiet", {}],
      ["r", {}],
      ["r", {}],
    ]);
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(JSON.stringify(t.seen)).not.toContain(MARKER);
  });

  test("without a transcript, the hooks' steps have no output, whatever the hook carries", async () => {
    const t = setup();
    const none = { transcript_path: "/nonexistent.jsonl" };
    await t.hook("UserPromptSubmit", { prompt: "x", ...none });
    await t.hook("PreToolUse", { ...hookTool("h", "bun test"), ...none });
    await t.hook("PostToolUse", {
      ...hookTool("h", "bun test"),
      ...none,
      tool_response: { stdout: MARKER, stderr: MARKER, interrupted: false, isImage: false },
    });
    await t.hook("Stop", { last_assistant_message: "Done.", ...none });
    expect(t.done().turn.steps?.map((x) => [x.id, x.kind, outputOf(x)])).toEqual([["h", "run", {}]]);
    expect(JSON.stringify(t.seen)).not.toContain(MARKER);
  });
});

describe("phones that take a message in one frame", () => {
  test("they get every step without its output, and a full turn still fits a frame", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Run them all" });
    const s = Date.now();
    const lines: object[] = [];
    for (let i = 0; i < TURN_ACTIONS_LIVE_MAX; i++)
      lines.push(bash(`c${i}`, s + i * 2 + 1, `bun test ${i}`), ended(`c${i}`, s + i * 2 + 2, AT_CAP));
    t.append(...lines);
    await t.hook("PostToolUse", hookTool("c0", "bun test 0"));
    const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

    const live = await t.liveActions(PHONE);
    expect(live).toHaveLength(TURN_ACTIONS_LIVE_MAX);
    expect(live.every((x) => x.output === AT_CAP)).toBe(true);
    const liveOld = await t.rpc("session.live", { sessionId: "s1" }, "device:x", OLD_PHONE);
    expect(JSON.stringify(liveOld)).not.toContain("output");
    expect(bytes({ type: "rpc", id: 1, ...liveOld })).toBeLessThan(RELAY_FRAME_BYTES);
    const withLive = await t.rpc("session.turns", { sessionId: "s1", withLive: true }, "device:x", OLD_PHONE);
    expect(JSON.stringify(withLive)).not.toContain("output");
    const replay = await t.rpc("sync", { sinceSeq: 1 }, "device:x", OLD_PHONE);
    expect(JSON.stringify(replay)).toContain("turn.action");
    expect(JSON.stringify(replay)).not.toContain("output");

    const action = t.actions().find((e) => e.step.output !== undefined) as RelayEvent;
    expect(JSON.stringify(fitEvent(action))).not.toContain("output");
    expect(fitEvent(t.actions()[0] as RelayEvent)).toBe(t.actions()[0] as RelayEvent);

    await t.hook("Stop", { last_assistant_message: "Done." });
    const done = t.done();
    expect(done.turn.steps).toHaveLength(TURN_STEPS_MAX);
    expect(done.turn.steps?.every((x) => x.output === AT_CAP)).toBe(true);
    expect(bytes({ type: "event", event: done })).toBeGreaterThan(RELAY_FRAME_BYTES / 2);
    const fitted = fitEvent(done);
    expect(JSON.stringify(fitted)).not.toContain("output");
    expect(bytes({ type: "event", event: fitted })).toBeLessThan(RELAY_FRAME_BYTES);
    expect(fitted.turn.steps?.map((x) => x.detail)).toEqual(done.turn.steps?.map((x) => x.detail));

    expect((await t.storedTurn(PHONE))?.steps?.every((x) => x.output === AT_CAP)).toBe(true);
    const old = await t.storedTurn(OLD_PHONE);
    expect(old?.steps).toHaveLength(TURN_STEPS_MAX);
    expect(JSON.stringify(old)).not.toContain("output");
    expect((await t.storedTurn({}))?.steps?.every((x) => x.output === AT_CAP)).toBe(true);
  });
});

describe("where the output never goes", () => {
  async function flow() {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Test it" });
    const s = Date.now();
    t.append(bash("b", s + 100), bash("f", s + 300, "bun run build"));
    await t.hook("PreToolUse", hookTool("b", "bun test"));
    t.append(ended("b", s + 200, `ok\n${MARKER}\n`, `${MARKER} on stderr`));
    await t.hook("PostToolUse", hookTool("b", "bun test"));
    t.append(failed("f", s + 400, `Exit code 1\n${MARKER}`));
    await t.hook("PostToolUseFailure", hookTool("f", "bun run build"));
    await t.liveActions(PHONE);
    await t.liveActions(OLD_PHONE);
    await t.rpc("sync", { sinceSeq: 1 }, "device:x", OLD_PHONE);
    await t.hook("Stop", { last_assistant_message: "The tests pass." });
    await t.storedTurn(OLD_PHONE);
    return t;
  }

  test("the flow under test does send the marker to the phone", async () => {
    const t = await flow();
    expect(t.actions().filter((e) => e.step.output?.includes(MARKER))).toHaveLength(2);
    expect(t.done().turn.steps?.filter((x) => x.output?.includes(MARKER))).toHaveLength(2);
  });

  test("no push notification carries it, plain or as the text the phone's extension opens", async () => {
    const t = await flow();
    const alerts = t.seen.map((e) => alertFor(e, () => "my-app"));
    for (const e of t.seen) if (e.type === "turn.action") expect(alertFor(e, () => "my-app")).toBeNull();
    const sent = alerts.filter((a) => a !== null);
    expect(sent.map((a) => a.category)).toContain("DONE");
    for (const alert of sent) {
      const sealed = fitAlert(alert);
      const payloads = [
        alert,
        { title: sealed.title, body: sealed.body, data: sealed.data },
        apnsPayload(alert),
        fcmMessage(alert),
      ];
      expect(JSON.stringify(payloads)).not.toContain(MARKER);
    }
  });

  test("`relay tail` prints the step's line without any of it", async () => {
    const t = await flow();
    const printed = t.seen.map(formatEvent).join("\n");
    expect(printed).toContain("Ran bun test");
    expect(printed).toContain("Failed");
    expect(printed).not.toContain(MARKER);
  });

  test("no log line carries it", async () => {
    const written: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const t = await flow();
      expect(JSON.stringify(t.seen)).toContain(MARKER);
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).not.toContain(MARKER);
  });
});

describe("the protocol", () => {
  const base = { kind: "run", label: "Ran bun test", at: 1 };

  test("a step without the fields still parses, and one with them keeps them", () => {
    const old = TurnStep.parse({ ...base, id: "b", tool: "Bash", detail: "bun test" });
    expect(old).not.toHaveProperty("output");
    expect(old).not.toHaveProperty("outputCut");
    expect(TurnStep.parse({ ...base, output: AT_CAP, outputCut: true })).toMatchObject({
      output: AT_CAP,
      outputCut: true,
    });
  });

  test("an output over the cap, or one that isn't text, doesn't parse", () => {
    const bad = [
      { output: `${AT_CAP}x` },
      { output: numbered(TURN_STEP_OUTPUT_LINES + 1).join("\n") },
      { output: "😀".repeat(TURN_STEP_OUTPUT_UNITS) },
      { output: 7 },
      { output: ["a"] },
      { outputCut: "yes" },
    ];
    for (const fields of bad)
      expect([fields, TurnStep.safeParse({ ...base, ...fields }).success]).toEqual([fields, false]);
  });

  test("the fixture: a step sent again with its output, and the finished turn's steps", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "../../protocol/fixtures/timeline.json"), "utf8"),
    ) as { output: { events: { step: TurnStep }[]; turn: Turn } };
    const steps = fixture.output.events.map((e) => TurnStep.parse(e.step));
    expect(steps.map((x) => [x.id, x.output !== undefined, x.outputCut, x.failed])).toEqual([
      ["toolu_01OutputTests", false, undefined, undefined],
      ["toolu_01OutputTests", true, undefined, undefined],
      ["toolu_01OutputBuild", true, true, true],
    ]);
    expect(fixture.output.turn.steps).toEqual([steps[1], steps[2]] as TurnStep[]);
    for (const step of steps) expect(shownOutput(step.output ?? "").output).toBe(step.output);
  });
});

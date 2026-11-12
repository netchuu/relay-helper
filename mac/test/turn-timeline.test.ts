// Turn timeline, case by case: what an action shows (inputs, titles, privacy, paths, details), the reader's thinking
// durations, ids and order, and live, finished and hook-only steps with the hook handler.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphemes,
  RelayEvent,
  TURN_ACTIONS_LIVE_MAX,
  TURN_STEP_DETAIL_MAX,
  TURN_STEP_LABEL_MAX,
  TURN_STEPS_MAX,
  TURN_THOUGHTS_MAX,
  Turn,
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
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";
import { TurnStopper } from "../src/daemon/stop.ts";
import { actionFields, cutDetail, detailPath, TimelineReader } from "../src/daemon/timeline.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";
import { formatEvent } from "../src/tailFormat.ts";

const CWD = "/Users/me/Projects/my-app";
const GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";
const ANT = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HOME = homedir().replace(/\/+$/, "");

const validStep = (s: unknown) => TurnStep.safeParse(s).success;

// ---------------------------------------------------------------------------------------------------
// What an action shows
// ---------------------------------------------------------------------------------------------------

describe("inputs: missing, empty or wrong-typed tool input", () => {
  test("a Bash call with no command, a blank one, or a number shows no detail and the plain label", () => {
    for (const input of [undefined, {}, { command: "   \n\t" }, { command: 42 }, { command: null }]) {
      const f = actionFields("Bash", input as Record<string, unknown> | undefined, CWD);
      expect(f).toEqual({ tool: "Bash" });
    }
    const r = new TimelineReader(CWD, 0);
    const [step] = r.add(use("a", "Bash", { command: 42, description: 7 }, 10));
    expect(step).toMatchObject({ kind: "run", label: "Ran a command", tool: "Bash", id: "a" });
    expect(step?.title).toBeUndefined();
    expect(step?.detail).toBeUndefined();
  });

  test("a blank or non-string description gives no title", () => {
    expect(actionFields("Bash", { command: "ls", description: "  \n " }, CWD).title).toBeUndefined();
    expect(actionFields("Agent", { description: ["x"] }, CWD).title).toBeUndefined();
  });

  test("a description on a tool other than Bash, Task or Agent is not a title", () => {
    expect(
      actionFields("Read", { file_path: `${CWD}/a.ts`, description: "Peek" }, CWD).title,
    ).toBeUndefined();
    expect(actionFields("mcp__github__create_issue", { description: "secret body" }, CWD)).toEqual({
      tool: "create_issue",
    });
  });

  test("Task (the older name) gets its description as the title and no detail", () => {
    expect(
      actionFields("Task", { description: "Explore", prompt: "PRIVATE PROMPT", subagent_type: "x" }, CWD),
    ).toEqual({ tool: "Task", title: "Explore" });
  });

  test("a read or edit without a path shows no detail", () => {
    expect(actionFields("Read", {}, CWD)).toEqual({ tool: "Read" });
    expect(actionFields("Edit", { file_path: "" }, CWD)).toEqual({ tool: "Edit" });
  });

  test("a search without a pattern shows no detail, even with a path", () => {
    expect(actionFields("Grep", { path: `${CWD}/src` }, CWD)).toEqual({ tool: "Grep" });
  });

  test("an input that is a string or an array, not an object, doesn't break the reader", () => {
    const r = new TimelineReader(CWD, 0);
    const out = [
      ...r.add(use("s", "Bash", "rm -rf /" as unknown as object, 10)),
      ...r.add(use("arr", "Read", ["x"] as unknown as object, 20)),
    ];
    expect(out.map((s) => s.id)).toEqual(["s", "arr"]);
    for (const s of out) expect(validStep(s)).toBe(true);
  });

  test("a tool call without a name is 'Used a tool' with some tool name", () => {
    const r = new TimelineReader(CWD, 0);
    const [step] = r.add({
      type: "assistant",
      uuid: "x",
      timestamp: iso(10),
      message: { content: [{ type: "tool_use", id: "n", input: {} }] },
    });
    expect(step?.label).toBe("Used a tool");
    expect(typeof step?.tool).toBe("string");
    expect(validStep(step)).toBe(true);
  });
});

describe("titles: one line, at most 80 characters as people see them", () => {
  test("a multi-line description with tabs becomes one line", () => {
    expect(actionFields("Bash", { command: "x", description: "Build\n\tthe\r\napp  " }, CWD).title).toBe(
      "Build the app",
    );
  });

  test("a long description is cut to 80 characters with an ellipsis", () => {
    const t = actionFields("Bash", { command: "x", description: "word ".repeat(100) }, CWD).title ?? "";
    expect(graphemes(t).length).toBeLessThanOrEqual(TURN_STEP_LABEL_MAX);
    expect(t.endsWith("…")).toBe(true);
  });

  test("an emoji description at 80 shows whole; at 81 is cut without splitting an emoji", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(actionFields("Agent", { description: family.repeat(80) }, CWD).title).toBe(family.repeat(80));
    const cut = actionFields("Agent", { description: family.repeat(81) }, CWD).title ?? "";
    expect(graphemes(cut).length).toBe(TURN_STEP_LABEL_MAX);
    expect(
      graphemes(cut)
        .slice(0, -1)
        .every((g) => g === family),
    ).toBe(true);
  });

  test("a description of many combining marks per character still passes the schema", () => {
    const zalgo = `a${"́".repeat(200)}`.repeat(100);
    const f = actionFields("Bash", { command: zalgo, description: zalgo }, CWD);
    expect(validStep({ kind: "run", label: "Ran x", at: 1, ...f })).toBe(true);
  });

  test("right-to-left text and emoji in a title stay as written", () => {
    expect(actionFields("Bash", { command: "x", description: "בנה את האפליקציה 🚀" }, CWD).title).toBe(
      "בנה את האפליקציה 🚀",
    );
  });
});

describe("privacy: never contents, diffs, outputs, queries, prompts; secrets redacted", () => {
  test("no file contents, edit text or notebook source from any edit tool", () => {
    const secret = "SUPER_PRIVATE_BODY";
    const calls: [string, Record<string, unknown>][] = [
      ["Write", { file_path: `${CWD}/a.ts`, content: secret }],
      ["Edit", { file_path: `${CWD}/a.ts`, old_string: secret, new_string: secret }],
      ["MultiEdit", { file_path: `${CWD}/a.ts`, edits: [{ old_string: secret, new_string: secret }] }],
      ["NotebookEdit", { notebook_path: `${CWD}/n.ipynb`, new_source: secret, cell_id: secret }],
      ["Read", { file_path: `${CWD}/a.ts`, offset: 1, limit: 2 }],
    ];
    for (const [name, input] of calls) {
      const r = new TimelineReader(CWD, 0);
      const [step] = r.add(use(`id-${name}`, name, input, 10));
      expect(JSON.stringify(step)).not.toContain(secret);
    }
  });

  test("a web search's query, an agent's prompt and a WebFetch prompt appear nowhere", () => {
    const r = new TimelineReader(CWD, 0);
    const steps = [
      ...r.add(use("w", "WebSearch", { query: "how to hide the body", allowed_domains: ["a.com"] }, 10)),
      ...r.add(use("a", "Agent", { description: "Look", prompt: "PRIVATE AGENT PROMPT" }, 20)),
      ...r.add(use("f", "WebFetch", { url: "https://a.com/p", prompt: "PRIVATE FETCH PROMPT" }, 30)),
    ];
    const json = JSON.stringify(steps);
    expect(json).not.toMatch(/hide the body|PRIVATE AGENT PROMPT|PRIVATE FETCH PROMPT/);
  });

  test("tool output, error text and thinking text never reach a step", () => {
    const r = new TimelineReader(CWD, 0);
    r.add({
      type: "assistant",
      uuid: "th",
      timestamp: iso(10),
      message: { content: [{ type: "thinking", thinking: "MY PRIVATE THOUGHTS", signature: "SIG" }] },
    });
    r.add(use("a", "Bash", { command: "ls" }, 20));
    r.add({
      type: "user",
      uuid: "r",
      timestamp: iso(30),
      message: {
        content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "ERROR OUTPUT" }],
      },
      toolUseResult: { stdout: "STDOUT TEXT" },
    } as never);
    expect(JSON.stringify([...r.actions, ...r.thoughts])).not.toMatch(
      /PRIVATE THOUGHTS|SIG|ERROR OUTPUT|STDOUT/,
    );
  });

  test("secrets in a title are redacted: tokens, Bearer, URL credentials, key=value", () => {
    for (const d of [
      `deploy with ${GH}`,
      `call ${ANT}`,
      "auth Bearer abcdefghijklmnopqrstuvwxyz012345",
      "push to https://bob:hunter2hunter2@git.example.com/x",
      "set API_KEY=abcdefgh12345678",
    ]) {
      const t = actionFields("Bash", { command: "x", description: d }, CWD).title ?? "";
      expect(t).toContain("[redacted");
      expect(t).not.toMatch(/ghp_A|sk-ant-api|abcdefghijklmnopqrstuvwxyz012345|hunter2|abcdefgh12345678/);
    }
  });

  test("a secret split across lines in a description is still redacted after joining to one line", () => {
    const t = actionFields("Bash", { command: "x", description: `token:\n  ${"z".repeat(30)}` }, CWD).title;
    expect(t).not.toContain("z".repeat(30));
  });

  test("a secret at every position around the 2000-character cut never shows a prefix", () => {
    for (let pad = 1980; pad <= 2005; pad++) {
      const d = actionFields("Bash", { command: `${"x".repeat(pad)} ${GH} done` }, CWD).detail ?? "";
      expect(d).not.toContain("ghp_");
      expect(d).not.toContain("ABCDEFGHIJ");
      expect(graphemes(d).length).toBeLessThanOrEqual(TURN_STEP_DETAIL_MAX);
    }
  });

  test("a private key block in a heredoc is redacted whole", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    const d = actionFields("Bash", { command: `cat > k.pem <<'EOF'\n${key}\nEOF` }, CWD).detail ?? "";
    expect(d).not.toContain("MIIEow");
  });

  test("secrets in a search pattern and in a path are redacted", () => {
    expect(actionFields("Grep", { pattern: GH, path: CWD }, CWD).detail).not.toContain("ghp_");
    expect(actionFields("Read", { file_path: `/tmp/${ANT}.txt` }, CWD).detail).not.toContain("sk-ant");
  });

  test("WebFetch shows only the host: no user, password, port path or query", () => {
    expect(
      actionFields("WebFetch", { url: "https://bob:hunter2@api.example.com:8443/v1/x?token=abc#frag" }, CWD)
        .detail,
    ).toBe("api.example.com");
    expect(actionFields("WebFetch", { url: "http://WWW.Example.COM/" }, CWD).detail).toBe("example.com");
  });

  test("WebFetch of a URL that isn't one, a file URL or a non-string shows nothing", () => {
    expect(actionFields("WebFetch", { url: "not a url at all" }, CWD)).toEqual({ tool: "WebFetch" });
    expect(actionFields("WebFetch", { url: "file:///Users/me/.ssh/id_rsa" }, CWD)).toEqual({
      tool: "WebFetch",
    });
    expect(actionFields("WebFetch", { url: 5 }, CWD)).toEqual({ tool: "WebFetch" });
  });

  test("the step label keeps the same rules: no query, no prompt, no content", () => {
    const r = new TimelineReader(CWD, 0);
    const [s] = r.add(use("w", "WebSearch", { query: "PRIVATE QUERY" }, 10));
    expect(s?.label).toBe("Searched the web");
  });
});

describe("paths: relative inside the project, ~ under home, else in full", () => {
  test("a relative path is taken from the session's folder", () => {
    expect(detailPath("src/a.ts", CWD)).toBe("src/a.ts");
    expect(detailPath("./src/../lib/a.ts", CWD)).toBe("lib/a.ts");
  });

  test("a relative path that climbs out of the project is shown in full (or with ~)", () => {
    expect(detailPath("../../../../etc/hosts", CWD)).toBe("/etc/hosts");
  });

  test("a sibling folder whose name starts like the project's isn't inside it", () => {
    expect(detailPath(`${CWD}-other/a.ts`, CWD)).toBe(`${CWD}-other/a.ts`);
  });

  test("a project folder given with a trailing slash still makes paths relative", () => {
    expect(detailPath(`${CWD}/a.ts`, `${CWD}/`)).toBe("a.ts");
  });

  test("under the home folder: ~ for the file and for home itself, never a look-alike home", () => {
    expect(detailPath(`${HOME}/.ssh/config`, CWD)).toBe("~/.ssh/config");
    expect(detailPath(HOME, CWD)).toBe("~");
    expect(detailPath(`${HOME}x/a`, CWD)).toBe(`${HOME}x/a`);
  });

  test("without a session folder, an absolute path is shown in full or with ~", () => {
    expect(detailPath("/etc/hosts", null)).toBe("/etc/hosts");
    expect(detailPath(`${HOME}/a`, null)).toBe("~/a");
  });

  test("a search's folder follows the same rules", () => {
    expect(actionFields("Glob", { pattern: "*.ts", path: `${HOME}/other` }, CWD).detail).toBe(
      "*.ts in ~/other",
    );
    expect(actionFields("Grep", { pattern: "x", path: "src" }, CWD).detail).toBe("x in src");
  });
});

describe("details: at most 2000 characters, whole characters, line breaks kept", () => {
  test("a command at exactly 2000 characters is whole; at 2001 it is cut to 2000 with …", () => {
    expect(cutDetail("a".repeat(2000))).toBe("a".repeat(2000));
    const cut = cutDetail("a".repeat(2001));
    expect(graphemes(cut).length).toBe(2000);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("line breaks stay (the 12-line cut is the apps'), Windows line ends become \\n", () => {
    const d = actionFields("Bash", { command: "a\r\nb\nc\n\n\nd" }, CWD).detail;
    expect(d).toBe("a\nb\nc\n\n\nd");
  });

  test("a one-megabyte command is cut quickly and fits the schema", () => {
    const started = performance.now();
    const d = actionFields("Bash", { command: `echo ${"ab ".repeat(350_000)}` }, CWD).detail ?? "";
    expect(performance.now() - started).toBeLessThan(2000);
    expect(validStep({ kind: "run", label: "Ran echo", at: 1, detail: d })).toBe(true);
  });

  test("a detail of many combining marks per character fits the storage guard", () => {
    const d = cutDetail(`e${"́".repeat(50)}`.repeat(3000));
    expect(validStep({ kind: "run", label: "Ran x", at: 1, detail: d })).toBe(true);
  });
});

describe("MCP and odd tool names", () => {
  test("an MCP tool shows its own name; its label names the server", () => {
    const r = new TimelineReader(CWD, 0);
    const [s] = r.add(use("m", "mcp__claude_ai_Notion__notion-search", { query: "PRIVATE" }, 10));
    expect(s).toMatchObject({ tool: "notion-search", label: "Used notion-search (claude_ai_Notion)" });
    expect(s?.detail).toBeUndefined();
  });

  test("an MCP tool whose name has double underscores keeps the rest as its name", () => {
    expect(actionFields("mcp__srv__a__b", {}, CWD).tool).toBe("a__b");
  });
});

// ---------------------------------------------------------------------------------------------------
// The reader: thinking durations, ids, ordering
// ---------------------------------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
const userPrompt = (t: string, at: number) => ({
  type: "user",
  uuid: `u-${t}`,
  timestamp: iso(at),
  message: { content: t },
});
const thinking = (uuid: string, at: number, extra: object = {}) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { content: [{ type: "thinking", thinking: "" }] },
  ...extra,
});
const use = (id: string, name: string, input: object, at: number, extra: object = {}) => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name, input }] },
  ...extra,
});
const result = (id: string, isError: boolean, at: number, extra: object = {}) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "OUTPUT" }] },
  ...extra,
});
const text = (uuid: string, t: string, at: number) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] },
});

describe("thinking durations", () => {
  test("the first thinking line is timed from the prompt entry", () => {
    const r = new TimelineReader(CWD, 1000);
    r.add(userPrompt("Go", 2000));
    expect(r.add(thinking("t", 12_000))[0]).toMatchObject({ label: "Thought for 10s", durationMs: 10_000 });
  });

  test("with no entry before it, from the turn's start", () => {
    const r = new TimelineReader(CWD, 1000);
    expect(r.add(thinking("t", 6000))[0]?.label).toBe("Thought for 5s");
  });

  test("with neither an entry nor a start, at least 1 s", () => {
    const r = new TimelineReader(CWD, null);
    expect(r.add(thinking("t", 6000))[0]).toMatchObject({ label: "Thought for 1s", durationMs: 1000 });
  });

  test("timed from the previous main-conversation entry: a tool result counts, a subagent's entry doesn't", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 1000));
    r.add(result("a", false, 3000));
    r.add(use("sub", "Bash", { command: "x" }, 9000, { isSidechain: true }));
    expect(r.add(thinking("t", 10_000))[0]?.durationMs).toBe(7000);
  });

  test("a clock that jumps back gives 1 s, not a negative time", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 100_000));
    expect(r.add(thinking("t", 40_000))[0]).toMatchObject({ durationMs: 1000, label: "Thought for 1s" });
  });

  test("a long think reads in minutes and seconds and passes the schema", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 1000));
    const [s] = r.add(thinking("t", 1000 + 2 * 3600_000 + 5000));
    expect(s?.label).toBe("Thought for 120m 5s");
    expect(validStep(s)).toBe(true);
  });

  test("rounding: 1.4 s is 1s, 1.5 s is 2s, 59.6 s is 1m 0s", () => {
    const at = (ms: number) => {
      const r = new TimelineReader(CWD, 0);
      r.add(use("a", "Bash", { command: "ls" }, 1000));
      return r.add(thinking("t", 1000 + ms))[0]?.label;
    };
    expect([at(1400), at(1500), at(59_600)]).toEqual([
      "Thought for 1s",
      "Thought for 2s",
      "Thought for 1m 0s",
    ]);
  });

  test("several thinking blocks in one entry each get their own id", () => {
    const r = new TimelineReader(CWD, 0);
    const out = r.add({
      type: "assistant",
      uuid: "multi",
      timestamp: iso(5000),
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "thinking", thinking: "" },
        ],
      },
    });
    expect(out.map((s) => s.id)).toEqual(["multi", "multi:1"]);
    for (const s of out) expect(validStep(s)).toBe(true);
  });

  test("a thinking entry seen twice (same uuid) is one line", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(thinking("t", 2000));
    expect(r.add(thinking("t", 2000))).toEqual([]);
    expect(r.thoughts).toHaveLength(1);
  });

  test("a subagent's thinking is left out", () => {
    const r = new TimelineReader(CWD, 0);
    expect(r.add(thinking("t", 2000, { isSidechain: true }))).toEqual([]);
  });

  test("an entry without a timestamp doesn't move the clock for the next thinking line", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 1000));
    r.add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] } });
    expect(r.add(thinking("t", 5000))[0]?.durationMs).toBe(4000);
  });
});

describe("ids and order", () => {
  test("a tool_use seen twice (same id) is one action", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 10));
    expect(r.add(use("a", "Bash", { command: "ls" }, 10))).toEqual([]);
    expect(r.actions).toHaveLength(1);
  });

  test("an error result for an unknown id, or before its tool_use, changes nothing and breaks nothing", () => {
    const r = new TimelineReader(CWD, 0);
    expect(r.add(result("ghost", true, 5))).toEqual([]);
    const [s] = r.add(use("ghost", "Bash", { command: "ls" }, 10));
    expect(s?.id).toBe("ghost");
    expect(r.actions).toHaveLength(1);
  });

  test("a second error result for the same action isn't a second change", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 10));
    expect(r.add(result("a", true, 20))).toHaveLength(1);
    expect(r.add(result("a", true, 30, { uuid: "r-a-2" }))).toEqual([]);
  });

  test("a successful result leaves the action not failed; an error result pointing at a thinking id is ignored", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(thinking("th", 5));
    r.add(use("a", "Bash", { command: "ls" }, 10));
    expect(r.add(result("a", false, 20))).toEqual([]);
    expect(r.add(result("th", true, 30))).toEqual([]);
    expect(r.actions[0]?.failed).toBeUndefined();
    expect(r.thoughts[0]?.failed).toBeUndefined();
  });

  test("a subagent's error result for a main-conversation id doesn't mark it failed", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 10));
    expect(r.add(result("a", true, 20, { isSidechain: true }))).toEqual([]);
  });

  test("tool_use in a user entry, tool_result in an assistant entry, odd content shapes are ignored", () => {
    const r = new TimelineReader(CWD, 0);
    const odd = [
      {
        type: "user",
        timestamp: iso(1),
        message: { content: [{ type: "tool_use", id: "u", name: "Bash" }] },
      },
      { type: "assistant", timestamp: iso(2), message: { content: "just text" } },
      { type: "assistant", timestamp: iso(3), message: { content: [null, 5, "x"] } },
      { type: "assistant", timestamp: iso(4) },
      { type: "system", timestamp: iso(5), message: { content: [{ type: "thinking" }] } },
      null,
    ];
    for (const e of odd) expect(r.add(e as never)).toEqual([]);
  });

  test("one entry with text, thinking and two tool calls gives the thinking line then the actions, in order", () => {
    const r = new TimelineReader(CWD, 0);
    const out = r.add({
      type: "assistant",
      uuid: "e",
      timestamp: iso(2000),
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "x", name: "Read", input: { file_path: `${CWD}/a.ts` } },
          { type: "tool_use", id: "y", name: "Grep", input: { pattern: "foo" } },
        ],
      },
    });
    expect(out.map((s) => s.id)).toEqual(["e", "x", "y"]);
  });

  test("tool calls without an id are kept in the finished list", () => {
    const r = new TimelineReader(CWD, 0);
    r.add({
      type: "assistant",
      timestamp: iso(1),
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    r.add({
      type: "assistant",
      timestamp: iso(2),
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });
    expect(r.actions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// Live, finished, races (with the hook handler)
// ---------------------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  resetLiveSteps();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-turn-timeline-"));
  dirs.push(dir);
  return dir;
}

function setup(opts: { dbPath?: string; path?: string } = {}) {
  const path = opts.path ?? join(tempDir(), "t.jsonl");
  if (!opts.path) writeFileSync(path, "");
  const db = openDb(opts.dbPath ?? ":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: 0 });
  const presence = {
    noteLocalActivity() {},
    get: () => ({ present: true, mode: "auto" }),
  } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config,
    steps,
    messages,
    transcriptPath: () => path,
  });
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages, stopper });
  const rpc = createRpc({
    db,
    events,
    registry,
    broker,
    presence,
    config,
    steps,
    stopper,
  } as unknown as RpcDeps);
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
  const actions = (turnId?: string) =>
    seen.flatMap((e) => (e.type === "turn.action" && (!turnId || e.turnId === turnId) ? [e] : []));
  const dones = () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : []));
  const turnIds = () => seen.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
  const rows = (turnId?: string) =>
    (
      db
        .query(
          `SELECT COUNT(*) AS n FROM events WHERE type = 'turn.action'${turnId ? " AND json_extract(data_json, '$.turnId') = ?" : ""}`,
        )
        .get(...(turnId ? [turnId] : [])) as { n: number }
    ).n;
  const live = async () => {
    const r = await rpc("session.live", { sessionId: "s1" }, "device:x");
    return "result" in r ? (r.result as { turnId: string; actions?: TurnStep[] } | null) : null;
  };
  const poll = () =>
    hook("PreToolUse", {
      tool_use_id: `p${Math.random()}`,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
  return {
    db,
    events,
    registry,
    stopper,
    rpc,
    hook,
    append,
    actions,
    dones,
    turnIds,
    rows,
    live,
    poll,
    path,
    seen,
  };
}

describe("live turn.action", () => {
  test("every event validates against the protocol, even with odd inputs", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    const family = "👨‍👩‍👧‍👦";
    t.append(
      thinking("th", s),
      use("a", "Bash", { command: family.repeat(3000), description: family.repeat(200) }, s + 1),
      use(
        "b",
        "Edit",
        { file_path: `${CWD}/${"ü".repeat(300)}.ts`, old_string: "x", new_string: "y" },
        s + 2,
      ),
      use("c", "mcp__x__y", { anything: true }, s + 3),
      use("d", "WebFetch", { url: 12 }, s + 4),
      result("a", true, s + 5),
    );
    await t.poll();
    expect(t.actions().length).toBe(6);
    for (const e of t.actions()) expect(RelayEvent.safeParse(e).success).toBe(true);
  });

  test("a line written in two parts is sent once, when it is whole", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const line = JSON.stringify(use("a", "Bash", { command: "ls" }, Date.now() + 5));
    appendFileSync(t.path, line.slice(0, 20));
    await t.poll();
    expect(t.actions()).toHaveLength(0);
    appendFileSync(t.path, `${line.slice(20)}\n`);
    await t.poll();
    await t.poll();
    expect(t.actions().map((e) => e.step.id)).toEqual(["a"]);
  });

  test("a transcript rewritten shorter sends nothing twice", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(
      thinking("th", s),
      use("a", "Bash", { command: "ls" }, s + 1),
      use("b", "Bash", { command: "pwd" }, s + 2),
    );
    await t.poll();
    writeFileSync(t.path, `${JSON.stringify(use("a", "Bash", { command: "ls" }, s + 1))}\n`);
    await t.poll();
    t.append(use("c", "Bash", { command: "x" }, s + 3));
    await t.poll();
    expect(t.actions().map((e) => e.step.id)).toEqual(["th", "a", "b", "c"]);
  });

  test("a subagent's actions and thinking aren't sent live", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(
      thinking("sth", s, { isSidechain: true }),
      use("sa", "Bash", { command: "x" }, s, { isSidechain: true }),
    );
    await t.poll();
    expect(t.actions()).toHaveLength(0);
  });

  test("the 200 cap counts thinking lines and actions together; failed re-sends don't count", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    const entries: object[] = [];
    for (let i = 0; i < 150; i++)
      entries.push(thinking(`t${i}`, s + i * 2), use(`a${i}`, "Bash", { command: `c${i}` }, s + i * 2 + 1));
    t.append(...entries);
    await t.poll();
    expect(t.actions()).toHaveLength(TURN_ACTIONS_LIVE_MAX);
    // a0 was sent; its failure is sent again. a140 was over the cap: its failure isn't.
    t.append(result("a0", true, s + 400), result("a140", true, s + 401));
    await t.poll();
    const sent = t.actions();
    expect(sent).toHaveLength(TURN_ACTIONS_LIVE_MAX + 1);
    expect(sent.at(-1)?.step).toMatchObject({ id: "a0", failed: true });
    expect(sent.some((e) => e.step.id === "a140")).toBe(false);
    const reply = await t.live();
    expect(reply?.actions).toHaveLength(TURN_ACTIONS_LIVE_MAX);
    expect(reply?.actions?.find((a) => a.id === "a0")?.failed).toBe(true);
  });

  test("the failed re-send carries the same title, detail and at as the first send", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(use("a", "Bash", { command: "make", description: "Build" }, s));
    await t.poll();
    t.append(result("a", true, s + 3000));
    await t.poll();
    const [first, again] = t.actions().map((e) => e.step);
    expect(again).toEqual({ ...(first as TurnStep), failed: true });
  });

  test("an event emitted earlier isn't changed when the action later fails (each event is a copy)", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(use("a", "Bash", { command: "make" }, s));
    await t.poll();
    t.append(result("a", true, s + 1));
    await t.poll();
    expect(t.actions()[0]?.step.failed).toBeUndefined();
    const stored = t.events.since(0).filter((e) => e.type === "turn.action");
    expect(stored.map((e) => (e as { step: TurnStep }).step.failed ?? false)).toEqual([false, true]);
  });

  test("session.live: no actions key before any; a copy the caller can't change; null after the turn", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    expect(await t.live()).not.toHaveProperty("actions");
    t.append(use("a", "Bash", { command: "make" }, Date.now() + 5));
    await t.poll();
    const first = await t.live();
    if (first?.actions?.[0]) first.actions[0].label = "tampered";
    expect((await t.live())?.actions?.[0]?.label).toBe("Ran make");
    t.append(text("ans", "Done.", Date.now() + 10));
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(await t.live()).toBeNull();
  });

  test("session.live for a session that never ran a turn, or an unknown one, is null", async () => {
    const t = setup();
    const r = await t.rpc("session.live", { sessionId: "nope" }, "device:x");
    expect("result" in r ? r.result : "error").toBeNull();
  });

  test("never pushed, failed or not, thinking or action; relay tail prints one line each", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(
      thinking("th", s),
      use("a", "Bash", { command: "a\nb\nc", description: "Multi\nline" }, s + 1),
      result("a", true, s + 2),
    );
    await t.poll();
    expect(t.actions()).toHaveLength(3);
    for (const e of t.actions()) {
      expect(alertFor(e, () => "Session")).toBeNull();
      expect(formatEvent(e)).not.toContain("\n");
    }
    expect(formatEvent(t.actions()[0] as RelayEvent)).toContain("Thought for");
  });
});

describe("sync and clean-up", () => {
  test("sync replays a running turn's actions, and none of a finished turn's", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const since = t.events.latestSeq();
    const s = Date.now() + 5;
    t.append(thinking("th", s), use("a", "Bash", { command: "make" }, s + 1));
    await t.poll();
    const during = await t.rpc("sync", { sinceSeq: since }, "device:x");
    const evs = "result" in during ? (during.result as { events: RelayEvent[] }).events : [];
    expect(evs.filter((e) => e.type === "turn.action").map((e) => (e as { step: TurnStep }).step.id)).toEqual(
      ["th", "a"],
    );
    t.append(text("ans", "Done.", s + 10));
    await t.hook("Stop", { last_assistant_message: "Done." });
    const after = await t.rpc("sync", { sinceSeq: since }, "device:x");
    const evs2 = "result" in after ? (after.result as { events: RelayEvent[] }).events : [];
    expect(evs2.some((e) => e.type === "turn.action")).toBe(false);
    expect(evs2.some((e) => e.type === "turn.done")).toBe(true);
  });

  test("going idle without a Stop (reconcile, interrupt) deletes the rows and session.live has no actions", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    t.append(use("a", "Bash", { command: "make" }, Date.now() + 5));
    await t.poll();
    expect(t.rows()).toBe(1);
    t.registry.setStatus("s1", "idle");
    expect(t.rows()).toBe(0);
    expect((await t.live())?.actions).toBeUndefined();
  });

  test("SessionEnd deletes the running turn's rows", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    t.append(use("a", "Bash", { command: "make" }, Date.now() + 5));
    await t.poll();
    await t.hook("SessionEnd");
    expect(t.rows()).toBe(0);
  });

  test("the phone's Stop deletes the rows and the stopped turn keeps the same ids as live", async () => {
    const t = setup();
    const s0 = Date.now();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(
      userPrompt("Go", s0),
      thinking("th", s + 2000),
      use("a", "Bash", { command: "make", description: "Build" }, s + 2100),
    );
    await t.poll();
    const liveIds = t.actions().map((e) => e.step.id);
    t.append({
      type: "user",
      uuid: "int",
      timestamp: iso(s + 2200),
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    const turnId = t.turnIds()[0] as string;
    t.stopper.endStopped(turnId);
    expect(t.rows(turnId)).toBe(0);
    const done = t.dones()[0] as Turn;
    expect(done.stopped).toBe(true);
    expect([...(done.thoughts ?? []), ...(done.steps ?? [])].map((x) => x.id)).toEqual(liveIds);
    expect(done.steps?.[0]).toMatchObject({ tool: "Bash", title: "Build", detail: "make" });
    expect(Turn.safeParse(done).success).toBe(true);
  });

  test("a prompt queued during Stop's wait: the old turn's rows go, the new turn's stay and keep coming", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "First" });
    const s = Date.now() + 1;
    t.append(
      userPrompt("First", s),
      use("a1", "Bash", { command: "one" }, s + 2),
      text("ans1", "One done.", s + 3),
    );
    await t.poll();
    const stop = t.hook("Stop", { last_assistant_message: "One done." });
    await Bun.sleep(50);
    const s2 = Date.now() + 1;
    t.append(userPrompt("Second", s2));
    await t.hook("UserPromptSubmit", { prompt: "Second" });
    t.append(use("b1", "Bash", { command: "two" }, s2 + 5));
    await t.poll();
    await stop;
    const [first, second] = t.turnIds() as [string, string];
    expect(t.rows(first)).toBe(0);
    expect(t.rows(second)).toBe(1);
    t.append(use("b2", "Bash", { command: "three" }, s2 + 10));
    await t.poll();
    expect(t.actions(second).map((e) => e.step.id)).toEqual(["b1", "b2"]);
    expect((await t.live())?.actions?.map((a) => a.id)).toEqual(["b1", "b2"]);
    const done = t.dones().find((d) => d.id === first);
    expect(done?.steps?.map((x) => x.id)).toEqual(["a1"]);
  });

  test("entries of the previous turn flushed after the new prompt aren't the new turn's actions", async () => {
    const t = setup();
    const before = Date.now() - 2000;
    await t.hook("UserPromptSubmit", { prompt: "Second" });
    t.append(use("late", "Bash", { command: "old" }, before), thinking("late-th", before + 1));
    await t.poll();
    expect(t.actions()).toHaveLength(0);
  });
});

describe("finished turns", () => {
  test("caps: 130 calls and 120 thinking lines keep 100 of each, stepsMore 30, and steps still match toolCalls", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Many" });
    const s = Date.now() + 5;
    const entries: object[] = [userPrompt("Many", s)];
    for (let i = 0; i < 130; i++) {
      if (i < 120) entries.push(thinking(`t${i}`, s + 10 + i * 3));
      entries.push(use(`a${i}`, "Bash", { command: `c${i}` }, s + 11 + i * 3));
    }
    entries.push(text("ans", "Done.", s + 1000));
    t.append(...entries);
    await t.hook("Stop", { last_assistant_message: "Done." });
    const done = t.dones()[0] as Turn;
    expect(done.steps).toHaveLength(TURN_STEPS_MAX);
    expect(done.stepsMore).toBe(30);
    expect(done.thoughts).toHaveLength(TURN_THOUGHTS_MAX);
    expect(done.thoughts?.[0]?.id).toBe("t0");
    expect((done.steps?.length ?? 0) + (done.stepsMore ?? 0)).toBe(done.stats.toolCalls);
    expect(Turn.safeParse(done).success).toBe(true);
    // Stored and read back the same.
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    const stored = "result" in res ? (res.result as Turn[])[0] : undefined;
    expect(stored?.stepsMore).toBe(30);
    expect(stored?.thoughts).toHaveLength(TURN_THOUGHTS_MAX);
  });

  test("a turn with thinking but no tool calls keeps its thinking lines and has no steps", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Think" });
    const s = Date.now() + 5;
    t.append(userPrompt("Think", s), thinking("th", s + 3000), text("ans", "42.", s + 3100));
    await t.hook("Stop", { last_assistant_message: "42." });
    const done = t.dones()[0] as Turn;
    expect(done.steps).toBeUndefined();
    expect(done.stepsMore).toBeUndefined();
    expect(done.thoughts?.map((x) => x.id)).toEqual(["th"]);
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    expect("result" in res ? (res.result as Turn[])[0]?.thoughts?.map((x) => x.id) : null).toEqual(["th"]);
  });

  test("a turn with neither keeps steps_json NULL", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Hi" });
    t.append(userPrompt("Hi", Date.now() + 1), text("ans", "Hello.", Date.now() + 2));
    await t.hook("Stop", { last_assistant_message: "Hello." });
    const row = t.db.query("SELECT steps_json FROM turns").get() as { steps_json: string | null };
    expect(row.steps_json).toBeNull();
  });

  test("the finished turn's failed flag, ids and durations equal what was sent live", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(
      thinking("th1", s + 4000),
      use("a", "Bash", { command: "make" }, s + 4100),
      result("a", true, s + 4200),
      thinking("th2", s + 9000),
      use("b", "Read", { file_path: `${CWD}/x.ts` }, s + 9100),
      text("ans", "Done.", s + 9200),
    );
    await t.poll();
    await t.hook("Stop", { last_assistant_message: "Done." });
    const latest = new Map<string, TurnStep>();
    for (const e of t.actions()) latest.set(e.step.id as string, e.step);
    const done = t.dones()[0] as Turn;
    for (const s of [...(done.steps ?? []), ...(done.thoughts ?? [])])
      expect(s).toEqual(latest.get(s.id as string) as TurnStep);
  });

  test("old steps_json without the new fields is read as before, with no thoughts", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: CWD });
    const old = JSON.stringify({ steps: [{ kind: "run", label: "Ran bun test", at: 5 }], stepsMore: 3 });
    t.db
      .query(
        "INSERT INTO turns (id, session_id, full_text, summary, truncated, stats_json, failed, started_at, ended_at, steps_json) VALUES ('old', 's1', 'x', 'x', 0, ?, 0, 1, 2, ?)",
      )
      .run(JSON.stringify({ durationMs: 1, toolCalls: 104, filesEdited: [] }), old);
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    const turn = "result" in res ? (res.result as Turn[])[0] : undefined;
    expect(turn?.steps).toEqual([{ kind: "run", label: "Ran bun test", at: 5 }]);
    expect(turn?.stepsMore).toBe(3);
    expect(turn?.thoughts).toBeUndefined();
    expect(Turn.safeParse(turn).success).toBe(true);
  });

  test("corrupt steps_json is no steps, not an error", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: CWD });
    t.db
      .query(
        "INSERT INTO turns (id, session_id, full_text, summary, truncated, stats_json, failed, started_at, ended_at, steps_json) VALUES ('bad', 's1', 'x', 'x', 0, ?, 0, 1, 2, '{not json')",
      )
      .run(JSON.stringify({ durationMs: 1, toolCalls: 0, filesEdited: [] }));
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    const turn = "result" in res ? (res.result as Turn[])[0] : undefined;
    expect(turn?.steps).toBeUndefined();
    expect(turn?.thoughts).toBeUndefined();
  });

  test("Stop after the next prompt: the earlier turn has only its own actions and thinking", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "First" });
    const s = Date.now() + 1;
    t.append(
      userPrompt("First", s),
      thinking("th1", s + 2),
      use("a1", "Bash", { command: "one" }, s + 3),
      text("ans1", "One done.", s + 4),
    );
    await Bun.sleep(25);
    const s2 = Date.now() + 1;
    t.append(
      userPrompt("Second", s2),
      thinking("th2", s2 + 2),
      use("b1", "Bash", { command: "two" }, s2 + 3),
    );
    await t.hook("UserPromptSubmit", { prompt: "Second" });
    await t.hook("Stop", { last_assistant_message: "One done." });
    const [first] = t.turnIds() as [string, string];
    const done = t.dones().find((d) => d.id === first);
    expect(done?.steps?.map((x) => x.id)).toEqual(["a1"]);
    expect(done?.thoughts?.map((x) => x.id)).toEqual(["th1"]);
  });

  test("history from the transcript (turns Relay didn't see) carries the fields and the thinking lines", () => {
    const dir = tempDir();
    const path = join(dir, "h.jsonl");
    const s = Date.parse("2026-11-01T10:00:00Z");
    writeFileSync(
      path,
      [
        userPrompt("Old", s),
        thinking("th", s + 3000),
        use(
          "a",
          "Bash",
          { command: `curl -H "Authorization: Bearer ${"q".repeat(30)}" x`, description: "Fetch" },
          s + 3100,
        ),
        result("a", true, s + 3200),
        use("sub", "Bash", { command: "hidden" }, s + 3300, { isSidechain: true }),
        text("ans", "Fetched.", s + 3400),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const [turn] = transcriptTurns("s1", path, { limit: 5, previewChars: 600, working: false, cwd: CWD });
    expect(turn?.steps).toEqual([
      expect.objectContaining({ id: "a", tool: "Bash", title: "Fetch", failed: true }),
    ]);
    expect(turn?.steps?.[0]?.detail).not.toContain("q".repeat(30));
    expect(turn?.thoughts).toEqual([
      expect.objectContaining({ id: "th", label: "Thought for 3s", durationMs: 3000 }),
    ]);
    expect(Turn.safeParse(turn).success).toBe(true);
  });
});

describe("hook-only steps (no transcript)", () => {
  const NONE = { transcript_path: "/nonexistent/t.jsonl" };
  const call = (id: string, name: string, input: object, extra: object = {}) => ({
    ...NONE,
    tool_use_id: id,
    tool_name: name,
    tool_input: input,
    ...extra,
  });

  test("failed calls are marked, subagent calls left out, secrets redacted, paths shortened", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", ...NONE });
    await t.hook(
      "PreToolUse",
      call("h1", "Bash", { command: `export T=${GH}; make`, description: `use ${ANT}` }),
    );
    await t.hook(
      "PostToolUseFailure",
      call("h1", "Bash", { command: `export T=${GH}; make`, description: `use ${ANT}` }),
    );
    await t.hook("PostToolUse", call("h2", "Read", { file_path: `${HOME}/notes.txt` }));
    await t.hook("PostToolUse", call("h3", "Bash", { command: "subagent" }, { agent_id: "ag1" }));
    await t.hook("PostToolUse", call("h4", "WebSearch", { query: "PRIVATE QUERY" }));
    await t.hook("Stop", { last_assistant_message: "Done.", ...NONE });
    const done = t.dones()[0] as Turn;
    expect(done.steps?.map((x) => x.id)).toEqual(["h1", "h2", "h4"]);
    expect(done.steps?.[0]).toMatchObject({ failed: true, tool: "Bash" });
    expect(JSON.stringify(done.steps)).not.toMatch(/ghp_A|sk-ant-api|PRIVATE QUERY/);
    expect(done.steps?.[1]?.detail).toBe("~/notes.txt");
    expect(done.thoughts).toBeUndefined();
    expect(Turn.safeParse(done).success).toBe(true);
  });

  test("no turn.action is sent live without a transcript (the turn.step line still is)", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", ...NONE });
    await t.hook("PreToolUse", call("h1", "Bash", { command: "make" }));
    await t.hook("PostToolUse", call("h1", "Bash", { command: "make" }));
    expect(t.actions()).toHaveLength(0);
    expect(t.seen.some((e) => e.type === "turn.step")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// The tool-call count, repeated hooks, missing timestamps, and clean-up after a restart
// ---------------------------------------------------------------------------------------------------

describe("toolCalls follows the distinct actions on every path", () => {
  // One transcript: a duplicated tool_use, a subagent's call, a call without an id, a failed call.
  const turnEntries = (s: number) => [
    userPrompt("Go", s),
    use("a", "Bash", { command: "one" }, s + 10),
    use("a", "Bash", { command: "one" }, s + 10, { uuid: "a-dup" }),
    use("sub", "Bash", { command: "x" }, s + 20, { isSidechain: true }),
    {
      type: "assistant",
      uuid: "noid",
      timestamp: iso(s + 30),
      message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
    },
    use("b", "Edit", { file_path: `${CWD}/a.ts`, old_string: "x", new_string: "y" }, s + 40),
    result("b", true, s + 50),
  ];

  test("the Stop hook, the phone's Stop and history agree: 3 steps, toolCalls 3", async () => {
    // Stop hook
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    const s = Date.now() + 5;
    t.append(...turnEntries(s), text("ans", "Done.", s + 60));
    await t.hook("Stop", { last_assistant_message: "Done." });
    const byHook = t.dones()[0] as Turn;
    expect(byHook.steps?.map((x) => x.id ?? null)).toEqual(["a", null, "b"]);
    expect(byHook.stats.toolCalls).toBe(3);
    expect(byHook.stats.filesEdited).toEqual([`${CWD}/a.ts`]);

    // The phone's Stop
    const p = setup();
    await p.hook("UserPromptSubmit", { prompt: "Go" });
    const s2 = Date.now() + 5;
    p.append(...turnEntries(s2), {
      type: "user",
      uuid: "int",
      timestamp: iso(s2 + 60),
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    p.stopper.endStopped(p.turnIds()[0] as string);
    const byPhone = p.dones()[0] as Turn;
    expect(byPhone.steps?.map((x) => x.id ?? null)).toEqual(["a", null, "b"]);
    expect(byPhone.stats.toolCalls).toBe(3);

    // History from the transcript
    const path = join(tempDir(), "h.jsonl");
    writeFileSync(
      path,
      [...turnEntries(1_000_000), text("ans", "Done.", 1_000_060)].map((l) => JSON.stringify(l)).join("\n"),
    );
    const [history] = transcriptTurns("s1", path, { limit: 5, previewChars: 600, working: false, cwd: CWD });
    expect(history?.steps?.map((x) => x.id ?? null)).toEqual(["a", null, "b"]);
    expect(history?.stats.toolCalls).toBe(3);
    for (const turn of [byHook, byPhone, history]) {
      expect(turn?.steps?.[2]?.failed).toBe(true);
      expect(Turn.safeParse(turn).success).toBe(true);
    }
  });

  test("over the cap with duplicates: steps + stepsMore still equal toolCalls", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Many" });
    const s = Date.now() + 5;
    const entries: object[] = [userPrompt("Many", s)];
    for (let i = 0; i < 110; i++) {
      entries.push(use(`a${i}`, "Bash", { command: `c${i}` }, s + 10 + i));
      if (i % 10 === 0)
        entries.push(use(`a${i}`, "Bash", { command: `c${i}` }, s + 10 + i, { uuid: `dup${i}` }));
    }
    t.append(...entries, text("ans", "Done.", s + 500));
    await t.hook("Stop", { last_assistant_message: "Done." });
    const done = t.dones()[0] as Turn;
    expect(done.stats.toolCalls).toBe(110);
    expect(done.stepsMore).toBe(10);
    expect((done.steps?.length ?? 0) + (done.stepsMore ?? 0)).toBe(done.stats.toolCalls);
  });
});

describe("hook-only steps with repeated hooks", () => {
  const NONE = { transcript_path: "/nonexistent/t.jsonl" };
  const call = (id: string | null, extra: object = {}) => ({
    ...NONE,
    ...(id ? { tool_use_id: id } : {}),
    tool_name: "Bash",
    tool_input: { command: "make" },
    ...extra,
  });

  test("PermissionDenied then PostToolUseFailure for one id is one failed step; other ids are kept", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", ...NONE });
    await t.hook("PreToolUse", call("h1"));
    await t.hook("PermissionDenied", call("h1"));
    await t.hook("PostToolUseFailure", call("h1"));
    await t.hook("PreToolUse", call("h2"));
    await t.hook("PostToolUse", call("h2"));
    await t.hook("Stop", { last_assistant_message: "Done.", ...NONE });
    const done = t.dones()[0] as Turn;
    expect(done.steps?.map((x) => [x.id, x.failed ?? false])).toEqual([
      ["h1", true],
      ["h2", false],
    ]);
    expect(done.stats.toolCalls).toBe(2);
  });

  test("calls without a tool_use_id aren't merged: two hooks, two steps", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", ...NONE });
    await t.hook("PostToolUse", call(null));
    await t.hook("PostToolUse", call(null));
    await t.hook("Stop", { last_assistant_message: "Done.", ...NONE });
    expect(t.dones()[0]?.steps).toHaveLength(2);
  });

  test("a repeated PostToolUse doesn't bring back the live line of a finished tool", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x", ...NONE });
    await t.hook("PreToolUse", call("h1"));
    await t.hook("PostToolUse", call("h1"));
    await t.hook("PreToolUse", call("h2", { tool_input: { command: "swift build" } }));
    await t.hook("PostToolUse", call("h1"));
    const lines = t.seen.flatMap((e) => (e.type === "turn.step" ? [e.step.label] : []));
    expect(lines.at(-1)).toBe("Running swift build");
  });
});

describe("the reader's timestamp fallback, ids and gaps", () => {
  test("an entry without a timestamp takes the previous entry's time, and the first one the turn's start", () => {
    const r = new TimelineReader(CWD, 1000);
    const [first] = r.add({
      type: "assistant",
      uuid: "x",
      message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
    });
    expect(first?.at).toBe(1000);
    r.add(use("a", "Bash", { command: "ls" }, 5000));
    const [later] = r.add({
      type: "assistant",
      uuid: "th",
      message: { content: [{ type: "thinking", thinking: "" }] },
    });
    expect(later).toMatchObject({ at: 5000, durationMs: 1000 });
    // The next timed entry is measured from the last real timestamp.
    expect(r.add(thinking("t2", 9000))[0]?.durationMs).toBe(4000);
  });

  test("history: an untimed tool call sorts after the prompt, not in 1970", () => {
    const path = join(tempDir(), "h.jsonl");
    const s = Date.parse("2026-11-01T10:00:00Z");
    writeFileSync(
      path,
      [
        userPrompt("Old", s),
        {
          type: "assistant",
          uuid: "n",
          message: { content: [{ type: "tool_use", id: "n", name: "Bash", input: { command: "make" } }] },
        },
        text("ans", "Made.", s + 2000),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const [turn] = transcriptTurns("s1", path, { limit: 5, previewChars: 600, working: false, cwd: CWD });
    expect(turn?.steps?.[0]?.at).toBe(s);
  });

  test("two thinking blocks in one entry: the first takes the gap, the second 1 s; the next entry is timed from it", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 1000));
    const out = r.add({
      type: "assistant",
      uuid: "m",
      timestamp: iso(11_000),
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "thinking", thinking: "" },
        ],
      },
    });
    expect(out.map((s) => [s.id, s.durationMs])).toEqual([
      ["m", 10_000],
      ["m:1", 1000],
    ]);
    expect(r.add(thinking("n", 14_000))[0]?.durationMs).toBe(3000);
  });

  test("a thinking block after a tool call in the same entry is timed from the previous entry", () => {
    const r = new TimelineReader(CWD, 0);
    r.add(use("a", "Bash", { command: "ls" }, 1000));
    const out = r.add({
      type: "assistant",
      uuid: "m",
      timestamp: iso(7000),
      message: {
        content: [
          { type: "tool_use", id: "b", name: "Read", input: {} },
          { type: "thinking", thinking: "" },
        ],
      },
    });
    expect(out.find((s) => s.kind === "thinking")?.durationMs).toBe(6000);
  });

  test("thinking entries without a uuid (or with a non-string one) get distinct, stable string ids", () => {
    const make = () => {
      const r = new TimelineReader(CWD, 0);
      const e = {
        type: "assistant",
        timestamp: iso(5000),
        message: { content: [{ type: "thinking", thinking: "" }] },
      };
      r.add(e);
      r.add({ ...e });
      r.add({ ...e, uuid: 12 as unknown as string });
      return r.thoughts.map((s) => s.id);
    };
    const ids = make();
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(typeof id).toBe("string");
    expect(make()).toEqual(ids);
  });

  test("an empty or non-string tool id is no id; a non-string name is 'Used a tool'; both pass the schema", () => {
    const r = new TimelineReader(CWD, 0);
    const out = [
      ...r.add(use("", "Bash", { command: "ls" }, 10)),
      ...r.add(use({ x: 1 } as unknown as string, null as unknown as string, {}, 20)),
      ...r.add(use("ok", ["Bash"] as unknown as string, { command: "ls" }, 30)),
    ];
    expect(out.map((s) => s.id)).toEqual([undefined, undefined, "ok"]);
    expect(out[1]?.label).toBe("Used a tool");
    for (const s of out) expect(validStep(s)).toBe(true);
    // Rows without an id are never sent live, so there's nothing to upsert.
  });
});

describe("clean-up after a restart", () => {
  test("the phone's Stop after a helper restart deletes the turn's turn.action rows too", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "relay.db");
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "");
    const a = setup({ dbPath, path });
    await a.hook("UserPromptSubmit", { prompt: "Go" });
    const turnId = a.turnIds()[0] as string;
    const s = Date.now() + 5;
    a.append(userPrompt("Go", s - 5), use("a", "Bash", { command: "make" }, s));
    await a.poll();
    expect(a.rows(turnId)).toBe(1);
    a.db.close();
    resetLiveMessages();
    const b = setup({ dbPath, path });
    b.append({
      type: "user",
      uuid: "int",
      timestamp: iso(s + 100),
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    b.stopper.endStopped(turnId);
    expect(b.dones()[0]?.id).toBe(turnId);
    expect(b.rows(turnId)).toBe(0);
    expect(b.dones()[0]?.steps?.map((x) => x.id)).toEqual(["a"]);
  });

  test("a Stop for an older turn while a newer one runs deletes only the older turn's rows", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "First" });
    const [first] = t.turnIds() as [string];
    t.append(use("a1", "Bash", { command: "one" }, Date.now() + 5));
    await t.poll();
    await t.hook("UserPromptSubmit", { prompt: "Second" });
    const second = t.turnIds()[1] as string;
    t.append(use("b1", "Bash", { command: "two" }, Date.now() + 5));
    await t.poll();
    t.stopper.endStopped(first);
    expect(t.rows(first)).toBe(0);
    expect(t.rows(second)).toBe(1);
    expect((await t.live())?.actions?.map((a) => a.id)).toEqual(["b1"]);
  });
});

// Live messages when turns follow each other closely: a Stop whose turn is followed by a prompt queued at the
// computer, a Stop arriving after the next prompt's hook, and closing fences (closeOpenFence) in the cut.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphemes,
  type RelayEvent,
  TURN_MESSAGE_MAX,
  type Turn,
  TurnMessage,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages, shownMessage } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { closeOpenFence, compact } from "../src/daemon/render.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { StepTracker } from "../src/daemon/steps.ts";

const CWD = "/Users/me/Projects/my-app";
const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-messages-b2b-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  return path;
}
const append = (path: string, ...lines: object[]) =>
  appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
const iso = (ms: number) => new Date(ms).toISOString();
const text = (uuid: string, t: string, at = Date.now() + 5) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] },
});
const userPrompt = (t: string, at = Date.now() + 1) => ({
  type: "user",
  uuid: `u-${t}`,
  timestamp: iso(at),
  message: { content: t },
});
const toolUse = (id: string, name: string, input: Record<string, unknown>, at = Date.now() + 5) => ({
  type: "assistant",
  uuid: `tu-${id}`,
  timestamp: iso(at),
  message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, at = Date.now() + 6) => ({
  type: "user",
  uuid: `tr-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const hookTool = (id: string, name: string, input: Record<string, unknown>) => ({
  tool_use_id: id,
  tool_name: name,
  tool_input: input,
});

function setup() {
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
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  const msgs = () =>
    seen.filter((e): e is Extract<RelayEvent, { type: "turn.message" }> => e.type === "turn.message");
  const stepEvents = () =>
    seen.filter((e): e is Extract<RelayEvent, { type: "turn.step" }> => e.type === "turn.step");
  const turnIds = () => seen.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
  const dones = () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : [])) as Turn[];
  const doneFor = (id: string) => dones().find((d) => d.id === id);
  const status = () => registry.get("s1")?.status;
  const live = async () => {
    const res = await rpc("session.live", { sessionId: "s1" }, "device:x");
    return (res as { result: { turnId: string; messages?: TurnMessage[] } | null }).result;
  };
  return { db, hook, msgs, stepEvents, turnIds, dones, doneFor, status, live, seen };
}

describe("a prompt queued at the computer while Stop waits", () => {
  test("tool calls in both turns: each turn gets its own steps, messages, answer and stats", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "First", transcript_path: path });
    append(
      path,
      userPrompt("First"),
      text("m1", "Listing files."),
      toolUse("a", "Bash", { command: "ls" }),
      toolResult("a"),
      text("a1", "Turn one done."),
    );
    await t.hook("PreToolUse", hookTool("a", "Bash", { command: "ls" }));
    await t.hook("PostToolUse", hookTool("a", "Bash", { command: "ls" }));
    const stop = t.hook("Stop", { last_assistant_message: "Turn one done.", transcript_path: path });
    await Bun.sleep(50);
    append(path, userPrompt("Second"));
    await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
    append(
      path,
      text("n1", "Reading the config."),
      toolUse("b", "Read", { file_path: `${CWD}/package.json` }),
    );
    await t.hook("PreToolUse", hookTool("b", "Read", { file_path: `${CWD}/package.json` }));
    await stop;
    const [first, second] = t.turnIds() as [string, string];

    const one = t.doneFor(first);
    expect(one?.prompt).toBe("First");
    expect(one?.summary).toBe("Turn one done.");
    expect(one?.messages?.map((m) => m.id)).toEqual(["m1"]);
    expect(one?.steps?.length).toBe(1);
    expect(one?.stats.toolCalls).toBe(1);
    expect(t.doneFor(second)).toBeUndefined();
    expect(t.status()).toBe("working");
    // The second turn is still followed: its message and its step went out live, and session.live has them.
    expect(
      t
        .msgs()
        .filter((e) => e.turnId === second)
        .map((e) => e.message.id),
    ).toEqual(["n1"]);
    expect(t.stepEvents().some((e) => e.turnId === second)).toBe(true);
    expect((await t.live())?.turnId).toBe(second);
    expect((await t.live())?.messages?.map((m) => m.id)).toEqual(["n1"]);

    append(path, toolResult("b"), text("a2", "Turn two done."));
    await t.hook("PostToolUse", hookTool("b", "Read", { file_path: `${CWD}/package.json` }));
    await t.hook("Stop", { last_assistant_message: "Turn two done.", transcript_path: path });
    const two = t.doneFor(second);
    expect(two?.prompt).toBe("Second");
    expect(two?.summary).toBe("Turn two done.");
    expect(two?.messages?.map((m) => m.id)).toEqual(["n1"]);
    expect(two?.steps?.length).toBe(1);
    expect(two?.stats.toolCalls).toBe(1);
    expect(t.status()).toBe("idle");
    expect(t.dones()).toHaveLength(2);
    expect(
      (
        t.db.query("SELECT COUNT(*) AS n FROM events WHERE type IN ('turn.message','turn.step')").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  test("three quick prompts: two Stops overlap, each turn ends with its own answer, the third is still followed", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "One", transcript_path: path });
    append(path, userPrompt("One"), text("x1", "One working."), text("o1", "One done."));
    const stop1 = t.hook("Stop", { last_assistant_message: "One done.", transcript_path: path });
    await Bun.sleep(30);
    append(path, userPrompt("Two"));
    await t.hook("UserPromptSubmit", { prompt: "Two", transcript_path: path });
    append(path, text("y1", "Two working."), text("o2", "Two done."));
    const stop2 = t.hook("Stop", { last_assistant_message: "Two done.", transcript_path: path });
    await Bun.sleep(30);
    append(path, userPrompt("Three"));
    await t.hook("UserPromptSubmit", { prompt: "Three", transcript_path: path });
    await Promise.all([stop1, stop2]);
    const [one, two, three] = t.turnIds() as [string, string, string];
    expect(t.doneFor(one)?.summary).toBe("One done.");
    expect(t.doneFor(one)?.messages?.map((m) => m.id)).toEqual(["x1"]);
    expect(t.doneFor(two)?.summary).toBe("Two done.");
    expect(t.doneFor(two)?.prompt).toBe("Two");
    expect(t.doneFor(two)?.messages?.map((m) => m.id)).toEqual(["y1"]);
    expect(t.doneFor(three)).toBeUndefined();
    expect(t.status()).toBe("working");
    append(path, text("z1", "Three working."));
    await t.hook("PreToolUse", hookTool("c", "Bash", { command: "pwd" }));
    expect(
      t
        .msgs()
        .filter((e) => e.turnId === three)
        .map((e) => e.message.id),
    ).toEqual(["z1"]);
  });

  test("StopFailure during the wait: the first turn fails, the second keeps running and being followed", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "First", transcript_path: path });
    append(path, userPrompt("First"), text("m1", "Trying."), text("e1", "Partial."));
    const stop = t.hook("StopFailure", {
      last_assistant_message: "Partial.",
      error: "overloaded",
      transcript_path: path,
    });
    await Bun.sleep(50);
    append(path, userPrompt("Second"));
    await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
    await stop;
    const [first, second] = t.turnIds() as [string, string];
    expect(t.doneFor(first)?.failed).toBe(true);
    expect(t.doneFor(first)?.messages?.map((m) => m.id)).toEqual(["m1"]);
    expect(t.seen.some((e) => e.type === "session.notice" && e.level === "error")).toBe(true);
    expect(t.status()).toBe("working");
    append(path, text("n1", "Second turn."));
    await t.hook("PreToolUse", hookTool("b", "Bash", { command: "ls" }));
    expect(
      t
        .msgs()
        .filter((e) => e.turnId === second)
        .map((e) => e.message.id),
    ).toEqual(["n1"]);
  });

  test('a turn\'s own prompt repeated by the queued one ("continue" twice) still splits at the right place', async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "continue", transcript_path: path });
    append(path, userPrompt("continue"), text("m1", "First pass."), text("a1", "First answer."));
    const stop = t.hook("Stop", { last_assistant_message: "First answer.", transcript_path: path });
    await Bun.sleep(50);
    append(path, { ...userPrompt("continue"), uuid: "u-continue-2" });
    await t.hook("UserPromptSubmit", { prompt: "continue", transcript_path: path });
    append(path, text("n1", "Second pass."));
    await stop;
    const [first] = t.turnIds() as [string];
    expect(t.doneFor(first)?.messages?.map((m) => m.id)).toEqual(["m1"]);
    expect(t.doneFor(first)?.summary).toBe("First answer.");
  });
});

// ---------------------------------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------------------------------

/** The fence still open at the end (CommonMark: a closer uses the opener's character, at least as long, no info). */
function openFenceAt(textIn: string): string | null {
  const body = textIn.replace(/ …$/, "");
  let open: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const fence = m[1] as string;
    const info = m[2] as string;
    if (open === null) {
      if (fence.startsWith("`") && info.includes("`")) continue;
      open = fence;
    } else if (fence[0] === open[0] && fence.length >= open.length && !info.trim()) open = null;
  }
  return open;
}

describe("closing fences", () => {
  test("closeOpenFence closes ``` and ~~~ with their own marker, and leaves balanced text alone", () => {
    expect(closeOpenFence("```ts\nconst a = 1;")).toBe("```ts\nconst a = 1;\n```");
    expect(closeOpenFence("~~~\nx")).toBe("~~~\nx\n~~~");
    expect(closeOpenFence("```\nx\n```\nafter")).toBe("```\nx\n```\nafter");
    expect(closeOpenFence("no fence")).toBe("no fence");
    expect(closeOpenFence("~~~\n```\nstill inside")).toBe("~~~\n```\nstill inside\n~~~");
    expect(closeOpenFence("```\n~~~\nstill inside")).toBe("```\n~~~\nstill inside\n```");
  });

  test("a ~~~ block with ``` lines inside, cut in a message and in the preview, ends closed", () => {
    const block = `~~~md\n${"```js\nconst a = 1;\n```\n".repeat(200)}~~~`;
    const m = shownMessage({ id: "m", raw: block, at: 1 });
    expect(m.truncated).toBe(true);
    expect(openFenceAt(m.text)).toBeNull();
    expect(graphemes(m.text).length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
    expect(TurnMessage.safeParse(m).success).toBe(true);
    expect(openFenceAt(compact(block, 600).text)).toBeNull();
  });

  test("an unterminated fence after an intro (Claude never closed it): the cut leaves no open fence", () => {
    const raw = `Here:\n\n\`\`\`\n${"line of code\n".repeat(400)}`;
    const m = shownMessage({ id: "m", raw, at: 1 });
    expect(openFenceAt(m.text)).toBeNull();
    expect(openFenceAt(compact(raw, 600).text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// CommonMark fences in the cut, and a Stop arriving after the next prompt's hook
// ---------------------------------------------------------------------------------------------------

describe("CommonMark fences in the cut", () => {
  test("a closer longer than its opener, or with trailing spaces, closes it: nothing extra is added", () => {
    expect(closeOpenFence("```\nx\n`````")).toBe("```\nx\n`````");
    expect(closeOpenFence("~~~\nx\n~~~~   ")).toBe("~~~\nx\n~~~~   ");
    expect(closeOpenFence("````\nx\n```")).toBe("````\nx\n```\n````");
  });

  test("```inline``` at the start of a line is inline code, not a fence: the cut adds none", () => {
    const raw = `\`\`\`npm i\`\`\` installs it. ${"word ".repeat(600)}`;
    const m = shownMessage({ id: "m", raw, at: 1 });
    expect(m.truncated).toBe(true);
    expect(m.text.split("\n")).toHaveLength(1);
    expect(openFenceAt(m.text)).toBeNull();
  });

  test("a fence line thousands of backticks long is cut within the limits and stays valid", () => {
    for (const raw of ["`".repeat(3000), `${"~".repeat(1500)}\n${"x ".repeat(2000)}`]) {
      const m = shownMessage({ id: "m", raw, at: 1 });
      expect(m.truncated).toBe(true);
      expect(TurnMessage.safeParse(m).success).toBe(true);
      expect(openFenceAt(m.text)).toBeNull();
    }
  });

  test("whole paragraphs after a balanced code block are kept, and the result is closed", () => {
    const raw = `Intro.\n\n\`\`\`\`md\n\`\`\`js\nx\n\`\`\`\n\`\`\`\`\n\n${"Another paragraph here.\n\n".repeat(200)}`;
    const m = shownMessage({ id: "m", raw, at: 1 });
    expect(m.truncated).toBe(true);
    expect(m.text.startsWith("Intro.\n\n````md\n```js\nx\n```\n````\n\nAnother paragraph here.")).toBe(true);
    expect(openFenceAt(m.text)).toBeNull();
    expect(graphemes(m.text).length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  });
});

describe("a Stop arriving just after the next prompt's hook", () => {
  test("the earlier turn gets its answer and messages; the new one keeps running, followed, with its steps", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "First", transcript_path: path });
    append(
      path,
      userPrompt("First"),
      text("m1", "Checking."),
      toolUse("a", "Bash", { command: "ls" }),
      toolResult("a"),
      text("a1", "First done."),
    );
    await t.hook("PreToolUse", hookTool("a", "Bash", { command: "ls" }));
    await t.hook("PostToolUse", hookTool("a", "Bash", { command: "ls" }));
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    append(path, userPrompt("Second"));
    await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
    await t.hook("Stop", { last_assistant_message: "First done.", transcript_path: path });
    const [first, second] = t.turnIds() as [string, string];
    expect(t.dones().map((d) => [d.id, d.summary])).toEqual([[first, "First done."]]);
    expect(t.doneFor(first)?.messages?.map((m) => m.id)).toEqual(["m1"]);
    expect(t.doneFor(first)?.steps?.length).toBe(1);
    expect(t.status()).toBe("working");
    append(path, text("n1", "On it."), toolUse("b", "Bash", { command: "pwd" }));
    await t.hook("PreToolUse", hookTool("b", "Bash", { command: "pwd" }));
    expect(
      t
        .msgs()
        .filter((e) => e.turnId === second)
        .map((e) => e.message.id),
    ).toEqual(["n1"]);
    expect(t.stepEvents().some((e) => e.turnId === second)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// stopOwner moves a Stop to the earlier turn only on positive evidence
// ---------------------------------------------------------------------------------------------------

describe("which turn a Stop arriving after the next prompt's hook ends", () => {
  const note = "<task-notification> <task-id>b1</task-id> <status>completed</status> </task-notification>";
  const summaries = (t: ReturnType<typeof setup>) => {
    const ids = t.turnIds();
    return t.dones().map((d) => [`t${ids.indexOf(d.id) + 1}`, d.summary]);
  };

  test("an earlier turn with only tool calls, no text: the new turn's (lagging) Stop stays with the new turn", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "First", transcript_path: path });
    append(path, userPrompt("First"), toolUse("a", "Bash", { command: "ls" }));
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    append(path, userPrompt("Second"));
    await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
    append(path, text("n1", "Second working."));
    await t.hook("Stop", { last_assistant_message: "Second done.", transcript_path: path });
    expect(summaries(t)).toEqual([["t2", "Second done."]]);
    expect(t.status()).toBe("idle");
  });

  test("a typed turn whose Stop arrives just after a background task's prompt ends the typed turn", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "Build it", transcript_path: path });
    append(path, userPrompt("Build it"), text("w1", "Starting the build."), text("a1", "Build started."));
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    append(path, {
      type: "user",
      uuid: "u-note",
      timestamp: iso(Date.now() + 1),
      message: { content: note },
    });
    await t.hook("UserPromptSubmit", { prompt: note, transcript_path: path });
    await t.hook("Stop", { last_assistant_message: "Build started.", transcript_path: path });
    expect(summaries(t)).toEqual([["t1", "Build started."]]);
    expect(t.doneFor(t.turnIds()[0] as string)?.messages?.map((m) => m.id)).toEqual(["w1"]);
    expect(t.status()).toBe("working");
  });

  test('the same prompt twice ("continue"): a Stop after the second prompt\'s hook ends the first', async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "continue", transcript_path: path });
    append(path, userPrompt("continue"), text("w1", "Part one."), text("a1", "First half done."));
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    append(path, { ...userPrompt("continue"), uuid: "u-continue-2" });
    await t.hook("UserPromptSubmit", { prompt: "continue", transcript_path: path });
    await t.hook("Stop", { last_assistant_message: "First half done.", transcript_path: path });
    expect(summaries(t)).toEqual([["t1", "First half done."]]);
    expect(t.doneFor(t.turnIds()[0] as string)?.messages?.map((m) => m.id)).toEqual(["w1"]);
  });

  test("no transcript: a Stop after the next prompt stays with the open turn, nothing breaks", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "First" });
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    await t.hook("UserPromptSubmit", { prompt: "Second" });
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(summaries(t)).toEqual([["t2", "Done."]]);
  });
});

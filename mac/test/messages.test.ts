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
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import {
  finishedMessages,
  MessageTracker,
  messageFrom,
  parseMessagesJson,
  resetLiveMessages,
  shownMessage,
} from "../src/daemon/messages.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";
import { formatEvent } from "../src/tailFormat.ts";

// Live messages: what Claude writes between its tool calls, followed while the turn runs and kept with the finished turn.

const CWD = "/Users/me/Projects/my-app";
const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempFile(lines: object[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-messages-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return path;
}
const append = (path: string, ...lines: object[]) =>
  appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

const iso = (ms: number) => new Date(ms).toISOString();
const text = (uuid: string, t: string, at = Date.now() + 5, extra: object = {}) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] },
  ...extra,
});
const userPrompt = (t: string, at = Date.now()) => ({
  type: "user",
  uuid: `u-${t}`,
  timestamp: iso(at),
  message: { content: t },
});
const toolUse = (id: string, at = Date.now() + 5) => ({
  type: "assistant",
  uuid: `tu-${id}`,
  timestamp: iso(at),
  message: {
    model: "claude-opus-5-5",
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
  },
});

describe("what counts as a message", () => {
  test("Claude's text in the main conversation, with the entry's uuid and time", () => {
    expect(messageFrom(text("m1", "Let me look.", 1000))).toEqual({
      id: "m1",
      raw: "Let me look.",
      at: 1000,
    });
  });

  test("not a subagent's, an API error, a synthetic entry, thinking, a tool call, blank text or no uuid", () => {
    expect(messageFrom(text("m", "x", 1, { isSidechain: true }))).toBeNull();
    expect(messageFrom(text("m", "API Error: 529", 1, { isApiErrorMessage: true }))).toBeNull();
    expect(
      messageFrom({
        ...text("m", "No response requested."),
        message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
      }),
    ).toBeNull();
    expect(
      messageFrom({
        type: "assistant",
        uuid: "m",
        message: { content: [{ type: "thinking", thinking: "hmm" }] },
      }),
    ).toBeNull();
    expect(messageFrom(toolUse("a"))).toBeNull();
    expect(messageFrom(text("m", "  \n "))).toBeNull();
    expect(messageFrom({ ...text("m", "x"), uuid: undefined })).toBeNull();
    expect(
      messageFrom({ type: "user", uuid: "u", message: { content: [{ type: "text", text: "hi" }] } }),
    ).toBeNull();
    expect(messageFrom(null)).toBeNull();
  });

  test("an entry with two text blocks is one message", () => {
    const e = {
      type: "assistant",
      uuid: "m",
      timestamp: iso(1),
      message: {
        content: [
          { type: "text", text: "One." },
          { type: "tool_use", id: "a" },
          { type: "text", text: "Two." },
        ],
      },
    };
    expect(messageFrom(e)?.raw).toBe("One.\n\nTwo.");
  });

  test("an entry from before the turn started is not one of its messages", () => {
    expect(messageFrom(text("m", "old", 999), 1000)).toBeNull();
    expect(messageFrom(text("m", "new", 1000), 1000)?.raw).toBe("new");
  });
});

describe("the text people see", () => {
  test("a secret is redacted", () => {
    const m = shownMessage({
      id: "m",
      raw: "Set GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123 first.",
      at: 1,
    });
    expect(m.text).not.toContain("ghp_ABCDEFGHIJ");
    expect(m.text).toContain("[redacted:");
    expect(m.truncated).toBeUndefined();
  });

  test("a secret straddling the cut never shows its start", () => {
    const raw = `${"word ".repeat(398)}ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123 and more`;
    const m = shownMessage({ id: "m", raw, at: 1 });
    expect(m.text).not.toContain("ghp_");
    expect(graphemes(m.text).length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  });

  test("2000 emoji stay whole; 2001 are cut between characters, with ' …', and marked", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(shownMessage({ id: "m", raw: family.repeat(TURN_MESSAGE_MAX), at: 1 })).toEqual({
      id: "m",
      text: family.repeat(TURN_MESSAGE_MAX),
      at: 1,
    });
    const cut = shownMessage({ id: "m", raw: family.repeat(TURN_MESSAGE_MAX + 1), at: 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith(" …")).toBe(true);
    const g = graphemes(cut.text);
    expect(g.length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
    for (const ch of g.slice(0, -2)) expect(ch).toBe(family);
    expect(TurnMessage.safeParse(cut).success).toBe(true);
  });

  test("a long message keeps whole paragraphs, or is cut at a word", () => {
    const para = `${"a".repeat(900)}`;
    const m = shownMessage({ id: "m", raw: `${para}\n\n${para}\n\n${para}`, at: 1 });
    expect(m.text).toBe(`${para}\n\n${para} …`);
    const words = shownMessage({ id: "m", raw: "lorem ipsum ".repeat(300), at: 1 });
    expect(words.text).toMatch(/(lorem|ipsum) …$/);
    expect(graphemes(words.text).length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  });

  test("an open code fence is closed when the cut lands inside it", () => {
    const m = shownMessage({ id: "m", raw: `\`\`\`ts\n${"const x = 1;\n".repeat(300)}`, at: 1 });
    expect(m.truncated).toBe(true);
    expect((m.text.match(/```/g) ?? []).length % 2).toBe(0);
    expect(graphemes(m.text).length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  });

  test("many combining marks per character stay under the storage guard and pass the schema", () => {
    const heavy = `e${"́".repeat(40)}`;
    const m = shownMessage({ id: "m", raw: heavy.repeat(1500), at: 1 });
    expect(TurnMessage.safeParse(m).success).toBe(true);
  });
});

describe("a finished turn's messages", () => {
  const raw = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `m${i}`, raw: `Message ${i}`, at: i }));

  test("the final answer is left out when it is the last message", () => {
    expect(finishedMessages(raw(3), "  Message 2\n").messages.map((m) => m.id)).toEqual(["m0", "m1"]);
  });

  test("nothing is left out when the last message isn't the answer (the transcript lagged)", () => {
    expect(finishedMessages(raw(3), "Done.").messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(finishedMessages(raw(2), null).messages).toHaveLength(2);
  });

  test("at most 50, the rest counted", () => {
    const f = finishedMessages(raw(54), "Message 53");
    expect(f.messages).toHaveLength(50);
    expect(f.messagesMore).toBe(3);
    expect(finishedMessages(raw(51), "Message 50").messagesMore).toBeUndefined();
  });

  test("stored JSON that is missing or corrupt reads as no messages", () => {
    expect(parseMessagesJson(null)).toEqual({});
    expect(parseMessagesJson("{not json")).toEqual({});
    expect(parseMessagesJson('{"messages": "x"}')).toEqual({});
    expect(parseMessagesJson('{"messages": [{"id": 1}], "messagesMore": -2}')).toEqual({});
    expect(parseMessagesJson('{"messages": [{"id": "a", "text": "t", "at": 1}], "messagesMore": 2}')).toEqual(
      {
        messages: [{ id: "a", text: "t", at: 1 }],
        messagesMore: 2,
      },
    );
  });
});

function setup(pollMs = 0) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs });
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
  const sent = () => seen.flatMap((e) => (e.type === "turn.message" ? [e.message.text] : []));
  const turnId = () =>
    (seen.findLast((e) => e.type === "turn.started") as Extract<RelayEvent, { type: "turn.started" }>).turnId;
  const done = () =>
    (seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>).turn;
  const rows = () =>
    (db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.message'").get() as { n: number }).n;
  return { db, events, registry, messages, rpc, seen, hook, sent, turnId, done, rows };
}

const tool = (id: string) => ({ tool_use_id: id, tool_name: "Bash", tool_input: { command: "ls" } });

describe("live", () => {
  test("a message written after the turn starts is sent once, on the next tool hook, with its uuid", async () => {
    const t = setup();
    const path = tempFile([userPrompt("old"), text("old-answer", "Earlier answer.", Date.now() - 60_000)]);
    await t.hook("UserPromptSubmit", { prompt: "Fix it", transcript_path: path });
    append(path, userPrompt("Fix it"), text("m1", "Let me look at the auth code first."), toolUse("a"));
    expect(t.sent()).toEqual([]);
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual(["Let me look at the auth code first."]);
    const e = t.seen.findLast((x) => x.type === "turn.message") as Extract<
      RelayEvent,
      { type: "turn.message" }
    >;
    expect(e).toMatchObject({ sessionId: "s1", turnId: t.turnId(), message: { id: "m1" } });
    await t.hook("PostToolUse", tool("a"));
    expect(t.sent()).toHaveLength(1);
  });

  test("read every pollMs while the turn runs, with no hook", async () => {
    const t = setup(20);
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "Fix it", transcript_path: path });
    append(path, text("m1", "Thinking out loud."));
    await Bun.sleep(80);
    expect(t.sent()).toEqual(["Thinking out loud."]);
    await t.hook("SessionEnd");
  });

  test("a half-written line waits for the rest", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    const line = JSON.stringify(text("m1", "Ünïcödé 😀 split"));
    const bytes = Buffer.from(`${line}\n`);
    const half = bytes.indexOf(Buffer.from("😀")) + 2; // inside the emoji's bytes
    appendFileSync(path, bytes.subarray(0, half));
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual([]);
    appendFileSync(path, bytes.subarray(half));
    await t.hook("PostToolUse", tool("a"));
    expect(t.sent()).toEqual(["Ünïcödé 😀 split"]);
  });

  test("not messages: subagents, API errors, synthetic, thinking, tool calls, entries from before the turn", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(
      path,
      text("a", "sub", Date.now() + 5, { isSidechain: true }),
      text("b", "API Error", Date.now() + 5, { isApiErrorMessage: true }),
      {
        ...text("c", "No response requested."),
        message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
      },
      {
        type: "assistant",
        uuid: "d",
        timestamp: iso(Date.now() + 5),
        message: { content: [{ type: "thinking", thinking: "" }] },
      },
      toolUse("e"),
      text("f", "The previous turn's answer, flushed late.", Date.now() - 2000),
      text("g", "Real."),
    );
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual(["Real."]);
  });

  test("the 51st message is counted, not sent", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, ...Array.from({ length: 53 }, (_, i) => text(`m${i}`, `Message ${i}`)));
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toHaveLength(50);
  });

  test("a transcript that shrinks is read again from the start without repeating a message", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("m1", "One."), toolUse("a"), toolUse("b"));
    await t.hook("PreToolUse", tool("a"));
    writeFileSync(path, `${JSON.stringify(text("m1", "One."))}\n${JSON.stringify(text("m2", "Two."))}\n`);
    await t.hook("PreToolUse", tool("b"));
    expect(t.sent()).toEqual(["One.", "Two."]);
  });

  test("no transcript: nothing live, and nothing breaks", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "x" });
    await t.hook("PreToolUse", tool("a"));
    await t.hook("UserPromptSubmit", { prompt: "y", transcript_path: "/nonexistent/t.jsonl" });
    await t.hook("PreToolUse", tool("b"));
    expect(t.sent()).toEqual([]);
  });

  test("never pushed", () => {
    const e = {
      seq: 1,
      ts: 1,
      type: "turn.message",
      sessionId: "s1",
      turnId: "t1",
      message: { id: "m", text: "Hi", at: 1 },
    } as RelayEvent;
    expect(alertFor(e, () => "x")).toBeNull();
  });

  test("relay tail prints one line: the session and the message's first line", () => {
    const line = formatEvent({
      seq: 7,
      ts: 1,
      type: "turn.message",
      sessionId: "4375b77a-1111",
      turnId: "t1",
      message: { id: "m", text: "\nFound it.\n\nMore detail.", at: 1 },
    });
    expect(line).toContain("#7");
    expect(line).toContain("4375b77a Found it.");
    expect(line).not.toContain("\n");
  });

  test("session.live carries the running turn's messages, and sync keeps them until the turn ends", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("m1", "One."), text("m2", "Two."));
    await t.hook("PreToolUse", tool("a"));
    const res = await t.rpc("session.live", { sessionId: "s1" }, "device:x");
    const live = "result" in res ? (res.result as { turnId: string; messages?: TurnMessage[] }) : null;
    expect(live?.turnId).toBe(t.turnId());
    expect(live?.messages?.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(t.events.sinceForSync(0).filter((e) => e.type === "turn.message")).toHaveLength(2);
  });
});

describe("the end of the turn", () => {
  test("Stop keeps the messages from the transcript, without the final answer, and stops following", async () => {
    const t = setup();
    const path = tempFile([userPrompt("old")]);
    await t.hook("UserPromptSubmit", { prompt: "Fix the login bug", transcript_path: path });
    append(
      path,
      userPrompt("Fix the login bug"),
      text("m1", "Let me look at the auth code first."),
      toolUse("a"),
      text("m2", "Found it: the token is never refreshed."),
      toolUse("b"),
      text("m3", "Fixed: the token now refreshes."),
    );
    await t.hook("PreToolUse", tool("a"));
    expect(t.rows()).toBe(3);
    await t.hook("Stop", {
      last_assistant_message: "Fixed: the token now refreshes.",
      transcript_path: path,
    });
    const turn = t.done();
    expect(turn.summary).toBe("Fixed: the token now refreshes.");
    expect(turn.messages?.map((m) => [m.id, m.text])).toEqual([
      ["m1", "Let me look at the auth code first."],
      ["m2", "Found it: the token is never refreshed."],
    ]);
    expect(turn.messagesMore).toBeUndefined();
    // The live rows are deleted: the turn carries them now.
    expect(t.rows()).toBe(0);
    append(path, text("m4", "Late."));
    await t.hook("PreToolUse", tool("c"));
    expect(t.sent()).toHaveLength(3);
    // From the database too.
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    const stored = "result" in res ? (res.result as Turn[])[0] : undefined;
    expect(stored?.messages?.map((m) => m.id)).toEqual(["m1", "m2"]);
    const live = await t.rpc("session.live", { sessionId: "s1" }, "device:x");
    expect("result" in live ? live.result : "x").toBeNull();
  });

  test("a turn without messages has no messages field", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x"), text("only", "Done."));
    await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
    expect("messages" in t.done()).toBe(false);
    const row = t.db.query("SELECT messages_json FROM turns").get() as { messages_json: string | null };
    expect(row.messages_json).toBeNull();
  });

  test("over 50 messages: 50 kept, the rest counted", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x"), ...Array.from({ length: 55 }, (_, i) => text(`m${i}`, `Message ${i}`)));
    await t.hook("Stop", { last_assistant_message: "Message 54", transcript_path: path });
    expect(t.done().messages).toHaveLength(50);
    expect(t.done().messagesMore).toBe(4);
  });

  test("SessionEnd and going idle stop following and delete the live rows", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("m1", "One."));
    await t.hook("PreToolUse", tool("a"));
    expect(t.rows()).toBe(1);
    t.registry.setStatus("s1", "idle");
    expect(t.rows()).toBe(0);
    append(path, text("m2", "Two."));
    await t.hook("PreToolUse", tool("b"));
    expect(t.sent()).toEqual(["One."]);

    await t.hook("UserPromptSubmit", { prompt: "y", transcript_path: path });
    append(path, text("m3", "Three."));
    await t.hook("PreToolUse", tool("c"));
    await t.hook("SessionEnd");
    expect(t.rows()).toBe(0);
    append(path, text("m4", "Four."));
    await t.hook("PreToolUse", tool("d"));
    expect(t.sent()).toEqual(["One.", "Three."]);
  });

  test("the phone's Stop keeps the messages, without the stopped turn's last text", async () => {
    const { TurnStopper } = await import("../src/daemon/stop.ts");
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const broker = new Broker(db, events);
    const config = { previewChars: 600 } as RelayConfig;
    const messages = new MessageTracker(events, { pollMs: 0 });
    const path = tempFile();
    const stopper = new TurnStopper({
      db,
      events,
      registry,
      broker,
      config,
      messages,
      transcriptPath: () => path,
    });
    const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
    const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper, messages });
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const hook = (event: string, fields: Record<string, unknown> = {}) =>
      hooks.handle(
        { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
        new AbortController().signal,
      );
    await hook("UserPromptSubmit", { prompt: "Rewrite the checkout", transcript_path: path });
    append(
      path,
      userPrompt("Rewrite the checkout", Date.now() + 2),
      text("m1", "Starting with the cart."),
      toolUse("a"),
      text("m2", "Now the payment step."),
      {
        type: "user",
        timestamp: iso(Date.now() + 10),
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      },
    );
    await hook("PreToolUse", tool("a"));
    const turnId = (
      seen.find((e) => e.type === "turn.started") as Extract<RelayEvent, { type: "turn.started" }>
    ).turnId;
    expect(stopper.endStopped(turnId)).toBe(turnId);
    const turn = (seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>)
      .turn;
    expect(turn.stopped).toBe(true);
    expect(turn.summary).toBe("Now the payment step.");
    expect(turn.messages?.map((m) => m.id)).toEqual(["m1"]);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.message'").get() as { n: number }).n,
    ).toBe(0);
  });
});

test("history: earlier texts are the turn's messages, the last stays the answer", () => {
  const path = tempFile([
    userPrompt("Fix the cart", 1000),
    text("m1", "Looking at the cart.", 2000),
    toolUse("a", 3000),
    text("m2", "Fixed it.", 4000),
    userPrompt("Thanks", 5000),
    text("m3", "You're welcome.", 6000),
  ]);
  const turns = transcriptTurns("s1", path, { limit: 5, previewChars: 600, working: false, cwd: CWD });
  expect(turns.map((t) => t.summary)).toEqual(["You're welcome.", "Fixed it."]);
  expect("messages" in (turns[0] as Turn)).toBe(false);
  expect(turns[1]?.messages).toEqual([{ id: "m1", text: "Looking at the cart.", at: 2000 }]);
});

test("migration 11: a version-10 database gains messages_json, and its turns have no messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-mig11-"));
  dirs.push(dir);
  const path = join(dir, "relay.db");
  let db = openDb(path);
  db.query(
    "INSERT INTO turns (id, session_id, summary, stats_json, started_at, ended_at) VALUES ('t_old', 's1', 'Done.', NULL, 1, 2)",
  ).run();
  db.exec("ALTER TABLE turns DROP COLUMN messages_json; PRAGMA user_version = 10;");
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
  expect(turn && "messages" in turn).toBe(false);
  db.close();
});

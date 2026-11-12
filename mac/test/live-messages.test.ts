// Live messages, case by case: what counts as a message, redaction and the 2000-character cut, the live reader, the
// end of the turn, session.live, history, and relay tail. The basic flow is in messages.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphemes,
  type RelayEvent,
  RelayEvent as RelayEventSchema,
  TURN_MESSAGE_MAX,
  type Turn,
  TurnMessage,
  Turn as TurnSchema,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
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

const CWD = "/Users/me/Projects/my-app";
const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-live-messages-"));
  dirs.push(dir);
  return dir;
}
const jsonl = (lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");
function tempFile(lines: object[] = []): string {
  const path = join(tempDir(), "t.jsonl");
  writeFileSync(path, jsonl(lines));
  return path;
}
const append = (path: string, ...lines: object[]) => appendFileSync(path, jsonl(lines));

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
const tool = (id: string) => ({ tool_use_id: id, tool_name: "Bash", tool_input: { command: "ls" } });
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function setup(opts: { pollMs?: number; dbPath?: string } = {}) {
  const db = openDb(opts.dbPath ?? ":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: opts.pollMs ?? 0 });
  const presence = { noteLocalActivity() {}, get: () => ({ present: true }) } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}, sessionId = "s1") =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: sessionId, cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  const msgEvents = () =>
    seen.filter((e): e is Extract<RelayEvent, { type: "turn.message" }> => e.type === "turn.message");
  const sent = () => msgEvents().map((e) => e.message.text);
  const started = () =>
    seen.filter((e): e is Extract<RelayEvent, { type: "turn.started" }> => e.type === "turn.started");
  const turnId = () => started().at(-1)?.turnId as string;
  const dones = () =>
    seen
      .filter((e): e is Extract<RelayEvent, { type: "turn.done" }> => e.type === "turn.done")
      .map((e) => e.turn);
  const done = () => dones().at(-1) as Turn;
  const rows = (turn?: string) =>
    (
      (turn
        ? db
            .query(
              "SELECT COUNT(*) AS n FROM events WHERE type = 'turn.message' AND json_extract(data_json, '$.turnId') = ?",
            )
            .get(turn)
        : db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.message'").get()) as { n: number }
    ).n;
  const live = async (sessionId = "s1") => {
    const res = await rpc("session.live", { sessionId }, "device:x");
    if (!("result" in res)) throw new Error(JSON.stringify(res));
    return res.result as { turnId: string; messages?: TurnMessage[] } | null;
  };
  return {
    db,
    events,
    registry,
    messages,
    rpc,
    seen,
    hook,
    sent,
    msgEvents,
    turnId,
    done,
    dones,
    rows,
    live,
  };
}

// ---------------------------------------------------------------------------------------------------
// What counts as a message
// ---------------------------------------------------------------------------------------------------

describe("what counts as a message", () => {
  test("an entry without a model field is still Claude's message (only <synthetic> is left out)", () => {
    const e = {
      type: "assistant",
      uuid: "m",
      timestamp: iso(5),
      message: { content: [{ type: "text", text: "Hi." }] },
    };
    expect(messageFrom(e)?.raw).toBe("Hi.");
  });

  test("text blocks that aren't strings, and blank ones, are skipped without a stray blank line", () => {
    const e = {
      type: "assistant",
      uuid: "m",
      timestamp: iso(5),
      message: {
        model: "claude-opus-5-5",
        content: [
          { type: "text", text: null },
          { type: "text", text: 42 },
          { type: "text", text: "   \n\t" },
          { type: "text", text: "Real text." },
          null,
          { type: "text" },
        ],
      },
    };
    expect(messageFrom(e)?.raw).toBe("Real text.");
  });

  test("content that is a string, not blocks, is not a crash", () => {
    expect(() => messageFrom({ type: "assistant", uuid: "m", message: { content: "plain" } })).not.toThrow();
  });

  test("a malformed line between two messages doesn't lose either", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    appendFileSync(
      path,
      `${JSON.stringify(text("m1", "One."))}\n{"type":"assistant",broken\n${JSON.stringify(text("m2", "Two."))}\n`,
    );
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual(["One.", "Two."]);
  });

  test("CRLF line endings in the transcript still read", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    appendFileSync(
      path,
      `${JSON.stringify(text("m1", "One."))}\r\n${JSON.stringify(text("m2", "Two."))}\r\n`,
    );
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual(["One.", "Two."]);
  });

  test("user, system and summary entries with text are never messages", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(
      path,
      {
        type: "user",
        uuid: "u1",
        timestamp: iso(Date.now() + 5),
        message: { content: [{ type: "text", text: "typed" }] },
      },
      {
        type: "system",
        uuid: "s1",
        timestamp: iso(Date.now() + 5),
        content: "Compacted",
        message: { content: [{ type: "text", text: "sys" }] },
      },
      { type: "summary", uuid: "s2", summary: "A summary" },
      text("m1", "Mine."),
    );
    await t.hook("PostToolUse", tool("a"));
    expect(t.sent()).toEqual(["Mine."]);
  });

  test("the previous turn's text flushed after the new turn started is not sent live", async () => {
    const t = setup();
    const before = Date.now() - 500;
    const path = tempFile([userPrompt("First", before - 1000)]);
    await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
    // Written after the new prompt entry, but timestamped before the turn started.
    append(
      path,
      userPrompt("Second", Date.now() + 1),
      text("late", "First turn's late text.", before),
      text("m1", "Second turn."),
    );
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual(["Second turn."]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The text: redaction and the 2000-character cut
// ---------------------------------------------------------------------------------------------------

const raw = (s: string) => ({ id: "m", raw: s, at: 1 });
const g = (s: string) => graphemes(s).length;

describe("the text", () => {
  test("2000 characters made of a letter and a combining mark are kept whole (4000 UTF-16 units)", () => {
    const s = "é".repeat(TURN_MESSAGE_MAX);
    const m = shownMessage(raw(s));
    expect(m.text).toBe(s);
    expect(m.truncated).toBeUndefined();
  });

  test("2001 combining-mark characters are cut between characters, never leaving a mark on its own", () => {
    const m = shownMessage(raw("é".repeat(TURN_MESSAGE_MAX + 1)));
    expect(m.truncated).toBe(true);
    expect(g(m.text)).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
    expect(m.text.endsWith(" …")).toBe(true);
    const body = m.text.slice(0, -2);
    expect(graphemes(body).every((ch) => ch === "é")).toBe(true);
    expect(TurnMessage.safeParse(m).success).toBe(true);
  });

  test("a family emoji (ZWJ sequence) at the cut stays whole", () => {
    const fam = "👨‍👩‍👧‍👦";
    const m = shownMessage(raw(fam.repeat(TURN_MESSAGE_MAX + 5)));
    expect(m.truncated).toBe(true);
    const body = m.text.slice(0, -2);
    expect(graphemes(body).every((ch) => ch === fam)).toBe(true);
    expect(loneSurrogate.test(m.text)).toBe(false);
    expect(TurnMessage.safeParse(m).success).toBe(true);
  });

  test("flags (regional-indicator pairs) at the cut are never halved", () => {
    const m = shownMessage(raw("🇰🇿".repeat(TURN_MESSAGE_MAX + 1)));
    const body = m.text.slice(0, -2);
    expect(graphemes(body).every((ch) => ch === "🇰🇿")).toBe(true);
    expect(g(m.text)).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  });

  test("exactly 2000 plain characters with spaces is not cut; 2001 is, within 2000 with ' …'", () => {
    const words = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);
    const at = words(TURN_MESSAGE_MAX).replace(/ $/, "x");
    expect(at.length).toBe(TURN_MESSAGE_MAX);
    expect(shownMessage(raw(at)).truncated).toBeUndefined();
    const over = `${at}y`;
    const m = shownMessage(raw(over));
    expect(m.truncated).toBe(true);
    expect(g(m.text)).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
    expect(m.text.endsWith("word …")).toBe(true);
  });

  test("one word with no spaces at all is still cut within the limit", () => {
    const m = shownMessage(raw("a".repeat(5000)));
    expect(m.truncated).toBe(true);
    expect(g(m.text)).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
    expect(m.text.endsWith(" …")).toBe(true);
  });

  test("a secret spanning the 2000 cut leaves no part of it", () => {
    const key = `sk-ant-api03-${"A".repeat(80)}`;
    const s = `${"x ".repeat(995)}${key} and more words after it ${"y ".repeat(200)}`;
    const m = shownMessage(raw(s));
    expect(m.text).not.toContain("sk-ant");
    expect(m.text).not.toContain("AAAAAAAA");
  });

  test("a secret inside a code fence is redacted", () => {
    const m = shownMessage(
      raw("Set it:\n\n```sh\nexport GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n```"),
    );
    expect(m.text).not.toContain("ghp_abcdef");
    expect(m.text).toContain("[redacted:");
  });

  test("a long code block after an intro: the intro is kept, never half the block", () => {
    const code = `\`\`\`ts\n${"const a = 1;\n".repeat(300)}\`\`\``;
    const m = shownMessage(raw(`Here is the change.\n\n${code}`));
    expect(m.truncated).toBe(true);
    expect(m.text).toBe("Here is the change. …");
  });

  test("a long code block alone is cut with its fence closed", () => {
    const m = shownMessage(raw(`\`\`\`ts\n${"const a = 1;\n".repeat(300)}\`\`\``));
    expect(m.truncated).toBe(true);
    expect((m.text.match(/```/g) ?? []).length % 2).toBe(0);
    expect(m.text.endsWith("``` …")).toBe(true);
    expect(g(m.text)).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  });

  test("right-to-left text, tabs and single line breaks are kept as written", () => {
    const s = "مرحبا بالعالم\n\tשלום עולם\nline";
    expect(shownMessage(raw(s)).text).toBe(s);
  });

  test("every cut message passes the protocol schema", () => {
    const inputs = [
      "😀".repeat(2100),
      "é".repeat(2100),
      `${"para ".repeat(300)}\n\n${"para ".repeat(300)}`,
      `\`\`\`\n${"x".repeat(4000)}`,
      "á̂̃".repeat(2100),
    ];
    for (const s of inputs) expect(TurnMessage.safeParse(shownMessage(raw(s))).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// The live reader
// ---------------------------------------------------------------------------------------------------

describe("the live reader", () => {
  test("a UTF-8 character split across two reads arrives whole", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    const line = Buffer.from(`${JSON.stringify(text("m1", "Готово 😀 done"))}\n`, "utf8");
    const emoji = line.indexOf(Buffer.from("😀", "utf8"));
    appendFileSync(path, line.subarray(0, emoji + 2)); // half the emoji's bytes
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual([]);
    appendFileSync(path, line.subarray(emoji + 2));
    await t.hook("PostToolUse", tool("a"));
    expect(t.sent()).toEqual(["Готово 😀 done"]);
  });

  test("a complete entry without its newline waits, then is sent once", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    appendFileSync(path, JSON.stringify(text("m1", "One.")));
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()).toEqual([]);
    appendFileSync(path, "\n");
    await t.hook("PostToolUse", tool("a"));
    await t.hook("PostToolUse", tool("b"));
    expect(t.sent()).toEqual(["One."]);
  });

  test("a transcript that doesn't exist yet at the turn start is read from its beginning once it appears", async () => {
    const t = setup();
    const path = join(tempDir(), "later.jsonl");
    await t.hook("UserPromptSubmit", { prompt: "First prompt", transcript_path: path });
    await t.hook("PreToolUse", tool("a"));
    writeFileSync(path, jsonl([userPrompt("First prompt", Date.now() + 1), text("m1", "Starting.")]));
    await t.hook("PostToolUse", tool("a"));
    expect(t.sent()).toEqual(["Starting."]);
  });

  test("a transcript replaced by a shorter file (rename over it) is read again without repeats", async () => {
    const t = setup();
    const dir = tempDir();
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      jsonl([userPrompt("x", Date.now() - 5000), text("old", "Old turn.", Date.now() - 4000)]),
    );
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("m1", "One."), toolUse("a"), toolUse("b"), toolUse("c"));
    await t.hook("PreToolUse", tool("a"));
    const next = join(dir, "next.jsonl");
    writeFileSync(next, jsonl([text("m1", "One."), text("m2", "Two.")]));
    renameSync(next, path);
    await t.hook("PreToolUse", tool("b"));
    expect(t.sent()).toEqual(["One.", "Two."]);
  });

  test("a very large append (megabytes of tool output) is read in one go, in order, capped at 50", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    const big = "z".repeat(100_000);
    const lines: object[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(text(`m${i}`, `Message ${i}`));
      lines.push({
        type: "user",
        uuid: `r${i}`,
        timestamp: iso(Date.now() + 5),
        message: { content: [{ type: "tool_result", tool_use_id: `a${i}`, content: big }] },
      });
    }
    append(path, ...lines);
    await t.hook("PostToolUse", tool("a"));
    expect(t.sent()).toEqual(Array.from({ length: 50 }, (_, i) => `Message ${i}`));
    expect((await t.live())?.messages).toHaveLength(50);
    for (const e of t.msgEvents()) expect(RelayEventSchema.safeParse(e).success).toBe(true);
  });

  test("two sessions at once: each gets only its own transcript's messages", async () => {
    const t = setup();
    const a = tempFile();
    const b = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "A", transcript_path: a }, "sa");
    await t.hook("UserPromptSubmit", { prompt: "B", transcript_path: b }, "sb");
    const [ta, tb] = t.seen.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
    append(a, text("a1", "From A."));
    append(b, text("b1", "From B."));
    await t.hook("PreToolUse", tool("x"), "sa");
    expect(t.msgEvents().map((e) => [e.sessionId, e.turnId, e.message.text])).toEqual([
      ["sa", ta as string, "From A."],
    ]);
    await t.hook("PreToolUse", tool("y"), "sb");
    expect(t.msgEvents().map((e) => [e.sessionId, e.turnId, e.message.text])).toEqual([
      ["sa", ta as string, "From A."],
      ["sb", tb as string, "From B."],
    ]);
    expect((await t.live("sa"))?.messages?.map((m) => m.id)).toEqual(["a1"]);
    expect((await t.live("sb"))?.messages?.map((m) => m.id)).toEqual(["b1"]);
  });

  test("a tool hook that arrives after Stop sends nothing more", async () => {
    const t = setup();
    const path = tempFile([userPrompt("x", Date.now() - 1)]);
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("ans", "Done."));
    await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
    append(path, text("late", "Late."));
    await t.hook("PostToolUse", tool("z"));
    expect(t.sent()).not.toContain("Late.");
    expect(t.rows()).toBe(0);
  });

  test("a second prompt without a Stop moves following to the new turn, and the old turn's rows go", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "one", transcript_path: path });
    const first = t.turnId();
    append(path, text("m1", "First."));
    await t.hook("PreToolUse", tool("a"));
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    await t.hook("UserPromptSubmit", { prompt: "two", transcript_path: path });
    const second = t.turnId();
    expect(t.rows(first)).toBe(0);
    append(path, text("m2", "Second."));
    await t.hook("PreToolUse", tool("b"));
    expect(t.msgEvents().map((e) => [e.turnId, e.message.id])).toEqual([
      [first, "m1"],
      [second, "m2"],
    ]);
    expect((await t.live())?.messages?.map((m) => m.id)).toEqual(["m2"]);
  });

  test("the one-second read: no timer is left running after Stop, SessionEnd, idle or ended", async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const active = new Set<unknown>();
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      active.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: unknown) => {
      active.delete(id);
      realClear(id as Parameters<typeof clearInterval>[0]);
    }) as typeof clearInterval;
    try {
      const t = setup({ pollMs: 20 });
      const path = tempFile([userPrompt("x", Date.now() - 1)]);
      const base = active.size;
      // Stop
      await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path }, "s1");
      // SessionEnd
      await t.hook("UserPromptSubmit", { prompt: "y", transcript_path: path }, "s2");
      // idle upsert
      await t.hook("UserPromptSubmit", { prompt: "z", transcript_path: path }, "s3");
      // ended upsert
      await t.hook("UserPromptSubmit", { prompt: "w", transcript_path: path }, "s4");
      // twice in a row: still one timer for the session
      await t.hook("UserPromptSubmit", { prompt: "v", transcript_path: path }, "s5");
      await t.hook("UserPromptSubmit", { prompt: "v2", transcript_path: path }, "s5");
      expect(active.size - base).toBe(5);
      await t.hook("Stop", { last_assistant_message: "", transcript_path: path }, "s1");
      await t.hook("SessionEnd", {}, "s2");
      t.registry.setStatus("s3", "idle");
      t.registry.setStatus("s4", "ended");
      t.messages.clear("s5");
      expect(active.size - base).toBe(0);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  test("the one-second read sends a message with no hook, and stops once the session goes idle", async () => {
    const t = setup({ pollMs: 20 });
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("m1", "One."));
    await Bun.sleep(80);
    expect(t.sent()).toEqual(["One."]);
    t.registry.setStatus("s1", "idle");
    append(path, text("m2", "Two."));
    await Bun.sleep(80);
    expect(t.sent()).toEqual(["One."]);
  });

  test("many sessions at once each read on their own timer", async () => {
    const t = setup({ pollMs: 20 });
    const paths = Array.from({ length: 12 }, () => tempFile());
    for (const [i, p] of paths.entries())
      await t.hook("UserPromptSubmit", { prompt: `p${i}`, transcript_path: p }, `s${i}`);
    for (const [i, p] of paths.entries()) append(p, text(`m${i}`, `From ${i}.`));
    await Bun.sleep(120);
    const got = new Map(t.msgEvents().map((e) => [e.sessionId, e.message.text]));
    for (let i = 0; i < 12; i++) expect(got.get(`s${i}`)).toBe(`From ${i}.`);
    expect(t.msgEvents()).toHaveLength(12);
    for (let i = 0; i < 12; i++) await t.hook("SessionEnd", {}, `s${i}`);
  });
});

// ---------------------------------------------------------------------------------------------------
// The end of the turn
// ---------------------------------------------------------------------------------------------------

const many = (n: number, start = Date.now() + 5) =>
  Array.from({ length: n }, (_, i) => text(`m${i}`, `Message ${i}`, start + i));

describe("the end of the turn", () => {
  test("the answer is left out when it differs only by surrounding whitespace", () => {
    const f = finishedMessages([raw("Looking."), { id: "a", raw: "\n  Done.\n", at: 2 }], "Done.\n");
    expect(f.messages.map((m) => m.id)).toEqual(["m"]);
  });

  test("an answer over 2000 characters is compared before the cut and left out", () => {
    const long = "word ".repeat(1000).trim();
    const f = finishedMessages([raw("First."), { id: "a", raw: long, at: 2 }], long);
    expect(f.messages.map((m) => m.id)).toEqual(["m"]);
  });

  test("only the last message is compared: an earlier one with the answer's text stays", () => {
    const f = finishedMessages(
      [
        { id: "a", raw: "Done.", at: 1 },
        { id: "b", raw: "Something else.", at: 2 },
      ],
      "Done.",
    );
    expect(f.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("a turn whose only text is the answer has no messages field and stores NULL", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), text("ans", "Just the answer."));
    await t.hook("Stop", { last_assistant_message: "Just the answer.", transcript_path: path });
    expect("messages" in t.done()).toBe(false);
    expect("messagesMore" in t.done()).toBe(false);
    expect(
      (t.db.query("SELECT messages_json FROM turns").get() as { messages_json: string | null }).messages_json,
    ).toBeNull();
  });

  test("51 texts with the answer last: 50 messages and no messagesMore", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), ...many(50), text("ans", "Final.", Date.now() + 100));
    await t.hook("Stop", { last_assistant_message: "Final.", transcript_path: path });
    expect(t.done().messages).toHaveLength(50);
    expect(t.done().messagesMore).toBeUndefined();
    expect(TurnSchema.safeParse(t.done()).success).toBe(true);
  });

  test("52 texts with the answer last: 50 messages and 1 more", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), ...many(51), text("ans", "Final.", Date.now() + 100));
    await t.hook("Stop", { last_assistant_message: "Final.", transcript_path: path });
    expect(t.done().messages?.map((m) => m.id)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    expect(t.done().messagesMore).toBe(1);
  });

  test("Stop without last_assistant_message leaves nothing out", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), text("m1", "One."), text("m2", "Two."));
    await t.hook("Stop", { transcript_path: path });
    expect(t.done().messages?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("StopFailure compares with last_assistant_message; the API error entry is no message", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(
      path,
      userPrompt("x", Date.now() + 1),
      text("m1", "Looking at it."),
      toolUse("a"),
      text("m2", "Halfway."),
      text("err", "API Error: 529 overloaded", Date.now() + 10, { isApiErrorMessage: true }),
    );
    await t.hook("StopFailure", {
      last_assistant_message: "Halfway.",
      error: "overloaded",
      transcript_path: path,
    });
    expect(t.done().failed).toBe(true);
    expect(t.done().messages?.map((m) => m.id)).toEqual(["m1"]);
  });

  test("the finished turn's messages are redacted, as stored and as sent", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(
      path,
      userPrompt("x", Date.now() + 1),
      text("m1", "Using AKIAABCDEFGHIJKLMNOP now."),
      text("ans", "Done."),
    );
    await t.hook("PreToolUse", tool("a"));
    expect(t.sent()[0]).not.toContain("AKIAABCDEFGHIJKLMNOP");
    await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
    expect(t.done().messages?.[0]?.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    const stored = (t.db.query("SELECT messages_json FROM turns").get() as { messages_json: string })
      .messages_json;
    expect(stored).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  test("the live id and the finished turn's id are the same for each message", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), text("m1", "One."), toolUse("a"), text("m2", "Two."));
    await t.hook("PostToolUse", tool("a"));
    append(path, text("ans", "Done."));
    await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
    expect(t.done().messages).toEqual(
      t
        .msgEvents()
        .slice(0, 2)
        .map((e) => e.message),
    );
  });

  test("Stop deletes only that turn's rows; another session's running turn keeps its rows in sync", async () => {
    const t = setup();
    const a = tempFile();
    const b = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "A", transcript_path: a }, "sa");
    await t.hook("UserPromptSubmit", { prompt: "B", transcript_path: b }, "sb");
    append(a, userPrompt("A", Date.now() + 1), text("a1", "A one."), text("aa", "A done."));
    append(b, userPrompt("B", Date.now() + 1), text("b1", "B one."));
    await t.hook("PreToolUse", tool("x"), "sa");
    await t.hook("PreToolUse", tool("y"), "sb");
    expect(t.rows()).toBe(3);
    await t.hook("Stop", { last_assistant_message: "A done.", transcript_path: a }, "sa");
    const res = await t.rpc("sync", { sinceSeq: 1 }, "device:x");
    const replay = ("result" in res ? (res.result as { events: RelayEvent[] }).events : []).filter(
      (e) => e.type === "turn.message",
    ) as Extract<RelayEvent, { type: "turn.message" }>[];
    expect(replay.map((e) => e.message.id)).toEqual(["b1"]);
  });

  test("the messages survive a restart: session.turns reads them from the database", async () => {
    const dbPath = join(tempDir(), "relay.db");
    const path = tempFile();
    {
      const t = setup({ dbPath });
      await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
      append(path, userPrompt("x", Date.now() + 1), text("m1", "One."), text("ans", "Done."));
      await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
      t.db.close();
    }
    resetLiveMessages();
    const t2 = setup({ dbPath });
    const res = await t2.rpc("session.turns", { sessionId: "s1", limit: 1 }, "device:x");
    const turns = "result" in res ? (res.result as Turn[]) : [];
    expect(turns[0]?.messages?.map((m) => [m.id, m.text])).toEqual([["m1", "One."]]);
    expect(turns[0]?.summary).toBe("Done.");
  });

  test("stored values of the wrong shape read as no messages, or only the valid ones", () => {
    expect(parseMessagesJson("null")).toEqual({});
    expect(parseMessagesJson("[1,2]")).toEqual({});
    expect(parseMessagesJson('"text"')).toEqual({});
    expect(parseMessagesJson('{"messages":"x"}')).toEqual({});
    expect(parseMessagesJson('{"messagesMore":"3"}')).toEqual({});
    expect(parseMessagesJson('{"messagesMore":-2}')).toEqual({});
    expect(
      parseMessagesJson('{"messages":[null,{"id":1,"text":"a","at":1},{"id":"ok","text":"b","at":2}]}'),
    ).toEqual({
      messages: [{ id: "ok", text: "b", at: 2 }],
    });
  });

  test("session.turns doesn't fail on a turn with corrupt messages_json", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), text("m1", "One."), text("ans", "Done."));
    await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
    t.db.query("UPDATE turns SET messages_json = '{\"messages\": [' ").run();
    const res = await t.rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x");
    expect("result" in res).toBe(true);
    const turns = (res as { result: Turn[] }).result;
    expect(turns[0]?.summary).toBe("Done.");
    expect(turns[0]?.messages).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// session.live
// ---------------------------------------------------------------------------------------------------

describe("session.live", () => {
  test("after Stop there is no live turn, so no messages", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, userPrompt("x", Date.now() + 1), text("m1", "One."));
    await t.hook("PreToolUse", tool("a"));
    expect((await t.live())?.messages).toHaveLength(1);
    await t.hook("Stop", { last_assistant_message: "One.", transcript_path: path });
    expect(await t.live()).toBeNull();
  });

  test("after SessionEnd, session.live has no messages", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
    append(path, text("m1", "One."));
    await t.hook("PreToolUse", tool("a"));
    await t.hook("SessionEnd", {});
    const live = await t.live();
    expect(live?.messages ?? []).toEqual([]);
  });

  test("a new turn starts with no messages from the old one", async () => {
    const t = setup();
    const path = tempFile();
    await t.hook("UserPromptSubmit", { prompt: "one", transcript_path: path });
    append(path, text("m1", "One."));
    await t.hook("PreToolUse", tool("a"));
    await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
    await t.hook("UserPromptSubmit", { prompt: "two", transcript_path: path });
    const live = await t.live();
    expect(live?.turnId).toBe(t.turnId());
    expect(live?.messages).toBeUndefined();
  });

  test("an unknown session is null, not an error", async () => {
    const t = setup();
    expect(await t.live("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------

describe("history", () => {
  const opts = { limit: 10, previewChars: 600, working: false };

  test("subagent text, API errors and synthetic entries aren't messages; the answer isn't repeated", () => {
    const path = tempFile([
      userPrompt("Fix it", 1000),
      text("m1", "Looking.", 2000),
      text("sub", "Subagent says hi.", 2100, { isSidechain: true }),
      text("err", "API Error: 500", 2200, { isApiErrorMessage: true }),
      {
        ...text("syn", "No response requested.", 2300),
        message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
      },
      text("m2", "Halfway.", 2400),
      text("ans", "Fixed.", 3000),
    ]);
    const [turn] = transcriptTurns("s1", path, opts);
    expect(turn?.summary).toBe("Fixed.");
    expect(turn?.messages?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("a stopped turn's last text is its answer, not a message", () => {
    const path = tempFile([
      userPrompt("Go", 1000),
      text("m1", "Starting.", 2000),
      text("m2", "Still going.", 3000),
      {
        type: "user",
        timestamp: iso(4000),
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      },
    ]);
    const [turn] = transcriptTurns("s1", path, opts);
    expect(turn?.stopped).toBe(true);
    expect(turn?.summary).toBe("Still going.");
    expect(turn?.messages?.map((m) => m.id)).toEqual(["m1"]);
  });

  test("55 texts in a turn: 50 messages, 4 more, the last is the answer", () => {
    const path = tempFile([userPrompt("Go", 1000), ...many(55, 2000)]);
    const [turn] = transcriptTurns("s1", path, opts);
    expect(turn?.summary).toBe("Message 54");
    expect(turn?.messages).toHaveLength(50);
    expect(turn?.messagesMore).toBe(4);
    expect(TurnSchema.safeParse(turn).success).toBe(true);
  });

  test("a turn with only its answer has no messages field; a secret in a message is redacted", () => {
    const path = tempFile([
      userPrompt("A", 1000),
      text("a", "Only answer.", 2000),
      userPrompt("B", 3000),
      text("b1", "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 set", 4000),
      text("b2", "Done.", 5000),
    ]);
    const [b, a] = transcriptTurns("s1", path, opts);
    expect(a && "messages" in a).toBe(false);
    expect(b?.messages?.[0]?.text).not.toContain("ghp_abcdef");
  });
});

// ---------------------------------------------------------------------------------------------------
// Never pushed; relay tail
// ---------------------------------------------------------------------------------------------------

describe("never pushed, and relay tail", () => {
  const ev = (t: string): RelayEvent =>
    ({
      seq: 9,
      ts: 1,
      type: "turn.message",
      sessionId: "abcdef1234",
      turnId: "t1",
      message: { id: "m", text: t, at: 1 },
    }) as RelayEvent;

  test("no alert for a message, whatever it says", () => {
    for (const t of ["Allow Bash?", "Done! ✅", "Question: which one?", "x".repeat(2000)])
      expect(alertFor(ev(t), () => "proj")).toBeNull();
  });

  test("relay tail: one line, the first non-blank line, for a multi-line Markdown message", () => {
    const line = formatEvent(ev("## Plan\n\n- one\n- two"));
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("abcdef12");
    expect(line).toContain("## Plan");
  });
});

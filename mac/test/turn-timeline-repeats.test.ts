// Turn timeline: rows after a helper restart, odd tool names and ids, the same tool call or hook twice, entries
// without a timestamp, and thinking blocks that share an entry or a time.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayEvent, type Turn, TurnStep } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { TimelineReader } from "../src/daemon/timeline.ts";

const CWD = "/Users/me/Projects/my-app";
const iso = (ms: number) => new Date(ms).toISOString();
const userPrompt = (t: string, at: number) => ({
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
const use = (id: string, name: unknown, input: object, at: number, uuid = `a-${id}`) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const text = (uuid: string, t: string, at: number) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { model: "m", content: [{ type: "text", text: t }] },
});
const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "relay-tl-repeat-"));
  dirs.push(d);
  return d;
}
function setup(dbPath: string, path: string) {
  const db = openDb(dbPath);
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: 0 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages });
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
  const rows = (turnId: string) =>
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE type = 'turn.action' AND json_extract(data_json, '$.turnId') = ?",
        )
        .get(turnId) as { n: number }
    ).n;
  const turnIds = () => seen.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
  const dones = () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : [])) as Turn[];
  const actions = () => seen.flatMap((e) => (e.type === "turn.action" ? [e] : []));
  return { db, hook, rows, turnIds, dones, actions };
}

test("after a helper restart mid-turn, Stop still deletes the turn's turn.action rows", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "relay.db");
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  const a = setup(dbPath, path);
  await a.hook("UserPromptSubmit", { prompt: "x" });
  const turnId = a.turnIds()[0] as string;
  appendFileSync(path, `${JSON.stringify(use("a", "Bash", { command: "make" }, Date.now() + 5))}\n`);
  await a.hook("PreToolUse", { tool_use_id: "a", tool_name: "Bash", tool_input: { command: "make" } });
  expect(a.rows(turnId)).toBe(1);
  a.db.close();
  resetLiveMessages();
  const b = setup(dbPath, path);
  appendFileSync(path, `${JSON.stringify(text("ans", "Done.", Date.now() + 10))}\n`);
  await b.hook("Stop", { last_assistant_message: "Done." });
  expect(b.dones()[0]?.id).toBe(turnId);
  expect(b.rows(turnId)).toBe(0);
});

test("a tool name or id that isn't a string still gives a step the protocol accepts", () => {
  const r = new TimelineReader(CWD, 0);
  const out = [
    ...r.add(use("x", 42, {}, 10)),
    ...r.add({
      type: "assistant",
      uuid: "n",
      timestamp: iso(20),
      message: { content: [{ type: "tool_use", id: 7, name: "Bash", input: {} }] },
    } as never),
  ];
  expect(out).toHaveLength(2);
  for (const s of out) expect(TurnStep.safeParse(s).success).toBe(true);
});

test("the same tool_use written twice: the finished list and toolCalls still agree", async () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  const t = setup(":memory:", path);
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const s = Date.now() + 5;
  appendFileSync(
    path,
    [
      userPrompt("x", s),
      use("a", "Bash", { command: "make" }, s + 1),
      use("a", "Bash", { command: "make" }, s + 1, "a-dup"),
      text("ans", "Done.", s + 2),
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(""),
  );
  await t.hook("Stop", { last_assistant_message: "Done." });
  const done = t.dones()[0] as Turn;
  expect((done.steps?.length ?? 0) + (done.stepsMore ?? 0)).toBe(done.stats.toolCalls);
});

test("a PostToolUse hook delivered twice gives one hook-only step per id", async () => {
  const t = setup(":memory:", "/nonexistent.jsonl");
  const call = {
    tool_use_id: "h1",
    tool_name: "Bash",
    tool_input: { command: "make" },
    transcript_path: "/nonexistent.jsonl",
  };
  await t.hook("UserPromptSubmit", { prompt: "x", transcript_path: "/nonexistent.jsonl" });
  await t.hook("PreToolUse", call);
  await t.hook("PostToolUse", call);
  await t.hook("PostToolUse", call);
  await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: "/nonexistent.jsonl" });
  expect(t.dones()[0]?.steps?.map((s) => s.id)).toEqual(["h1"]);
});

test("an entry without a timestamp in a finished turn isn't placed at 1970 (before the prompt)", async () => {
  const dir = tempDir();
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  const t = setup(":memory:", path);
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const s = Date.now() + 5;
  const noTs = {
    type: "assistant",
    uuid: "nots",
    message: { content: [{ type: "tool_use", id: "n", name: "Bash", input: { command: "make" } }] },
  };
  appendFileSync(
    path,
    [userPrompt("x", s), use("a", "Bash", { command: "ls" }, s + 1), noTs, text("ans", "Done.", s + 3)]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(""),
  );
  await t.hook("Stop", { last_assistant_message: "Done." });
  const done = t.dones()[0] as Turn;
  const n = done.steps?.find((x) => x.id === "n");
  expect(n).toBeDefined();
  expect(n?.at ?? 0).toBeGreaterThanOrEqual(done.startedAt ?? 0);
});

test("two thinking blocks in one entry don't both claim the whole gap", () => {
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
  const total = out.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  expect(total).toBeLessThanOrEqual(10_000 + 1000);
});

test("two thinking entries without uuid at the same time are two lines", () => {
  const r = new TimelineReader(CWD, 0);
  const e = {
    type: "assistant",
    timestamp: iso(5000),
    message: { content: [{ type: "thinking", thinking: "" }] },
  };
  r.add(e);
  r.add({ ...e });
  expect(r.thoughts).toHaveLength(2);
});

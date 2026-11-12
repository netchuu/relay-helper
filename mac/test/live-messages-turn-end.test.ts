// Live messages around a turn's end: a prompt queued during Stop, entries from before the turn, a helper restart
// mid-turn, `relay tail` with emoji, and ~~~ fences left open at the cut.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Turn } from "../../protocol/index.ts";
import { graphemes, TURN_MESSAGE_MAX } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages, shownMessage } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { formatEvent } from "../src/tailFormat.ts";

const CWD = "/Users/me/Projects/my-app";
const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-messages-cand-"));
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
const text = (uuid: string, t: string, at = Date.now() + 5) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] },
});
const userPrompt = (t: string, at = Date.now()) => ({
  type: "user",
  uuid: `u-${t}`,
  timestamp: iso(at),
  message: { content: t },
});
const tool = (id: string) => ({ tool_use_id: id, tool_name: "Bash", tool_input: { command: "ls" } });

function setup(dbPath = ":memory:") {
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
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  const msgs = () =>
    seen.filter((e): e is Extract<RelayEvent, { type: "turn.message" }> => e.type === "turn.message");
  const turnIds = () => seen.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
  const dones = () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : [])) as Turn[];
  const rows = (turnId: string) =>
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE type = 'turn.message' AND json_extract(data_json, '$.turnId') = ?",
        )
        .get(turnId) as { n: number }
    ).n;
  return { db, hook, msgs, turnIds, dones, rows };
}

test("a prompt queued at the computer, submitted right after Stop, keeps its live messages", async () => {
  const t = setup();
  const path = tempFile();
  await t.hook("UserPromptSubmit", { prompt: "First", transcript_path: path });
  append(
    path,
    userPrompt("First", Date.now() + 1),
    text("m1", "Turn one, working."),
    text("a1", "Turn one done."),
  );
  // Stop is an async hook: Claude Code doesn't wait for it, so the queued prompt's UserPromptSubmit can
  // arrive while the helper is still in Stop's 400 ms wait.
  const stop = t.hook("Stop", { last_assistant_message: "Turn one done.", transcript_path: path });
  await Bun.sleep(50);
  append(path, userPrompt("Second", Date.now() + 1));
  await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
  await stop;
  const [first, second] = t.turnIds() as [string, string];
  append(path, text("n1", "Turn two, first message."));
  await t.hook("PreToolUse", tool("x"));
  // Turn two is still followed live.
  expect(t.msgs().map((e) => [e.turnId, e.message.id])).toContainEqual([second, "n1"]);
  // And turn one, not turn two, is the one that finished, with its own message.
  expect(t.dones().map((d) => d.id)).toEqual([first]);
  expect(t.dones()[0]?.messages?.map((m) => m.id)).toEqual(["m1"]);
  expect(t.dones()[0]?.prompt).toBe("First");
  expect(t.dones()[0]?.summary).toBe("Turn one done.");
  // Turn two is still running: the session stays working, and its own Stop finishes it later.
  expect((t.db.query("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string }).status).toBe(
    "working",
  );
  append(path, text("a2", "Turn two done."));
  await t.hook("Stop", { last_assistant_message: "Turn two done.", transcript_path: path });
  expect(t.dones().map((d) => [d.id, d.prompt, d.summary])).toEqual([
    [first, "First", "Turn one done."],
    [second, "Second", "Turn two done."],
  ]);
  expect(t.dones()[1]?.messages?.map((m) => m.id)).toEqual(["n1"]);
});

test("the finished turn leaves out entries from before the turn started (Stop)", async () => {
  const t = setup();
  const before = Date.now() - 500;
  const path = tempFile([userPrompt("First", before - 1000)]);
  await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
  append(
    path,
    userPrompt("Second", Date.now() + 1),
    text("late", "First turn's late text.", before),
    text("m1", "Second turn."),
    text("ans", "Answer two."),
  );
  await t.hook("Stop", { last_assistant_message: "Answer two.", transcript_path: path });
  expect(
    t
      .dones()
      .at(-1)
      ?.messages?.map((m) => m.id),
  ).toEqual(["m1"]);
});

test("after a helper restart mid-turn, Stop still deletes the turn's turn.message rows", async () => {
  const dbPath = join(tempDir(), "relay.db");
  const path = tempFile();
  const a = setup(dbPath);
  await a.hook("UserPromptSubmit", { prompt: "x", transcript_path: path });
  const turnId = a.turnIds()[0] as string;
  append(path, userPrompt("x", Date.now() + 1), text("m1", "One."));
  await a.hook("PreToolUse", tool("a"));
  expect(a.rows(turnId)).toBe(1);
  a.db.close();
  resetLiveMessages();
  // The helper restarts (brew upgrade, crash); Claude carries on and the turn ends.
  const b = setup(dbPath);
  append(path, text("ans", "Done."));
  await b.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
  expect(b.dones()[0]?.id).toBe(turnId);
  expect(b.rows(turnId)).toBe(0);
});

test("relay tail never cuts an emoji in half", () => {
  const e = {
    seq: 1,
    ts: 1,
    type: "turn.message",
    sessionId: "abcdef1234",
    turnId: "t1",
    message: { id: "m", text: `${"a".repeat(99)}😀 and more`, at: 1 },
  } as RelayEvent;
  const line = formatEvent(e);
  expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(line)).toBe(false);
});

test("a ~~~ fence open at the cut is closed", () => {
  const m = shownMessage({ id: "m", raw: `~~~ts\n${"const a = 1;\n".repeat(300)}~~~`, at: 1 });
  expect(m.truncated).toBe(true);
  expect(graphemes(m.text).length).toBeLessThanOrEqual(TURN_MESSAGE_MAX);
  expect((m.text.match(/^~~~/gm) ?? []).length % 2).toBe(0);
});

test("the answer's preview closes a ~~~ fence too, and a ``` inside ~~~ doesn't close it", async () => {
  const { compact } = await import("../src/daemon/render.ts");
  const preview = compact(`~~~md\n${"```\nline\n".repeat(200)}~~~`, 300);
  expect(preview.truncated).toBe(true);
  expect((preview.text.match(/^~~~/gm) ?? []).length % 2).toBe(0);
  expect(compact(`\`\`\`ts\n${"const a = 1;\n".repeat(100)}\`\`\``, 200).text).toMatch(/\n```$|``` …$/);
});

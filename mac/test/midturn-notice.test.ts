import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Turn } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";

// A background task that finishes while Claude is still answering a prompt: Claude Code's notice arrives as a
// UserPromptSubmit mid-turn. Taken as a new turn, the prompt would show no answer and the answer would sit on a turn
// without a prompt; it stays part of the running turn instead.

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOTE = "<task-notification> <task-id>b1</task-id> <status>completed</status> </task-notification>";
const iso = (ms: number) => new Date(ms).toISOString();
const line = (o: object) => `${JSON.stringify(o)}\n`;
const user = (text: string, at: number) => ({
  type: "user",
  uuid: `u-${at}`,
  timestamp: iso(at),
  message: { content: text },
});
const say = (uuid: string, text: string, at: number) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { content: [{ type: "text", text }] },
});
const use = (id: string, at: number) => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: `step ${id}` } }] },
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-midturn-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    messages: new MessageTracker(events, { pollMs: 0 }),
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: "s1", cwd: "/x", transcript_path: path, ...fields },
        env: {},
      },
      new AbortController().signal,
    );
  const started = () => seen.flatMap((e) => (e.type === "turn.started" ? [e] : []));
  const dones = () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : [])) as Turn[];
  return { path, hook, started, dones, registry };
}

test("a notice taken in mid-turn stays part of that turn: one turn, its prompt, its answer and all its steps", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "yes" });
  const s = Date.now();
  appendFileSync(
    t.path,
    line(user("yes", s + 1)) + line(say("m1", "Fixing it.", s + 5)) + line(use("a", s + 6)),
  );
  await t.hook("PreToolUse", { tool_use_id: "a", tool_name: "Bash", tool_input: { command: "step a" } });
  // The background task finishes while Claude is still working.
  appendFileSync(t.path, line(user(NOTE, s + 10)));
  await t.hook("UserPromptSubmit", { prompt: NOTE });
  appendFileSync(t.path, line(use("b", s + 20)) + line(say("ans", "Build 16 is out.", s + 30)));
  await Bun.sleep(2100); // well past the race window: this notice was taken in mid-turn
  await t.hook("Stop", { last_assistant_message: "Build 16 is out." });
  expect(t.started().map((e) => e.prompt)).toEqual(["yes"]);
  expect(t.dones().map((d) => [d.prompt, d.summary])).toEqual([["yes", "Build 16 is out."]]);
  expect(t.dones()[0]?.steps?.map((x) => x.id)).toEqual(["a", "b"]);
  expect(t.dones()[0]?.messages?.map((m) => m.id)).toEqual(["m1"]);
  expect(t.registry.get("s1")?.status).toBe("idle");
});

test("a notice just before the turn's Stop was the next turn: the old turn keeps its answer, then a turn starts", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Start the build" });
  const s = Date.now();
  appendFileSync(t.path, line(user("Start the build", s + 1)) + line(say("a1", "Build started.", s + 5)));
  appendFileSync(t.path, line(user(NOTE, s + 10)));
  await t.hook("UserPromptSubmit", { prompt: NOTE });
  await t.hook("Stop", { last_assistant_message: "Build started." });
  expect(t.dones().map((d) => [d.prompt, d.summary])).toEqual([["Start the build", "Build started."]]);
  expect(t.started().map((e) => e.prompt)).toEqual(["Start the build", ""]);
  expect(t.registry.get("s1")?.status).toBe("working");
  appendFileSync(t.path, line(say("n1", "The build passed.", Date.now() + 5)));
  await t.hook("Stop", { last_assistant_message: "The build passed." });
  expect(t.dones().map((d) => [d.prompt, d.summary])).toEqual([
    ["Start the build", "Build started."],
    ["", "The build passed."],
  ]);
  expect(t.registry.get("s1")?.status).toBe("idle");
});

test("a notice when no turn is running starts its own turn", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: NOTE });
  expect(t.started().map((e) => e.prompt)).toEqual([""]);
  expect(t.registry.get("s1")?.status).toBe("working");
});

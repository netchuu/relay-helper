import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

const CWD = "/Users/me/Projects/my-app";
const SID = "0b8c2f4e-5a6d-4c1e-9f3a-7d2e1b4c6a80";

let home: string;
let oldHome: string | undefined;
let transcript: string;

beforeEach(() => {
  oldHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "relay-resume-home-"));
  process.env.HOME = home;
  const dir = join(home, ".claude", "projects", CWD.replace(/[^A-Za-z0-9-]/g, "-"));
  mkdirSync(dir, { recursive: true });
  transcript = join(dir, `${SID}.jsonl`);
  writeFileSync(transcript, "");
});

afterEach(() => {
  process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
  resetLiveMessages();
  resetLiveSteps();
});

const line = (o: object) => `${JSON.stringify(o)}\n`;
const text = (uuid: string, t: string, at: number) =>
  line({
    type: "assistant",
    uuid,
    timestamp: new Date(at).toISOString(),
    message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] },
  });
const tool = (id: string, at: number) =>
  line({
    type: "assistant",
    uuid: `tu-${id}`,
    timestamp: new Date(at).toISOString(),
    message: {
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
    },
  });

function daemon(db = openDb(":memory:")) {
  resetLiveSteps();
  resetLiveMessages();
  const events = new EventLog(db);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const registry = new Registry(db, events);
  const messages = new MessageTracker(events, { pollMs: 0 });
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    steps: new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 }),
    messages,
  });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: SID, cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  const shown = () => ({
    messages: seen.flatMap((e) => (e.type === "turn.message" ? [e.message.text] : [])),
    actions: seen.flatMap((e) => (e.type === "turn.action" ? [e.step.id] : [])),
  });
  return { db, hooks, hook, messages, shown };
}

test("after a restart, the open turn's messages and actions show, an earlier turn's do not", async () => {
  const before = daemon();
  await before.hook("UserPromptSubmit", { prompt: "go" });
  const start = Date.now();
  appendFileSync(transcript, text("old", "From an earlier turn.", start - 60_000));
  appendFileSync(transcript, text("m1", "Before the restart.", start + 10));
  appendFileSync(transcript, tool("t1", start + 20));

  const after = daemon(before.db);
  expect(after.hooks.resumeOpenTurns()).toBe(1);
  after.messages.poll(SID);
  expect(after.shown().messages).toEqual(["Before the restart."]);
  expect(after.shown().actions).toContain("t1");

  appendFileSync(transcript, text("m2", "After the restart.", start + 30));
  appendFileSync(transcript, tool("t2", start + 40));
  after.messages.poll(SID);
  expect(after.shown().messages).toEqual(["Before the restart.", "After the restart."]);
  expect(after.shown().actions).toContain("t2");
});

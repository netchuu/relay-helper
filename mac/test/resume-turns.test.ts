import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

const CWD = "/Users/me/Projects/my-app";

// A daemon on `db`; calling it again with the same db is a restart.
function daemon(db = openDb(":memory:")) {
  resetLiveSteps();
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 20 });
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    steps,
  });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  const read = (id: string) =>
    hook("PreToolUse", { tool_use_id: id, tool_name: "Read", tool_input: { file_path: `${CWD}/a.ts` } });
  const step = () => publicSession(registry.get("s1") as SessionRecord).step?.label;
  return { db, hooks, hook, read, step, registry };
}

afterEach(() => resetLiveSteps());

test("after a restart in the middle of a turn, its steps show again", async () => {
  const before = daemon();
  await before.hook("UserPromptSubmit", { prompt: "go" });
  const after = daemon(before.db);
  await after.read("r1");
  expect(after.step()).not.toBe("Reading a.ts");
  expect(after.hooks.resumeOpenTurns()).toBe(1);
  await after.read("r2");
  expect(after.step()).toBe("Reading a.ts");
});

test("a finished turn is not followed again", async () => {
  const before = daemon();
  await before.hook("UserPromptSubmit", { prompt: "go" });
  await before.hook("Stop", { last_assistant_message: "done" });
  const after = daemon(before.db);
  expect(after.hooks.resumeOpenTurns()).toBe(0);
});

test("an open turn of a session that is idle is not followed", async () => {
  const before = daemon();
  await before.hook("UserPromptSubmit", { prompt: "go" });
  before.registry.setStatus("s1", "idle");
  const after = daemon(before.db);
  expect(after.hooks.resumeOpenTurns()).toBe(0);
});

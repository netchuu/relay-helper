import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { BackgroundTracker, resetBackground, runsInBackground } from "../src/daemon/background.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { Notifier } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { sealedTitle, TEST_PUSH_KEY } from "./support/sealed.ts";

// A session with background shells or agents running shows as working on the phone, and its "is done" push
// waits until the last one ends. The helper's state for it: runsInBackground(session) (the session's own status
// stays idle, so older phones show the strip as before).

const SHELL = {
  id: "sh1",
  type: "shell",
  status: "running",
  description: "Dev server",
  command: "npm run dev",
};
const AGENT = {
  id: "ag1",
  type: "subagent",
  status: "running",
  description: "Tests",
  agent_type: "general-purpose",
};
const NOTE = (id: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`;

afterEach(() => resetBackground());

function setup(present = false) {
  const db = openDb(":memory:");
  db.query(
    "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_key) VALUES ('ios', 'iPhone', 'h', 0, ?, 'sandbox', ?)",
  ).run("a".repeat(64), TEST_PUSH_KEY);
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presenceState = { present };
  const presence = {
    get: () => ({ mode: "auto", present: presenceState.present, idleSeconds: 0, locked: false }),
    noteLocalActivity() {},
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence,
    config: { previewChars: 600 } as RelayConfig,
    background: new BackgroundTracker(events, { throttleMs: 0 }),
  });
  const titles: string[] = [];
  const apns = {
    send: async (_t: string, _e: string, payload: object) => {
      titles.push(sealedTitle(payload));
      return { status: 200 };
    },
  };
  const notifier = new Notifier(db, events, presence, registry, broker, { apns } as never);
  notifier.start();
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/Users/me/app", ...fields }, env: {} },
      new AbortController().signal,
    );
  const settle = () => Bun.sleep(30);
  return { hook, titles, settle, presenceState };
}

test("the state counts 0, 1 and several background jobs, and follows a job ending", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("Stop", { last_assistant_message: "Done.", background_tasks: [] });
  expect(runsInBackground("s1")).toBe(false);

  await t.hook("UserPromptSubmit", { prompt: "again" });
  await t.hook("Stop", { last_assistant_message: "One.", background_tasks: [SHELL] });
  expect(runsInBackground("s1")).toBe(true);

  await t.hook("UserPromptSubmit", { prompt: "more" });
  await t.hook("Stop", { last_assistant_message: "Two.", background_tasks: [SHELL, AGENT] });
  expect(runsInBackground("s1")).toBe(true);

  await t.hook("UserPromptSubmit", { prompt: NOTE("sh1") });
  expect(runsInBackground("s1")).toBe(true);
  await t.hook("Stop", { last_assistant_message: "Shell ended.", background_tasks: [AGENT] });
  expect(runsInBackground("s1")).toBe(true);
  await t.hook("UserPromptSubmit", { prompt: NOTE("ag1") });
  expect(runsInBackground("s1")).toBe(false);
});

test("a job outlives a new turn: the session still runs it while the turn works and after it", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "Started.", background_tasks: [SHELL] });
  await t.hook("UserPromptSubmit", { prompt: "What is the time?" });
  expect(runsInBackground("s1")).toBe(true);
  await t.hook("Stop", { last_assistant_message: "Noon.", background_tasks: [SHELL] });
  expect(runsInBackground("s1")).toBe(true);
});

test("the session ending clears it", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "Started.", background_tasks: [SHELL] });
  await t.hook("SessionEnd", {});
  expect(runsInBackground("s1")).toBe(false);
});

test("the finished push waits for the last background job, then goes out once", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Run the server" });
  await t.hook("Stop", { last_assistant_message: "Server is up.", background_tasks: [SHELL, AGENT] });
  await t.settle();
  expect(t.titles).toEqual([]);
  // One job ends: still held.
  await t.hook("UserPromptSubmit", { prompt: NOTE("sh1") });
  await t.settle();
  expect(t.titles).toEqual([]);
  // The last one ends: the held alert goes out.
  await t.hook("UserPromptSubmit", { prompt: NOTE("ag1") });
  await t.settle();
  expect(t.titles.length).toBe(1);
  expect(t.titles[0]).toContain("done");
});

test("without background jobs the finished push goes out at once, as before", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("Stop", { last_assistant_message: "Done.", background_tasks: [] });
  await t.settle();
  expect(t.titles.length).toBe(1);
});

test("a held push is dropped when you are back at the Mac, and when the session ends", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("Stop", { last_assistant_message: "Up.", background_tasks: [SHELL] });
  t.presenceState.present = true;
  await t.hook("UserPromptSubmit", { prompt: NOTE("sh1") });
  await t.settle();
  expect(t.titles).toEqual([]);

  await t.hook("UserPromptSubmit", { prompt: "again" });
  await t.hook("Stop", { last_assistant_message: "Up.", background_tasks: [SHELL] });
  await t.hook("SessionEnd", {});
  t.presenceState.present = false;
  await t.settle();
  expect(t.titles).toEqual([]);
});

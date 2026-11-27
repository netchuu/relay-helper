import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { atMacOfSession, DialogWatcher, limitWaitStep } from "../src/daemon/dialogWatch.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";
import { Registry } from "../src/daemon/registry.ts";
import { liveStep, resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

afterEach(() => resetLiveSteps());

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 60_000 });
  const dialogs = new DialogWatcher({ registry, events });
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    dialogs,
  });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: "ln", cwd: "/Users/me/app", ...fields },
        env: { socket: "/tmp/ln.sock" },
      },
      new AbortController().signal,
    );
  const notices = () =>
    (events.since(0) as { type: string; level?: string; text?: string }[])
      .filter((e) => e.type === "session.notice")
      .map((e) => ({ level: e.level, text: e.text }));
  return { db, events, registry, steps, dialogs, hook, notices };
}

test("quota and auth notifications get their words and levels", async () => {
  const { hook, notices } = setup();
  await hook("SessionStart");
  for (const type of [
    "quota_auto_resume_fired",
    "quota_auto_resume_stale",
    "quota_auto_resume_disabled",
    "auth_storage_failure",
  ])
    await hook("Notification", { notification_type: type, message: "raw text" });
  const wont = "Claude Code won't continue by itself. Send a message when your limit resets.";
  expect(notices()).toEqual([
    { level: "info", text: "Your usage limit reset. Claude Code continued." },
    { level: "attention", text: wont },
    { level: "attention", text: wont },
    { level: "attention", text: "Claude Code couldn't save its sign-in on your computer." },
  ]);
});

test("model_refusal_fallback sets atMac with its title and one attention notice", async () => {
  const { hook, notices } = setup();
  await hook("SessionStart");
  await hook("Notification", { notification_type: "model_refusal_fallback", message: "Switch to Sonnet?" });
  expect(atMacOfSession("ln")).toMatchObject({ kind: "model_refusal_fallback", title: "Switch to Sonnet?" });
  expect(notices()).toEqual([{ level: "attention", text: "Waiting on your computer: Switch to Sonnet?" }]);
  await hook("UserPromptSubmit", { prompt: "go" });
  expect(atMacOfSession("ln")).toBeUndefined();
});

test("limitWaitStep reads the time off Claude Code's line", () => {
  expect(limitWaitStep("  ⎿ Continuing automatically at 3:45pm · Esc to cancel")).toBe(
    "Waiting for the usage limit, continues at 3:45pm",
  );
  expect(limitWaitStep("⏺ Done.")).toBeNull();
});

test("a screen that shows the wait makes it the live step, and it goes when the screen moves on", async () => {
  const { registry, events, hook, steps } = setup();
  await hook("SessionStart");
  await hook("UserPromptSubmit", { prompt: "go" });
  const session = registry.get("ln") as SessionRecord;
  expect(session.status).toBe("working");
  steps.turnStarted("ln", "t1");
  let screen = "  Continuing automatically at 3:45pm · Esc to cancel";
  const full = { fiveHour: { usedPercent: 100, resetsAt: Date.now() + 3_600_000 } };
  let clock = 1_000_000;
  const w = new DialogWatcher({
    registry,
    events,
    steps,
    usage: () => full,
    read: async () => screen,
    now: () => clock,
  });
  await w.tick();
  expect(liveStep("ln")?.label).toBe("Waiting for the usage limit, continues at 3:45pm");
  screen = "✻ Thinking…";
  clock += 4_000;
  await w.tick();
  expect(liveStep("ln")?.label).toBe("Thinking");
});

test("no full limit: the screen of a working session isn't read", async () => {
  const { registry, events, hook, steps } = setup();
  await hook("SessionStart");
  await hook("UserPromptSubmit", { prompt: "go" });
  steps.turnStarted("ln", "t1");
  let reads = 0;
  const w = new DialogWatcher({
    registry,
    events,
    steps,
    usage: () => ({ fiveHour: { usedPercent: 40 } }),
    read: async () => {
      reads++;
      return "Continuing automatically at 3:45pm";
    },
  });
  await w.tick();
  expect(reads).toBe(0);
  expect(liveStep("ln")?.label).toBe("Thinking");
});

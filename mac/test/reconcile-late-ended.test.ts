import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

// A session started or resumed while the 20 s `claude agents --json` check runs is newer than its list: the check
// must not end it, or the turn's live trackers are cleared and the phone shows a working session as ended.

const dirs: string[] = [];
afterEach(() => {
  resetLiveSteps();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  resetLiveSteps();
  const dir = mkdtempSync(join(tmpdir(), "relay-late-ended-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nsleep 0.4\necho '[{"sessionId":"s1","cwd":"/Users/me/project","status":"idle"}]'\n`,
  );
  chmodSync(bin, 0o755);
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = {
    noteLocalActivity() {},
    get: () => ({ mode: "auto", away: false }),
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence,
    config: { previewChars: 600 } as RelayConfig,
    steps,
  });
  const hook = (id: string, event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: id, cwd: "/Users/me/project", ...fields }, env: {} },
      new AbortController().signal,
    );
  return { bin, registry, hook, events };
}

test("a session started while the check ran is not ended by that check", async () => {
  const t = setup();
  await t.hook("s1", "SessionStart");
  const reconciling = t.registry.reconcile(t.bin);
  await Bun.sleep(150);
  await t.hook("s2", "SessionStart");
  await t.hook("s2", "UserPromptSubmit", { prompt: "go" });
  await reconciling;
  expect(t.registry.get("s2")?.status).toBe("working");
  await t.hook("s2", "PreToolUse", {
    tool_use_id: "a",
    tool_name: "Read",
    tool_input: { file_path: "/Users/me/project/a.ts" },
  });
  expect(t.registry.get("s2")?.status).toBe("working");
  const labels = t.events.since(0).flatMap((e) => (e.type === "turn.step" ? [e.step.label] : []));
  expect(labels).toContain("Reading a.ts");
});

test("a resumed session whose prompt arrives during the check is not ended again", async () => {
  const t = setup();
  await t.hook("s1", "SessionStart");
  await t.hook("s2", "SessionStart");
  await t.registry.reconcile(t.bin);
  expect(t.registry.get("s2")?.status).toBe("ended");
  const reconciling = t.registry.reconcile(t.bin);
  await Bun.sleep(150);
  await t.hook("s2", "UserPromptSubmit", { prompt: "again" });
  await reconciling;
  expect(t.registry.get("s2")?.status).toBe("working");
});

test("a session not touched since the check began and missing from its list is ended", async () => {
  const t = setup();
  await t.hook("s1", "SessionStart");
  await t.hook("s2", "SessionStart");
  await t.registry.reconcile(t.bin);
  expect(t.registry.get("s1")?.status).toBe("idle");
  expect(t.registry.get("s2")?.status).toBe("ended");
});

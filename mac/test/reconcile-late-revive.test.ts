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

const dirs: string[] = [];
afterEach(() => {
  resetLiveSteps();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(status: string) {
  resetLiveSteps();
  const dir = mkdtempSync(join(tmpdir(), "relay-late-revive-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nsleep 0.4\necho '[{"sessionId":"s1","cwd":"/Users/me/project","status":"${status}"}]'\n`,
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
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/Users/me/project", ...fields }, env: {} },
      new AbortController().signal,
    );
  const upserts = () =>
    events.since(0).flatMap((e) => (e.type === "session.upsert" ? [e.session.status] : []));
  const endedAt = () =>
    (db.query("SELECT ended_at FROM sessions WHERE id = ?").get("s1") as { ended_at: number | null })
      .ended_at;
  return { bin, registry, hook, upserts, endedAt };
}

test("a busy report taken before the session ended does not show it working again", async () => {
  const t = setup("busy");
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "go" });
  const check = t.registry.reconcile(t.bin);
  await Bun.sleep(150);
  await t.hook("SessionEnd");
  const sent = t.upserts().length;
  await check;
  expect(t.registry.get("s1")?.status).toBe("ended");
  expect(t.endedAt()).toBeTruthy();
  expect(t.upserts().slice(sent)).toEqual([]);
  expect(t.upserts().at(-1)).toBe("ended");
});

test("an idle report taken before the session ended does not make it live again", async () => {
  const t = setup("idle");
  await t.hook("SessionStart");
  const check = t.registry.reconcile(t.bin);
  await Bun.sleep(150);
  await t.hook("SessionEnd");
  const sent = t.upserts().length;
  await check;
  expect(t.registry.get("s1")?.status).toBe("ended");
  expect(t.endedAt()).toBeTruthy();
  expect(t.upserts().slice(sent)).toEqual([]);
});

test("a session ended and then resumed while the check ran is live", async () => {
  const t = setup("idle");
  await t.hook("SessionStart");
  const check = t.registry.reconcile(t.bin);
  await Bun.sleep(100);
  await t.hook("SessionEnd");
  await Bun.sleep(50);
  await t.hook("SessionStart");
  await check;
  expect(t.registry.get("s1")?.status).not.toBe("ended");
});

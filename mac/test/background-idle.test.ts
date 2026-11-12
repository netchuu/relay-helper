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

// A turn that ends with background shells still running (a dev server, a watcher) leaves Claude waiting for you.
// The session is idle then, not "Working" with a Stop button for as long as the shells run, even though
// `claude agents` reports it "busy" all that time.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-bg-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  const agents = join(dir, "agents.json");
  writeFileSync(bin, `#!/bin/sh\ncat "${agents}"\n`);
  chmodSync(bin, 0o755);
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence,
    config: { previewChars: 600 } as RelayConfig,
  });
  const hook = (event: string, fields: Record<string, unknown> = {}, id = "s1") =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: id, cwd: "/Users/me/project", ...fields }, env: {} },
      new AbortController().signal,
    );
  const claudeSays = async (status: string, id = "s1") => {
    writeFileSync(agents, JSON.stringify([{ sessionId: id, cwd: "/Users/me/project", status }]));
    await registry.reconcile(bin);
  };
  const status = (id = "s1") => registry.get(id)?.status;
  return { hook, claudeSays, status };
}

test("a turn that ends with background shells running leaves the session idle", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Start the dev server and deploy" });
  expect(t.status()).toBe("working");
  await t.hook("Stop", {
    last_assistant_message: "I couldn't deploy.",
    background_tasks: [{ id: "a" }, { id: "b" }],
  });
  expect(t.status()).toBe("idle");
});

test("Claude Code saying busy after the turn ended (its shells still run) keeps it idle", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Run it" });
  await t.hook("Stop", { last_assistant_message: "Running.", background_tasks: [{ id: "a" }] });
  await t.claudeSays("busy");
  expect(t.status()).toBe("idle");
});

test("busy during an open turn is working, and a background task finishing starts a turn that shows working", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Run it" });
  await t.claudeSays("busy");
  expect(t.status()).toBe("working");
  await t.hook("Stop", { last_assistant_message: "Running.", background_tasks: [{ id: "a" }] });
  await t.hook("UserPromptSubmit", {
    prompt: "<task-notification> <task-id>a</task-id> </task-notification>",
  });
  await t.claudeSays("busy");
  expect(t.status()).toBe("working");
});

test("a session the hooks never saw a turn of follows Claude Code's busy as before", async () => {
  const t = setup();
  await t.claudeSays("busy", "s2");
  expect(t.status("s2")).toBe("working");
  await t.claudeSays("idle", "s2");
  expect(t.status("s2")).toBe("idle");
});

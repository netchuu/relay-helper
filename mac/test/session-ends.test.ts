import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-ends-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  const agents = join(dir, "agents.json");
  writeFileSync(bin, `#!/bin/sh\ncat "${agents}"\n`);
  chmodSync(bin, 0o755);
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
  });
  const hook = (event: string, fields: Record<string, unknown> = {}, id = "s1") =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: id, cwd: "/Users/me/app", ...fields }, env: {} },
      new AbortController().signal,
    );
  const wire = (id = "s1") => {
    const s = registry.get(id);
    return s ? publicSession(s) : undefined;
  };
  const claudeLists = (ids: string[]) => {
    writeFileSync(
      agents,
      JSON.stringify(ids.map((sessionId) => ({ sessionId, cwd: "/Users/me/app", status: "idle" }))),
    );
    return registry.reconcile(bin);
  };
  return { hook, registry, wire, claudeLists, agents };
}

test.each([
  ["prompt_input_exit", "exit"],
  ["clear", "clear"],
  ["resume", "resume"],
  ["logout", "logout"],
  ["other", "other"],
  ["bypass_permissions_disabled", "other"],
  ["a_reason_from_a_newer_claude", "other"],
])("SessionEnd %s is endReason %s", async (reason, endReason) => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("SessionEnd", { reason });
  const s = t.wire();
  expect(s?.status).toBe("ended");
  expect(s?.endReason).toBe(endReason);
  expect(Session.safeParse(s).success).toBe(true);
});

test("a SessionEnd without a reason is other", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("SessionEnd");
  expect(t.wire()?.endReason).toBe("other");
});

test("a session that comes back has no endReason", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("SessionEnd", { reason: "prompt_input_exit" });
  await t.hook("UserPromptSubmit", { prompt: "go on" });
  expect(t.wire()?.status).toBe("working");
  expect(t.wire()?.endReason).toBeUndefined();
});

test("a late SessionEnd doesn't replace the reason already kept", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("SessionEnd", { reason: "logout" });
  await t.hook("SessionEnd", { reason: "other" });
  expect(t.wire()?.endReason).toBe("logout");
});

test("reconcile ends a session missing from claude agents as closed", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.claudeLists([]);
  expect(t.wire()?.status).toBe("ended");
  expect(t.wire()?.endReason).toBe("closed");
});

test("the sweep ends a session whose process is gone as closed", async () => {
  const t = setup();
  const gone = Bun.spawnSync(["true"]);
  t.registry.touch("s1", { cwd: "/Users/me/app", env: { claudePid: gone.pid } }, false);
  writeFileSync(t.agents, "not json");
  await t.registry.reconcile(join(dirs[0] as string, "claude"));
  expect(t.wire()?.status).toBe("ended");
  expect(t.wire()?.endReason).toBe("closed");
});

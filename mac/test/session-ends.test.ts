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
import { type HookEnv, publicSession, Registry } from "../src/daemon/registry.ts";

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
  const hook = (event: string, fields: Record<string, unknown> = {}, id = "s1", env: HookEnv = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: id, cwd: "/Users/me/app", ...fields }, env },
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

const proc = (claudePid: number, pty = "/tmp/pty-a.sock") => ({ claudePid, pty });

test.each(["clear", "resume"])(
  "/%s links the old chat and the new one in the same process",
  async (source) => {
    const t = setup();
    await t.hook("SessionStart", {}, "old", proc(10));
    await t.hook("SessionEnd", { reason: source }, "old", proc(10));
    await t.hook("SessionStart", { source }, "new", proc(10));
    expect(t.wire("old")?.replacedBy).toBe("new");
    expect(t.wire("new")?.replaces).toBe("old");
    expect(t.wire("new")?.replacedBy).toBeUndefined();
    expect(t.wire("old")?.replaces).toBeUndefined();
  },
);

test("a chat resumed after being cleared isn't named as replaced", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "a", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  await t.hook("SessionStart", { source: "clear" }, "b", proc(10));
  await t.hook("SessionEnd", { reason: "resume" }, "b", proc(10));
  await t.hook("SessionStart", { source: "resume" }, "a", proc(10));
  expect(t.wire("a")?.status).not.toBe("ended");
  expect(t.wire("a")?.replacedBy).toBeUndefined();
  expect(t.wire("b")?.replacedBy).toBe("a");
  await t.hook("SessionEnd", { reason: "prompt_input_exit" }, "a", proc(10));
  expect(t.wire("a")?.status).toBe("ended");
  expect(t.wire("a")?.replacedBy).toBeUndefined();
});

test("a cleared chat resumed from another terminal isn't named as replaced after it exits", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "a", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  await t.hook("SessionStart", { source: "clear" }, "b", proc(10));
  expect(t.wire("a")?.replacedBy).toBe("b");
  await t.hook("SessionStart", { source: "resume" }, "a", proc(20, "/tmp/pty-b.sock"));
  await t.hook("SessionEnd", { reason: "prompt_input_exit" }, "a", proc(20, "/tmp/pty-b.sock"));
  expect(t.wire("a")?.status).toBe("ended");
  expect(t.wire("a")?.replacedBy).toBeUndefined();
});

test("a second SessionEnd for a cleared chat keeps its successor", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "a", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  await t.hook("SessionStart", { source: "clear" }, "b", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  expect(t.wire("a")?.status).toBe("ended");
  expect(t.wire("a")?.replacedBy).toBe("b");
  expect(t.wire("b")?.replaces).toBe("a");
});

test("a late SessionEnd for a linked chat doesn't block the next /clear", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "a", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  await t.hook("SessionStart", { source: "clear" }, "b", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "b", proc(10));
  await t.hook("SessionStart", { source: "clear" }, "c", proc(10));
  expect(t.wire("b")?.replacedBy).toBe("c");
  expect(t.wire("c")?.replaces).toBe("b");
});

test("a cleared chat resumed in the helper and stopped isn't named as replaced", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "a", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "a", proc(10));
  await t.hook("SessionStart", { source: "clear" }, "b", proc(10));
  t.registry.setStatus("a", "working");
  expect(t.wire("a")?.replacedBy).toBeUndefined();
  t.registry.setStatus("a", "ended", { endReason: "stopped" });
  expect(t.wire("a")?.status).toBe("ended");
  expect(t.wire("a")?.replacedBy).toBeUndefined();
});

test("two chats cleared in the same second don't cross-link", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "a1", proc(10, "/tmp/a.sock"));
  await t.hook("SessionStart", {}, "b1", proc(20, "/tmp/b.sock"));
  await t.hook("SessionEnd", { reason: "clear" }, "a1", proc(10, "/tmp/a.sock"));
  await t.hook("SessionEnd", { reason: "clear" }, "b1", proc(20, "/tmp/b.sock"));
  await t.hook("SessionStart", { source: "clear" }, "b2", proc(20, "/tmp/b.sock"));
  await t.hook("SessionStart", { source: "clear" }, "a2", proc(10, "/tmp/a.sock"));
  expect(t.wire("a1")?.replacedBy).toBe("a2");
  expect(t.wire("b1")?.replacedBy).toBe("b2");
  expect(t.wire("a2")?.replaces).toBe("a1");
  expect(t.wire("b2")?.replaces).toBe("b1");
});

test("a new chat in another terminal or process isn't linked", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "old", proc(10));
  await t.hook("SessionEnd", { reason: "clear" }, "old", proc(10));
  await t.hook("SessionStart", { source: "startup" }, "fresh", proc(11));
  await t.hook("SessionStart", { source: "clear" }, "other", proc(10, "/tmp/other.sock"));
  expect(t.wire("old")?.replacedBy).toBeUndefined();
});

test("an exit isn't a successor, and the link waits only 10 s", async () => {
  const t = setup();
  await t.hook("SessionStart", {}, "old", proc(10));
  await t.hook("SessionEnd", { reason: "prompt_input_exit" }, "old", proc(10));
  await t.hook("SessionStart", { source: "resume" }, "new", proc(10));
  expect(t.wire("old")?.replacedBy).toBeUndefined();
  const real = Date.now;
  await t.hook("SessionStart", {}, "o2", proc(30));
  await t.hook("SessionEnd", { reason: "clear" }, "o2", proc(30));
  Date.now = () => real() + 11_000;
  try {
    await t.hook("SessionStart", { source: "clear" }, "n2", proc(30));
  } finally {
    Date.now = real;
  }
  expect(t.wire("o2")?.replacedBy).toBeUndefined();
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

function daemon(path: string) {
  const db = openDb(path);
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = { get: () => ({ mode: "auto", present: true, locked: false, idleSeconds: 0 }) };
  const rpc = createRpc({ db, events, registry, broker, presence, config: {} } as unknown as RpcDeps);
  const sync = async (sinceSeq: number) =>
    ((await rpc("sync", { sinceSeq }, "phone")) as { result: any }).result;
  return { db, events, broker, sync };
}

test("a sinceSeq above the newest event gets a snapshot", async () => {
  const d = daemon(":memory:");
  d.broker.open({ session_id: "s0", tool_name: "Bash", tool_input: { command: "ls" } });
  const latest = d.events.latestSeq();
  expect((await d.sync(latest)).snapshot).toBeUndefined();
  const ahead = await d.sync(latest + 50);
  expect(ahead.snapshot).toBeDefined();
  expect(ahead.latestSeq).toBe(latest);
});

test("the event log id is stable across restarts and new after a database reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-evlog-"));
  try {
    const path = join(dir, "relay.db");
    const first = daemon(path);
    const id = (await first.sync(0)).eventLogId;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    first.db.close();
    const again = daemon(path);
    expect((await again.sync(0)).eventLogId).toBe(id);
    expect((await again.sync(0)).eventLogId).toBe(id);
    again.db.close();
    rmSync(path);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const reset = daemon(path);
    const fresh = (await reset.sync(0)).eventLogId;
    expect(fresh).toMatch(/^[0-9a-f]{16}$/);
    expect(fresh).not.toBe(id);
    reset.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a replay between the oldest and newest event carries the event log id without a snapshot", async () => {
  const d = daemon(":memory:");
  const id = (await d.sync(0)).eventLogId;
  d.broker.open({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
  d.broker.open({ session_id: "s2", tool_name: "Bash", tool_input: { command: "pwd" } });
  const latest = d.events.latestSeq();
  expect(latest).toBeGreaterThan(1);
  const page = await d.sync(latest - 1);
  expect(page.snapshot).toBeUndefined();
  expect(page.events.length).toBeGreaterThan(0);
  expect(page.eventLogId).toBe(id);
  expect(page.eventLogId).toMatch(/^[0-9a-f]{16}$/);
});

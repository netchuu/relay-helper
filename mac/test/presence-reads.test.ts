import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { openDb, setSetting } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { PresenceMonitor } from "../src/daemon/presence.ts";
import { platform } from "../src/platform/index.ts";

// The Mac is only asked how long it has been idle, or whether it is locked, when the answer is used.
let reads: number;
let restore: () => void;

beforeEach(() => {
  reads = 0;
  const spy = spyOn(platform.presence, "read").mockImplementation(async () => {
    reads++;
    return { idleSeconds: 3, locked: true, source: "test" };
  });
  restore = () => spy.mockRestore();
});
afterEach(() => restore());

function make(mode: "auto" | "here" | "away", lockWanted?: () => boolean) {
  const db = openDb(":memory:");
  setSetting(db, "presence.mode", mode);
  return new PresenceMonitor(db, new EventLog(db), 120, lockWanted);
}

test("away and here read nothing while no reply waits for the unlock", async () => {
  for (const mode of ["away", "here"] as const) {
    const monitor = make(mode, () => false);
    await monitor.poll();
    await monitor.poll();
    expect(monitor.get()).toMatchObject({ mode, present: mode === "here", locked: false });
  }
  expect(reads).toBe(0);
});

test("away and here report the lock while a reply waits for the unlock", async () => {
  for (const mode of ["away", "here"] as const) {
    const monitor = make(mode, () => true);
    await monitor.poll();
    expect(monitor.get()).toMatchObject({ mode, present: mode === "here", locked: true });
  }
  expect(reads).toBe(2);
});

test("the lock is reported once a reply starts waiting, and dropped once it is gone", async () => {
  let waiting = false;
  const monitor = make("away", () => waiting);
  await monitor.poll();
  expect(monitor.get().locked).toBe(false);
  waiting = true;
  await monitor.poll();
  expect(monitor.get().locked).toBe(true);
  waiting = false;
  await monitor.poll();
  expect(monitor.get().locked).toBe(false);
  expect(reads).toBe(1);
});

test("auto reads on every poll", async () => {
  const monitor = make("auto", () => false);
  await monitor.poll();
  await monitor.poll();
  expect(reads).toBe(2);
  expect(monitor.get()).toMatchObject({ present: false, locked: true, idleSeconds: 3 });
});

test("switching from auto to away stops the reads", async () => {
  const monitor = make("auto", () => false);
  await monitor.poll();
  await monitor.setMode("away");
  await monitor.poll();
  expect(reads).toBe(1);
});

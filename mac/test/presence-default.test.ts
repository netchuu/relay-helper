import { expect, test } from "bun:test";
import { openDb, setSetting } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { DEFAULT_PRESENCE_MODE, PresenceMonitor } from "../src/daemon/presence.ts";

// Notifications always, "away" by default, so people know first and look at the phone.

test("a Mac that never had a mode picked is away, and counts as not present from the start", () => {
  const db = openDb(":memory:");
  const monitor = new PresenceMonitor(db, new EventLog(db), 300);
  expect(DEFAULT_PRESENCE_MODE).toBe("away");
  expect(monitor.get()).toMatchObject({ mode: "away", present: false });
});

test("a mode someone picked on the phone is kept", () => {
  for (const mode of ["auto", "here"] as const) {
    const db = openDb(":memory:");
    setSetting(db, "presence.mode", mode);
    expect(new PresenceMonitor(db, new EventLog(db), 300).get().mode).toBe(mode);
  }
});

test("local activity doesn't make an away Mac present (pushes keep coming)", () => {
  const db = openDb(":memory:");
  const monitor = new PresenceMonitor(db, new EventLog(db), 300);
  monitor.noteLocalActivity();
  expect(monitor.get().present).toBe(false);
});

test("a poll that started before setMode doesn't undo the chosen mode", async () => {
  const { platform } = await import("../src/platform/index.ts");
  const { spyOn } = await import("bun:test");
  const db = openDb(":memory:");
  setSetting(db, "presence.mode", "auto");
  const monitor = new PresenceMonitor(db, new EventLog(db), 300);
  const resolvers: Array<() => void> = [];
  const spy = spyOn(platform.presence, "read").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ idleSeconds: 1, locked: false, source: "test" }));
      }),
  );
  try {
    const early = monitor.poll();
    const choose = monitor.setMode("away");
    // The later read resolves first, then the one that started before the choice.
    resolvers[1]?.();
    await choose;
    resolvers[0]?.();
    await early;
    expect(monitor.get()).toMatchObject({ mode: "away", present: false });
    const later = monitor.poll();
    resolvers[2]?.();
    await later;
    expect(monitor.get()).toMatchObject({ mode: "away", present: false });
  } finally {
    spy.mockRestore();
  }
});

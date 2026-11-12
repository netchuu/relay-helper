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

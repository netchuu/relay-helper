import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Presence } from "../../protocol/index.ts";
import { openDb, setSetting } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { liveTmuxSockets, PresenceMonitor } from "../src/daemon/presence.ts";
import { platform } from "../src/platform/index.ts";

// The platform's reading is faked: no real key-idle or lock calls.
type Reading = { idleSeconds: number | null; locked?: boolean };
let reading: Reading;
let seen: unknown[];
let restore: () => void;

beforeEach(() => {
  reading = { idleSeconds: 0 };
  seen = [];
  const spy = spyOn(platform.presence, "read").mockImplementation(async (ctx) => {
    seen.push(ctx);
    return reading as never;
  });
  restore = () => spy.mockRestore();
});
afterEach(() => restore());

function make(mode?: "auto" | "here" | "away", idleAway = 120) {
  const db = openDb(":memory:");
  if (mode) setSetting(db, "presence.mode", mode);
  const events = new EventLog(db);
  const emitted: Presence[] = [];
  const emit = events.emit.bind(events);
  events.emit = ((e: { type: string; presence?: Presence }) => {
    if (e.type === "presence.changed" && e.presence) emitted.push(e.presence);
    return emit(e as never);
  }) as never;
  return { db, monitor: new PresenceMonitor(db, events, idleAway), emitted };
}

test("auto mode: recent input is present, old input is away", async () => {
  const { monitor } = make("auto");
  reading = { idleSeconds: 5 };
  await monitor.poll();
  expect(monitor.get()).toMatchObject({ mode: "auto", present: true, idleSeconds: 5, locked: false });
  reading = { idleSeconds: 500.4 };
  await monitor.poll();
  expect(monitor.get()).toMatchObject({ present: false, idleSeconds: 500 });
});

test("auto mode: a locked screen is away however recent the input", async () => {
  const { monitor } = make("auto");
  reading = { idleSeconds: 1, locked: true };
  await monitor.poll();
  expect(monitor.get()).toMatchObject({ present: false, locked: true });
});

test("unknown idle time counts as away and is reported as -1", async () => {
  const { monitor } = make("auto");
  reading = { idleSeconds: null };
  await monitor.poll();
  expect(monitor.get()).toMatchObject({ present: false, idleSeconds: -1 });
});

test("here is present even when locked and idle; away never is", async () => {
  const here = make("here");
  reading = { idleSeconds: 9999, locked: true };
  await here.monitor.poll();
  expect(here.monitor.get().present).toBe(true);
  const away = make("away");
  reading = { idleSeconds: 0 };
  await away.monitor.poll();
  expect(away.monitor.get().present).toBe(false);
});

test("setMode applies at once, is stored, and emits one change", async () => {
  const { db, monitor, emitted } = make();
  reading = { idleSeconds: 0 };
  const result = await monitor.setMode("here");
  expect(result).toMatchObject({ mode: "here", present: true });
  expect(emitted).toHaveLength(1);
  expect(new PresenceMonitor(db, new EventLog(db), 120).get().mode).toBe("here");
  await monitor.setMode("here");
  expect(emitted).toHaveLength(1); // nothing changed, nothing emitted
});

test("local typing makes an auto Mac present until idleAwaySeconds pass", async () => {
  const { monitor, emitted } = make("auto", 120);
  reading = { idleSeconds: 9999 };
  await monitor.poll();
  expect(monitor.get().present).toBe(false);
  emitted.length = 0;
  monitor.noteLocalActivity();
  expect(monitor.get().present).toBe(true);
  expect(emitted).toHaveLength(1);
  await monitor.poll(); // idle is old, but the typing was just now
  expect(monitor.get().present).toBe(true);
  monitor.noteLocalActivity(); // already present: no second event
  expect(emitted).toHaveLength(1);
});

test("local typing after the window doesn't count", async () => {
  const { monitor } = make("auto", 120);
  reading = { idleSeconds: 9999 };
  const now = Date.now();
  const spy = spyOn(Date, "now").mockReturnValue(now);
  monitor.noteLocalActivity();
  spy.mockReturnValue(now + 121_000);
  await monitor.poll();
  spy.mockRestore();
  expect(monitor.get().present).toBe(false);
});

test("poll passes the tmux sockets of live sessions only", async () => {
  const { db, monitor } = make("auto");
  const insert = (id: string, status: string, sock: string | null) =>
    db.run(
      "INSERT INTO sessions (id, project, cwd, status, tmux_socket, started_at, updated_at) VALUES (?, 'p', '/p', ?, ?, 0, 0)",
      [id, status, sock],
    );
  try {
    insert("a", "idle", "/tmp/s1");
    insert("b", "idle", "/tmp/s1");
    insert("c", "ended", "/tmp/s2");
    insert("d", "idle", null);
  } catch (e) {
    throw new Error(`sessions table columns changed: ${(e as Error).message}`);
  }
  expect(liveTmuxSockets(db)).toEqual(["/tmp/s1"]);
  await monitor.poll();
  expect(seen[0]).toEqual({ tmuxSockets: ["/tmp/s1"] });
});

test("start polls at once and on a timer; stop ends it", async () => {
  const { monitor } = make("auto");
  monitor.start(10);
  await Bun.sleep(60);
  monitor.stop();
  const n = seen.length;
  expect(n).toBeGreaterThanOrEqual(2);
  await Bun.sleep(40);
  expect(seen.length).toBe(n);
  monitor.stop(); // safe to call again
});

test("stop before start is harmless", () => {
  make().monitor.stop();
});

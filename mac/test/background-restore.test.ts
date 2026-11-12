import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTracker, backgroundOf, resetBackground } from "../src/daemon/background.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";

// background-work: after a helper restart the session's last list is back, so the phones (which keep the list they
// last saw) and the helper agree until the next Stop corrects it.

const SHELL = {
  id: "bonwwqtte",
  type: "shell",
  status: "running",
  description: "Start the dev server",
  command: "npm run dev",
};
const dirs: string[] = [];
afterEach(() => {
  resetBackground();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function helper(path: string) {
  const db = openDb(path);
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const tracker = new BackgroundTracker(events, { throttleMs: 0 });
  tracker.restore((id) => {
    const s = registry.get(id);
    return Boolean(s && s.status !== "ended");
  });
  return { db, events, registry, tracker };
}

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-bg-restore-"));
  dirs.push(dir);
  return join(dir, "relay.db");
}

test("after a restart the last list is back, with its startedAt, and publicSession carries it", () => {
  const path = dbPath();
  const a = helper(path);
  a.registry.touch("s1", { cwd: "/Users/me/app" });
  a.tracker.stopped("s1", [SHELL]);
  const startedAt = backgroundOf("s1")[0]?.startedAt;
  a.db.close();
  resetBackground();

  const b = helper(path);
  expect(backgroundOf("s1").map((t) => [t.id, t.title, t.startedAt])).toEqual([
    ["bonwwqtte", "Start the dev server", startedAt as number],
  ]);
  expect(publicSession(b.registry.get("s1") as SessionRecord).background?.[0]?.id).toBe("bonwwqtte");
  // Restoring sends nothing (the phones have it already); the next Stop replaces it as usual.
  expect(b.events.since(0).filter((e) => e.type === "session.background")).toHaveLength(1);
  b.tracker.stopped("s1", []);
  expect(backgroundOf("s1")).toEqual([]);
  b.db.close();
});

test("an ended session's list, an emptied list and malformed entries aren't restored", () => {
  const path = dbPath();
  const a = helper(path);
  a.registry.touch("ended", { cwd: "/x" });
  a.registry.touch("emptied", { cwd: "/y" });
  a.tracker.stopped("ended", [SHELL]);
  a.tracker.stopped("emptied", [SHELL]);
  a.tracker.stopped("emptied", []);
  a.registry.setStatus("ended", "ended");
  a.events.emit({ type: "session.background", sessionId: "odd", tasks: [{ nope: 1 }] as never });
  a.registry.touch("odd", { cwd: "/z" });
  a.db.close();
  resetBackground();

  const b = helper(path);
  expect(backgroundOf("ended")).toEqual([]);
  expect(backgroundOf("emptied")).toEqual([]);
  expect(backgroundOf("odd")).toEqual([]);
  b.db.close();
});

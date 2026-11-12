import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Session } from "../../protocol/index.ts";
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { pinnedFirst, publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

// A pin kept by the helper, so every phone lists the same sessions first.
function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const upserts: Session[] = [];
  events.subscribe((e: RelayEvent) => {
    if (e.type === "session.upsert") upserts.push(e.session);
  });
  // session.pin only needs the database, the event log and the registry.
  const rpc = createRpc({ db, events, registry } as unknown as RpcDeps);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", name: "claude-name" });
  upserts.length = 0;
  const pub = (id: string) => publicSession(registry.get(id) as SessionRecord);
  return { db, registry, upserts, rpc, pub };
}

describe("session pin", () => {
  test("pinning sets pinnedAt everywhere a phone reads sessions, without touching updatedAt", () => {
    const { registry, upserts, pub } = setup();
    const before = registry.get("s1")?.updatedAt;
    registry.pin("s1", true, 1_000);
    expect(pub("s1").pinnedAt).toBe(1_000);
    expect(registry.list().map(publicSession)[0]?.pinnedAt).toBe(1_000);
    // Not activity: the Idle row's "2 min ago" doesn't jump.
    expect(pub("s1").updatedAt).toBe(before as number);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.pinnedAt).toBe(1_000);
  });

  test("unpinned sessions carry no pinnedAt key, so they look exactly as before", () => {
    const { registry, pub } = setup();
    expect("pinnedAt" in pub("s1")).toBe(false);
    registry.pin("s1", true, 1_000);
    registry.pin("s1", false);
    expect("pinnedAt" in pub("s1")).toBe(false);
  });

  test("pinning twice keeps the first time; unpinning an unpinned session is a no-op; both still publish", () => {
    const { registry, upserts, pub } = setup();
    registry.pin("s1", true, 1_000);
    registry.pin("s1", true, 2_000);
    expect(pub("s1").pinnedAt).toBe(1_000);
    registry.pin("s1", false);
    registry.pin("s1", false);
    expect("pinnedAt" in pub("s1")).toBe(false);
    expect(upserts).toHaveLength(4);
  });

  test("hooks and reconcile don't clear the pin", () => {
    const { registry } = setup();
    registry.pin("s1", true, 1_000);
    registry.touch("s1", { name: "renamed-in-claude" }, false);
    registry.setStatus("s1", "working");
    expect(registry.get("s1")?.pinnedAt).toBe(1_000);
  });

  test("an ended session keeps its pin, and a resumed one comes back pinned", () => {
    const { registry } = setup();
    registry.pin("s1", true, 1_000);
    registry.setStatus("s1", "ended");
    expect(registry.list().find((s) => s.id === "s1")).toBeUndefined();
    expect(registry.list(true).find((s) => s.id === "s1")?.pinnedAt).toBe(1_000);
    registry.touch("s1", { name: "claude-name" });
    expect(registry.get("s1")?.status).toBe("idle");
    expect(registry.get("s1")?.pinnedAt).toBe(1_000);
  });

  test("a pin and a rename live side by side", () => {
    const { registry, pub } = setup();
    registry.pin("s1", true, 1_000);
    registry.rename("s1", "Cart bug");
    expect(pub("s1")).toMatchObject({ name: "Cart bug", originalName: "claude-name", pinnedAt: 1_000 });
  });

  test("RPC: returns the session; unknown IDs and bad params are refused; ended sessions can be pinned", async () => {
    const { rpc, registry } = setup();
    const ok = await rpc("session.pin", { sessionId: "s1", pinned: true }, "device:test");
    expect("result" in ok && typeof (ok.result as Session).pinnedAt).toBe("number");
    const off = await rpc("session.pin", { sessionId: "s1", pinned: false }, "device:test");
    expect("result" in off && "pinnedAt" in (off.result as Session)).toBe(false);

    const missing = await rpc("session.pin", { sessionId: "nope", pinned: true }, "device:test");
    expect("error" in missing && missing.error.code).toBe("not_found");
    for (const params of [{ sessionId: "s1" }, { sessionId: "s1", pinned: "yes" }, { pinned: true }]) {
      const bad = await rpc("session.pin", params, "device:test");
      expect("error" in bad && bad.error.code).toBe("bad_request");
    }

    registry.setStatus("s1", "ended");
    const ended = await rpc("session.pin", { sessionId: "s1", pinned: true }, "device:test");
    expect("result" in ended).toBe(true);
  });

  test("the pin is audited", async () => {
    const { rpc, db } = setup();
    await rpc("session.pin", { sessionId: "s1", pinned: true }, "device:test");
    const rows = db.query("SELECT actor, action, detail FROM audit WHERE action = 'session.pin'").all() as {
      actor: string;
      detail: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("device:test");
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({ sessionId: "s1", pinned: true });
  });

  test("relay sessions order: pinned first, newest pin first, the rest as they came", () => {
    const list = [
      { id: "a", pinnedAt: undefined },
      { id: "b", pinnedAt: 1_000 },
      { id: "c", pinnedAt: null },
      { id: "d", pinnedAt: 2_000 },
    ];
    expect(pinnedFirst(list).map((s) => s.id)).toEqual(["d", "b", "a", "c"]);
  });
});

describe("session pin: migration 7", () => {
  test("a version-6 database gains pinned_at and keeps its sessions unpinned", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mig7-"));
    const path = join(dir, "relay.db");
    try {
      let db = openDb(path);
      db.query(
        "INSERT INTO sessions (id, name, cwd, project, started_at, updated_at) VALUES ('old', 'claude-old', '/p/x', 'x', 1, 2)",
      ).run();
      db.exec(
        "ALTER TABLE turns DROP COLUMN messages_json; ALTER TABLE turns DROP COLUMN steps_json; ALTER TABLE turns DROP COLUMN stopped; ALTER TABLE sessions DROP COLUMN pinned_at; PRAGMA user_version = 6;",
      );
      db.close();

      db = openDb(path);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
        SCHEMA_VERSION,
      );
      const registry = new Registry(db, new EventLog(db));
      const s = registry.get("old") as SessionRecord;
      expect("pinnedAt" in publicSession(s)).toBe(false);
      expect(registry.pin("old", true, 5)?.pinnedAt).toBe(5);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

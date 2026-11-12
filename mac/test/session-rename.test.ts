import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RelayEvent, type Session, Session as SessionSchema } from "../../protocol/index.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Notifier } from "../src/daemon/notifier.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps, type RpcOutcome } from "../src/daemon/rpc.ts";
import { sealedTitle, TEST_PUSH_KEY } from "./support/sealed.ts";

// Renaming a session from a phone, edge cases: the 60-character limit, blank names, params, state, what every reader
// sees, privacy and the migration.
// The basics (trim, 61 ASCII, "a\nb", null/""/spaces clear, audit by length) are in rename.test.ts.

function setup(claudeName: string | null = "claude-name") {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = { get: () => ({ mode: "auto", present: false, idleSeconds: 0, locked: false }) };
  const upserts: Session[] = [];
  events.subscribe((e) => {
    if (e.type === "session.upsert") upserts.push(e.session);
  });
  const rpc = createRpc({ db, events, registry, broker, presence } as unknown as RpcDeps);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", name: claudeName });
  upserts.length = 0;
  const rename = (name: unknown, sessionId: unknown = "s1") =>
    rpc("session.rename", { sessionId, name }, "device:phone-a");
  const auditRows = () =>
    db.query("SELECT actor, action, detail FROM audit WHERE action = 'session.rename'").all() as {
      actor: string;
      action: string;
      detail: string;
    }[];
  return { db, events, registry, broker, rpc, upserts, rename, auditRows };
}

const result = (o: RpcOutcome) => {
  if (!("result" in o)) throw new Error(`expected a result, got ${JSON.stringify(o.error)}`);
  return o.result as Session;
};
const errorCode = (o: RpcOutcome) => ("error" in o ? o.error.code : "ok");

describe("session-rename: the 60-character limit", () => {
  test("60 CJK characters are accepted; 61 are refused", async () => {
    const { rename } = setup();
    const sixty = "名".repeat(60);
    expect(result(await rename(sixty)).name).toBe(sixty);
    expect(errorCode(await rename("名".repeat(61)))).toBe("bad_request");
  });

  test("30 emoji (60 UTF-16 units) are accepted and stored intact", async () => {
    const { rename, registry } = setup();
    const name = "🚀".repeat(30);
    expect(result(await rename(name)).name).toBe(name);
    expect(registry.get("s1")?.name).toBe(name);
  });

  test("61 visible emoji are refused", async () => {
    const { rename, upserts } = setup();
    expect(errorCode(await rename("🚀".repeat(61)))).toBe("bad_request");
    expect(upserts).toHaveLength(0);
  });

  test("spaces around a 60-character CJK name don't count", async () => {
    const { rename } = setup();
    expect(result(await rename(`　 ${"名".repeat(60)}\t `)).name).toBe("名".repeat(60));
  });

  test("right-to-left text is stored exactly as typed", async () => {
    const { rename } = setup();
    const rtl = "تصحيح سلة التسوق";
    expect(result(await rename(rtl)).name).toBe(rtl);
  });

  test("text that looks like a command or markup is just a name", async () => {
    const { rename, registry } = setup();
    for (const name of ["/rename hacked", "<b>bold</b> & 'quotes'", "'; DROP TABLE sessions; --"]) {
      expect(result(await rename(name)).name).toBe(name);
    }
    expect(registry.get("s1")).not.toBeNull();
  });
});

describe("session-rename: blank names clear", () => {
  test("tabs, no-break and ideographic spaces only clear the name", async () => {
    const { rename } = setup();
    for (const blank of ["\t", "\t \t", " ", "　", "   "]) {
      await rename("Cart bug");
      const s = result(await rename(blank));
      expect(s.name).toBe("claude-name");
      expect("originalName" in s).toBe(false);
    }
  });

  test("a line break at either end is trimmed away, not refused", async () => {
    const { rename } = setup();
    expect(result(await rename("\nCart bug\r\n")).name).toBe("Cart bug");
    // Line breaks alone are blank, so they clear.
    expect(result(await rename("\r\n")).name).toBe("claude-name");
  });

  test("a carriage return or CRLF inside the name is refused", async () => {
    const { rename, registry } = setup();
    expect(errorCode(await rename("Cart\rbug"))).toBe("bad_request");
    expect(errorCode(await rename("Cart\r\nbug"))).toBe("bad_request");
    expect(registry.get("s1")?.name).toBe("claude-name");
  });
});

describe("session-rename: params", () => {
  test("a missing name is refused, not treated as a clear", async () => {
    const { rpc, rename, registry, upserts } = setup();
    await rename("Cart bug");
    upserts.length = 0;
    const missing = await rpc("session.rename", { sessionId: "s1" }, "device:phone-a");
    expect(errorCode(missing)).toBe("bad_request");
    expect(registry.get("s1")?.name).toBe("Cart bug");
    expect(upserts).toHaveLength(0);
  });

  test("wrong types for name or sessionId are refused and change nothing", async () => {
    const { rpc, rename, registry, upserts, auditRows } = setup();
    for (const bad of [42, true, {}, [], ["Cart"]]) expect(errorCode(await rename(bad))).toBe("bad_request");
    for (const id of [null, 1, {}]) expect(errorCode(await rename("Cart", id))).toBe("bad_request");
    expect(errorCode(await rpc("session.rename", { name: "Cart" }, "device:phone-a"))).toBe("bad_request");
    for (const params of [null, undefined, "s1", []])
      expect(errorCode(await rpc("session.rename", params, "device:phone-a"))).toBe("bad_request");
    expect(registry.get("s1")?.name).toBe("claude-name");
    expect(upserts).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  test("an unknown, empty or SQL-looking ID is not_found and creates nothing", async () => {
    const { db, rename, upserts, auditRows } = setup();
    for (const id of ["nope", "", "s1' OR '1'='1", "S1"])
      expect(errorCode(await rename("Cart bug", id))).toBe("not_found");
    expect((db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
    expect(
      (db.query("SELECT custom_name FROM sessions").get() as { custom_name: null }).custom_name,
    ).toBeNull();
    expect(upserts).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  test("an ended session can be renamed over RPC and stays ended", async () => {
    const { rpc, rename, registry } = setup();
    registry.setStatus("s1", "ended");
    const s = result(await rename("Old work"));
    expect(s.status).toBe("ended");
    expect(s.canReceive).toBe(false);
    const all = result(
      await rpc("sessions.list", { includeEnded: true }, "device:phone-a"),
    ) as unknown as Session[];
    expect(all.find((x) => x.id === "s1")?.name).toBe("Old work");
    const live = result(await rpc("sessions.list", {}, "device:phone-a")) as unknown as Session[];
    expect(live.some((x) => x.id === "s1")).toBe(false);
  });
});

describe("session-rename: state", () => {
  test("renaming twice: the second name wins and originalName stays Claude Code's", async () => {
    const { rename, upserts } = setup();
    await rename("First");
    const s = result(await rename("Second"));
    expect(s.name).toBe("Second");
    expect(s.originalName).toBe("claude-name");
    expect(upserts.map((u) => u.name)).toEqual(["First", "Second"]);
  });

  test("rename, clear, rename again; each step publishes exactly one upsert", async () => {
    const { rename, upserts } = setup();
    await rename("A");
    await rename(null);
    await rename("B");
    expect(upserts.map((u) => [u.name, u.originalName])).toEqual([
      ["A", "claude-name"],
      ["claude-name", undefined],
      ["B", "claude-name"],
    ]);
  });

  test("clearing a session that was never renamed is fine and still tells the phones", async () => {
    const { rename, upserts } = setup();
    const s = result(await rename(null));
    expect(s.name).toBe("claude-name");
    expect("originalName" in s).toBe(false);
    expect(upserts).toHaveLength(1);
  });

  test("a name equal to Claude Code's still counts as renamed", async () => {
    const { rename } = setup();
    const s = result(await rename("claude-name"));
    expect(s.originalName).toBe("claude-name");
  });

  test("a session Claude Code never named: originalName is present as null; clearing brings back null", async () => {
    const { rename } = setup(null);
    const renamed = result(await rename("API"));
    expect("originalName" in renamed).toBe(true);
    expect(renamed.originalName).toBeNull();
    // It survives JSON, so the apps can tell "renamed, no original" from "not renamed".
    expect(JSON.parse(JSON.stringify(renamed))).toHaveProperty("originalName", null);
    const cleared = result(await rename(""));
    expect(cleared.name).toBeNull();
    expect("originalName" in cleared).toBe(false);
  });

  test("a rename changes neither status, ordering nor updatedAt", async () => {
    const { rename, registry, rpc } = setup();
    registry.touch("s0", { cwd: "/Users/me/Projects/older" });
    registry.touch("s1", { name: null }); // s1 is now the most recent
    const before = registry.list().map((s) => [s.id, s.status, s.updatedAt]);
    await Bun.sleep(5);
    await rename("Moves nothing");
    expect(registry.list().map((s) => [s.id, s.status, s.updatedAt])).toEqual(before);
    const listed = result(await rpc("sessions.list", {}, "x")) as unknown as Session[];
    expect(listed.map((s) => s.id)).toEqual(["s1", "s0"]);
  });

  test("a real reconcile with a new Claude Code name keeps the phone's name; clearing shows the new one", async () => {
    const { rename, registry } = setup();
    const dir = mkdtempSync(join(tmpdir(), "relay-rename-"));
    try {
      const bin = join(dir, "claude");
      const agents = (name: string | undefined) =>
        writeFileSync(
          join(dir, "agents.json"),
          JSON.stringify([
            {
              sessionId: "s1",
              cwd: "/Users/me/Projects/web-shop",
              status: "idle",
              ...(name ? { name } : {}),
            },
          ]),
        );
      writeFileSync(bin, `#!/bin/sh\ncat "${join(dir, "agents.json")}"\n`);
      chmodSync(bin, 0o755);
      await rename("Cart bug");
      agents("renamed-in-claude");
      await registry.reconcile(bin);
      expect(registry.get("s1")?.name).toBe("Cart bug");
      expect(registry.get("s1")?.originalName).toBe("renamed-in-claude");
      // `claude agents` without a name keeps the last known one.
      agents(undefined);
      await registry.reconcile(bin);
      expect(registry.get("s1")?.originalName).toBe("renamed-in-claude");
      await rename(null);
      expect(registry.get("s1")?.name).toBe("renamed-in-claude");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session-rename: what every reader sees", () => {
  test("sync snapshot, sync since, sessions.list and the event agree", async () => {
    const { rpc, rename, events } = setup();
    await rename("Warm-up"); // so the phone has a seq to sync from
    const seq = events.latestSeq();
    await rename("Cart bug");
    const snap = result(await rpc("sync", { sinceSeq: 0 }, "x")) as unknown as {
      snapshot: { sessions: Session[] };
    };
    const delta = result(await rpc("sync", { sinceSeq: seq }, "x")) as unknown as { events: RelayEvent[] };
    const list = result(await rpc("sessions.list", {}, "x")) as unknown as Session[];
    const fromEvent = delta.events.find((e) => e.type === "session.upsert") as
      | { session: Session }
      | undefined;
    const views = [snap.snapshot.sessions[0], list[0], fromEvent?.session];
    for (const v of views) {
      expect(v?.name).toBe("Cart bug");
      expect(v?.originalName).toBe("claude-name");
    }
    // Every event still matches the protocol schema.
    for (const e of delta.events) expect(RelayEvent.safeParse(e).success).toBe(true);
  });

  test("the public session leaks no column names or tokens", async () => {
    const { rename, registry } = setup();
    registry.touch("s1", { env: { socket: "/tmp/x.sock", token: "tok-secret" } });
    const s = result(await rename("Cart bug"));
    const json = JSON.stringify(s);
    expect(json).not.toContain("custom_name");
    expect(json).not.toContain("customName");
    expect(json).not.toContain("tok-secret");
    expect(SessionSchema.strict().safeParse(s).success).toBe(true);
  });

  test("an older app (no originalName in its model) sees the new name", async () => {
    const { rename } = setup();
    const wire = JSON.parse(JSON.stringify(result(await rename("Cart bug"))));
    const OldSession = SessionSchema.omit({ originalName: true });
    const old = OldSession.parse(wire);
    expect(old.name).toBe("Cart bug");
    expect("originalName" in old).toBe(false);
  });

  test("the frames.json renamed-session reply decodes as a Session with originalName", () => {
    const frames = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../protocol/fixtures/frames.json"), "utf8"),
    ) as { type: string; id?: number; result?: unknown }[];
    const reply = frames.find((f) => f.type === "rpc" && f.id === 4);
    const s = SessionSchema.parse(reply?.result);
    expect(s.name).toBe("Cart bug");
    expect(s.originalName).toBe("web-shop");
  });

  test("push titles use the phone's name, then Claude Code's after a clear, then the folder", async () => {
    const { db, events, registry, broker, rename } = setup();
    db.query(
      "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_key) VALUES ('ios', 'iPhone', 'h', 0, ?, 'sandbox', ?)",
    ).run("a".repeat(64), TEST_PUSH_KEY);
    const titles: string[] = [];
    const apns = {
      send: async (_t: string, _e: string, payload: object) => {
        titles.push(sealedTitle(payload));
        return { status: 200 };
      },
    };
    const presence = { get: () => ({ mode: "auto", present: false, idleSeconds: 0, locked: false }) };
    const notifier = new Notifier(db, events, presence as never, registry, broker, { apns } as never);
    notifier.start();
    const ask = async () => {
      broker.open({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
      await Bun.sleep(20);
    };
    await rename("Cart bug");
    await ask();
    await rename(null);
    await ask();
    registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    result(await rename("Temp", "s2"));
    result(await rename(null, "s2"));
    broker.open({ session_id: "s2", tool_name: "Bash", tool_input: { command: "ls" } });
    await Bun.sleep(20);
    notifier.stop();
    expect(titles).toEqual([
      "Cart bug wants to run Bash",
      "claude-name wants to run Bash",
      "api wants to run Bash",
    ]);
  });
});

describe("session-rename: privacy", () => {
  test("the audit row has the actor, session and length only, for any text", async () => {
    const { rename, auditRows } = setup();
    const names = ["Secret 🚀 project", "  Ünïcödé  ", "<script>alert(1)</script>"];
    for (const n of names) await rename(n);
    await rename(null);
    const rows = auditRows();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.actor).toBe("device:phone-a");
      expect(Object.keys(JSON.parse(r.detail)).sort()).toEqual(["chars", "sessionId"]);
    }
    const all = JSON.stringify(rows);
    for (const n of names) expect(all).not.toContain(n.trim());
    expect(all).not.toContain("Secret");
    expect(all).not.toContain("script");
    // The length is of the trimmed name.
    expect(JSON.parse(rows[1]?.detail ?? "{}").chars).toBe("Ünïcödé".length);
    expect(JSON.parse(rows[3]?.detail ?? "{}").chars).toBe(0);
  });

  test("a refused rename leaves no audit row", async () => {
    const { rename, auditRows } = setup();
    await rename("x".repeat(61));
    await rename("a\nb");
    await rename("x", "nope");
    expect(auditRows()).toHaveLength(0);
  });
});

describe("session-rename: migration 6", () => {
  test("a database from before migration 6 gains custom_name and keeps its sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mig-"));
    const path = join(dir, "relay.db");
    try {
      // Build a version-5 database: the current schema minus custom_name (6) and pinned_at (7).
      let db = openDb(path);
      db.query(
        "INSERT INTO sessions (id, name, cwd, project, started_at, updated_at) VALUES ('old', 'claude-old', '/p/x', 'x', 1, 2)",
      ).run();
      db.exec(
        "ALTER TABLE turns DROP COLUMN messages_json; ALTER TABLE turns DROP COLUMN steps_json; ALTER TABLE turns DROP COLUMN stopped; ALTER TABLE sessions DROP COLUMN pinned_at; ALTER TABLE sessions DROP COLUMN custom_name; PRAGMA user_version = 5;",
      );
      db.close();

      db = openDb(path);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
        SCHEMA_VERSION,
      );
      const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("custom_name");
      const registry = new Registry(db, new EventLog(db));
      const s = registry.get("old");
      expect(s?.name).toBe("claude-old");
      expect(s && "originalName" in publicSession(s)).toBe(false);
      expect(registry.rename("old", "Renamed")?.name).toBe("Renamed");
      db.close();

      // Opening again doesn't re-run it, and the name is still there.
      db = openDb(path);
      expect(new Registry(db, new EventLog(db)).get("old")?.name).toBe("Renamed");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

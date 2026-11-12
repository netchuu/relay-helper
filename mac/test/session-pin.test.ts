import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RelayEvent, type Session, Session as SessionSchema } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import { pinnedFirst, publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps, type RpcOutcome } from "../src/daemon/rpc.ts";

// Pinning a session from a phone, edge cases: odd inputs, state, reconcile, restarts, two phones at once, older apps.
// The basics (pin/unpin, twice, touch, ended/resumed, audit, pinnedFirst, migration 7) are in pin.test.ts.

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const presence = { get: () => ({ mode: "auto", present: false, idleSeconds: 0, locked: false }) };
  const broker = { listOpen: () => [] };
  const upserts: Session[] = [];
  events.subscribe((e) => {
    if (e.type === "session.upsert") upserts.push(e.session);
  });
  const rpc = createRpc({ db, events, registry, broker, presence } as unknown as RpcDeps);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", name: "claude-name" });
  upserts.length = 0;
  const pin = (sessionId: unknown, pinned: unknown, actor = "device:phone-a") =>
    rpc("session.pin", { sessionId, pinned }, actor);
  const auditRows = () =>
    db.query("SELECT actor, detail FROM audit WHERE action = 'session.pin' ORDER BY id").all() as {
      actor: string;
      detail: string;
    }[];
  const row = (id = "s1") => registry.get(id) as SessionRecord;
  return { db, events, registry, rpc, pin, upserts, auditRows, row };
}

const result = (o: RpcOutcome) => {
  if (!("result" in o)) throw new Error(`expected a result, got ${JSON.stringify(o.error)}`);
  return o.result as Session;
};
const errorCode = (o: RpcOutcome) => ("error" in o ? o.error.code : "ok");

describe("session-pin: inputs", () => {
  test("an empty, spaces-only or padded session ID is not_found, with no event and no audit", async () => {
    const { pin, upserts, auditRows, row } = setup();
    for (const id of ["", "   ", "\t", " s1", "s1 ", "S1", "s1\n"]) {
      expect(errorCode(await pin(id, true))).toBe("not_found");
    }
    expect(upserts).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
    expect(row().pinnedAt).toBeUndefined();
  });

  test("an ID that looks like SQL, a LIKE wildcard, markup, RTL, emoji or 10,000 characters is just an unknown ID", async () => {
    const { pin, db, upserts } = setup();
    for (const id of [
      "'; UPDATE sessions SET pinned_at = 1; --",
      "s%",
      "_1",
      "<script>alert(1)</script>",
      "جلسة",
      "🚀",
      "x".repeat(10_000),
    ]) {
      expect(errorCode(await pin(id, true))).toBe("not_found");
    }
    expect(upserts).toHaveLength(0);
    const pinned = db.query("SELECT COUNT(*) AS n FROM sessions WHERE pinned_at IS NOT NULL").get() as {
      n: number;
    };
    expect(pinned.n).toBe(0);
  });

  test("pinned as null, a string, a number, an array or an object is bad_request and changes nothing", async () => {
    const { pin, upserts, auditRows, row } = setup();
    for (const pinned of [null, "true", "false", 1, 0, [], {}, "yes"]) {
      expect(errorCode(await pin("s1", pinned))).toBe("bad_request");
    }
    expect(upserts).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
    expect(row().pinnedAt).toBeUndefined();
  });

  test("a missing, null or numeric sessionId is bad_request", async () => {
    const { rpc, pin } = setup();
    expect(errorCode(await rpc("session.pin", { pinned: true }, "device:a"))).toBe("bad_request");
    expect(errorCode(await pin(null, true))).toBe("bad_request");
    expect(errorCode(await pin(1, true))).toBe("bad_request");
  });

  test("no params, null params or an array is bad_request", async () => {
    const { rpc } = setup();
    for (const params of [undefined, null, [], ["s1", true], "s1"]) {
      expect(errorCode(await rpc("session.pin", params, "device:a"))).toBe("bad_request");
    }
  });

  test("an extra parameter from a newer phone is ignored, not refused", async () => {
    const { rpc } = setup();
    const r = await rpc("session.pin", { sessionId: "s1", pinned: true, color: "red" }, "device:a");
    expect(typeof result(r).pinnedAt).toBe("number");
  });

  test('an older helper\'s answer to a misspelt method is bad_request with "unknown method"', async () => {
    const { rpc } = setup();
    const r = await rpc("session.pinn", { sessionId: "s1", pinned: true }, "device:a");
    expect("error" in r && r.error.code).toBe("bad_request");
    expect("error" in r && r.error.message).toContain("unknown method");
  });

  test("an ended session can be unpinned too, and the reply says ended without pinnedAt", async () => {
    const { pin, registry } = setup();
    await pin("s1", true);
    registry.setStatus("s1", "ended");
    const r = result(await pin("s1", false));
    expect(r.status).toBe("ended");
    expect("pinnedAt" in r).toBe(false);
  });
});

describe("session-pin: state", () => {
  test("the RPC's pinnedAt is a whole number of ms taken at the call", async () => {
    const { pin } = setup();
    const before = Date.now();
    const at = result(await pin("s1", true)).pinnedAt as number;
    const after = Date.now();
    expect(Number.isInteger(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  test("pin, unpin, pin again takes a new pin time, so it goes back to the top", async () => {
    const { pin } = setup();
    const first = result(await pin("s1", true)).pinnedAt as number;
    await pin("s1", false);
    await Bun.sleep(5);
    const second = result(await pin("s1", true)).pinnedAt as number;
    expect(second).toBeGreaterThan(first);
  });

  test("pinning twice over the RPC keeps the first time, and both replies agree", async () => {
    const { pin } = setup();
    const a = result(await pin("s1", true));
    await Bun.sleep(5);
    const b = result(await pin("s1", true));
    expect(b.pinnedAt).toBe(a.pinnedAt as number);
  });

  test("neither pinning nor unpinning changes updatedAt, status, name or anything else the phone shows", async () => {
    const { pin, registry, row } = setup();
    registry.setStatus("s1", "waiting", { title: "Fix the cart", lastSummary: "Done" });
    const before = publicSession(row());
    await Bun.sleep(5);
    const pinned = result(await pin("s1", true));
    const { pinnedAt, ...rest } = pinned;
    expect(typeof pinnedAt).toBe("number");
    expect(rest).toEqual(before);
    await Bun.sleep(5);
    expect(result(await pin("s1", false))).toEqual(before);
  });

  test("exactly one session.upsert per successful call, matching the reply, even when nothing changed", async () => {
    const { pin, upserts } = setup();
    const replies: Session[] = [];
    for (const p of [true, true, false, false]) {
      replies.push(result(await pin("s1", p)));
      expect(upserts).toHaveLength(replies.length);
      expect(upserts.at(-1)).toEqual(replies.at(-1) as Session);
    }
  });

  test("the reply parses as a Session, and the upsert as a RelayEvent", async () => {
    const { pin, events } = setup();
    const r = result(await pin("s1", true));
    expect(SessionSchema.parse(r)).toEqual(r);
    const last = events.since(0).at(-1);
    expect(RelayEvent.parse(last).type).toBe("session.upsert");
  });

  test("a pinned session still leaks no socket token, pid or transcript path", async () => {
    const { registry, pin } = setup();
    // An ID of its own: other test files keep module-level state (live steps, reply routes) keyed by "s1".
    const id = `pin-leak-${crypto.randomUUID()}`;
    registry.touch(id, {
      cwd: "/Users/me/Projects/web-shop",
      transcript: "/Users/me/.claude/x.jsonl",
      env: {
        claudePid: 4242,
        socket: "/tmp/s.sock",
        token: "secret-token",
        tmux: "/tmp/tmux,1,2",
        tmuxPane: "%1",
      },
    });
    const pinned = result(await pin(id, true));
    const unpinned = result(await pin(id, false));
    const forbidden = [
      "socketToken",
      "socketPath",
      "pid",
      "tmuxPane",
      "tmuxSocket",
      "transcript",
      "ptyToken",
      "ptySocket",
    ];
    for (const r of [pinned, unpinned]) {
      const text = JSON.stringify(r);
      for (const secret of ["secret-token", "/tmp/s.sock", "x.jsonl", "%1", "/tmp/tmux"])
        expect(text).not.toContain(secret);
      // The pid as a value of its own: "4242" alone also turns up inside a millisecond timestamp now and then.
      expect(text).not.toMatch(/[:"]4242[,"}]/);
      for (const key of forbidden) expect(r).not.toHaveProperty(key);
      // Every key is one the protocol's Session declares.
      for (const key of Object.keys(r)) expect(Object.keys(SessionSchema.shape)).toContain(key);
    }
    // Pinning adds pinnedAt and nothing else. Optional live fields that other features may add at any moment
    // (step, replyRoute) are left out of the comparison.
    const live = new Set(["step", "replyRoute"]);
    const keys = (r: Session) =>
      Object.keys(r)
        .filter((k) => !live.has(k))
        .sort();
    expect(keys(pinned)).toEqual([...keys(unpinned), "pinnedAt"].sort());
  });

  test("a rename, a rename cleared and Claude Code's own new name all leave the pin alone", async () => {
    const { rpc, pin, registry, row } = setup();
    const at = result(await pin("s1", true)).pinnedAt;
    await rpc("session.rename", { sessionId: "s1", name: "Cart bug" }, "device:a");
    expect(row().pinnedAt).toBe(at as number);
    await rpc("session.rename", { sessionId: "s1", name: null }, "device:a");
    registry.touch("s1", { name: "claude-new-name" });
    expect(publicSession(row())).toMatchObject({ name: "claude-new-name", pinnedAt: at });
  });

  test("a status change from a hook (working, waiting, idle) leaves the pin alone", async () => {
    const { pin, registry, row } = setup();
    const at = result(await pin("s1", true)).pinnedAt;
    for (const s of ["working", "waiting", "idle"] as const) {
      registry.setStatus("s1", s, { lastSummary: s });
      expect(row().pinnedAt).toBe(at as number);
    }
  });

  test("the sync snapshot keeps its order (most recently updated first), not pinned first", async () => {
    const { pin, registry, rpc } = setup();
    await Bun.sleep(5);
    registry.touch("s2", { cwd: "/p/two" });
    await Bun.sleep(5);
    registry.touch("s3", { cwd: "/p/three" });
    await pin("s1", true);
    const sync = (await rpc("sync", { sinceSeq: 0 }, "device:a")) as {
      result: { snapshot: { sessions: Session[] } };
    };
    const ids = sync.result.snapshot.sessions.map((s) => s.id);
    expect(ids).toEqual(["s3", "s2", "s1"]);
    expect(sync.result.snapshot.sessions.find((s) => s.id === "s1")?.pinnedAt).toBeNumber();
    const listed = (await rpc("sessions.list", {}, "device:a")) as { result: Session[] };
    expect(listed.result.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
  });

  test("a phone catching up with sync since its last seq gets the pin's upsert", async () => {
    const { pin, rpc, events, registry } = setup();
    registry.setStatus("s1", "working"); // the phone has seen this event
    const since = events.latestSeq();
    expect(since).toBeGreaterThan(0);
    await pin("s1", true);
    const sync = (await rpc("sync", { sinceSeq: since }, "device:a")) as { result: { events: RelayEvent[] } };
    const up = sync.result.events.find((e) => e.type === "session.upsert");
    expect(up?.type === "session.upsert" && typeof up.session.pinnedAt).toBe("number");
  });

  test("an ended pinned session is out of sync and sessions.list, but in sessions.list with includeEnded", async () => {
    const { pin, registry, rpc } = setup();
    await pin("s1", true);
    registry.setStatus("s1", "ended");
    const sync = (await rpc("sync", { sinceSeq: 0 }, "device:a")) as {
      result: { snapshot: { sessions: Session[] } };
    };
    expect(sync.result.snapshot.sessions.find((s) => s.id === "s1")).toBeUndefined();
    const list = (await rpc("sessions.list", {}, "device:a")) as { result: Session[] };
    expect(list.result.find((s) => s.id === "s1")).toBeUndefined();
    const all = (await rpc("sessions.list", { includeEnded: true }, "device:a")) as { result: Session[] };
    expect(all.result.find((s) => s.id === "s1")?.pinnedAt).toBeNumber();
  });
});

describe("session-pin: reconcile with claude agents", () => {
  function stubClaude(dir: string) {
    const bin = join(dir, "claude");
    const file = join(dir, "agents.json");
    writeFileSync(bin, `#!/bin/sh\ncat "${file}"\n`);
    chmodSync(bin, 0o755);
    return {
      bin,
      set: (list: object[]) => writeFileSync(file, JSON.stringify(list)),
    };
  }

  test("a session that leaves claude agents ends but keeps its pin; when it's listed again it's back pinned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-pin-rec-"));
    try {
      const { pin, registry, row, upserts } = setup();
      const claude = stubClaude(dir);
      const live = {
        sessionId: "s1",
        cwd: "/Users/me/Projects/web-shop",
        status: "idle",
        name: "claude-name",
      };
      claude.set([live]);
      await registry.reconcile(claude.bin);
      const at = result(await pin("s1", true)).pinnedAt;
      await registry.reconcile(claude.bin);
      expect(row().pinnedAt).toBe(at as number);

      claude.set([]);
      await registry.reconcile(claude.bin);
      expect(row().status).toBe("ended");
      expect(row().pinnedAt).toBe(at as number);

      upserts.length = 0;
      claude.set([{ ...live, status: "busy", name: "claude-renamed" }]);
      await registry.reconcile(claude.bin);
      expect(row().status).not.toBe("ended");
      expect(row().pinnedAt).toBe(at as number);
      // The phones hear it come back pinned.
      expect(upserts.at(-1)?.pinnedAt).toBe(at as number);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without claude agents, the process sweep ending a session keeps its pin", async () => {
    const { pin, registry, row } = setup();
    registry.touch("s1", { env: { claudePid: 2 ** 22 + 12345 } });
    const at = result(await pin("s1", true)).pinnedAt;
    await registry.reconcile("/nonexistent/claude");
    expect(row().status).toBe("ended");
    expect(row().pinnedAt).toBe(at as number);
  });
});

describe("session-pin: restart and migrations", () => {
  test("a pin survives closing and reopening the database, and the version doesn't move", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-pin-restart-"));
    const path = join(dir, "relay.db");
    try {
      let db = openDb(path);
      const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      let registry = new Registry(db, new EventLog(db));
      registry.touch("s1", { cwd: "/p/a" });
      registry.pin("s1", true, 1234);
      db.close();
      db = openDb(path);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
      registry = new Registry(db, new EventLog(db));
      expect(registry.get("s1")?.pinnedAt).toBe(1234);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh database has pinned_at, and a pin and a rename both survive a restart", () => {
    // Migration 7 on a version-6 database is in pin.test.ts; this doesn't hard-code the version, so later
    // migrations don't break it.
    const dir = mkdtempSync(join(tmpdir(), "relay-pin-mig-"));
    const path = join(dir, "relay.db");
    try {
      let db = openDb(path);
      expect(
        (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBeGreaterThanOrEqual(7);
      const cols = (db.query("PRAGMA table_info(sessions)").all() as { name: string; type: string }[]).find(
        (c) => c.name === "pinned_at",
      );
      expect(cols?.type).toBe("INTEGER");
      let registry = new Registry(db, new EventLog(db));
      registry.touch("old", { cwd: "/p/x", name: "claude-old" });
      registry.rename("old", "Mine");
      registry.pin("old", true, 77);
      db.close();
      db = openDb(path);
      registry = new Registry(db, new EventLog(db));
      expect(publicSession(registry.get("old") as SessionRecord)).toMatchObject({
        name: "Mine",
        originalName: "claude-old",
        pinnedAt: 77,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session-pin: concurrency", () => {
  test("two phones pinning at once get the same pin time, both audited, both published", async () => {
    const { pin, upserts, auditRows } = setup();
    const [a, b] = await Promise.all([pin("s1", true, "device:a"), pin("s1", true, "device:b")]);
    expect(result(a).pinnedAt).toBe(result(b).pinnedAt as number);
    expect(upserts).toHaveLength(2);
    expect(
      auditRows()
        .map((r) => r.actor)
        .sort(),
    ).toEqual(["device:a", "device:b"]);
  });

  test("one phone pins while the other unpins: the last call wins and its reply matches the state", async () => {
    const { pin, row } = setup();
    await pin("s1", true, "device:a");
    const off = result(await pin("s1", false, "device:b"));
    expect("pinnedAt" in off).toBe(false);
    expect(row().pinnedAt).toBeUndefined();
  });
});

describe("session-pin: compatibility", () => {
  test("Session accepts pinnedAt absent, null or a number, and refuses a string or a boolean", () => {
    const base = publicSession(setup().row());
    expect(SessionSchema.safeParse(base).success).toBe(true);
    expect(SessionSchema.safeParse({ ...base, pinnedAt: null }).success).toBe(true);
    expect(SessionSchema.safeParse({ ...base, pinnedAt: 1793620000000 }).success).toBe(true);
    expect(SessionSchema.safeParse({ ...base, pinnedAt: "1793620000000" }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...base, pinnedAt: true }).success).toBe(false);
  });

  test("an older app's Session (no pinnedAt) still decodes a pinned session", () => {
    const Old = SessionSchema.omit({ pinnedAt: true });
    const { registry, row } = setup();
    registry.pin("s1", true, 5);
    expect(Old.safeParse(publicSession(row())).success).toBe(true);
  });

  test("frames.json: only the reply with id 5 carries pinnedAt, and it decodes as a pinned Session", () => {
    const frames = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../protocol/fixtures/frames.json"), "utf8"),
    ) as { type: string; id?: number; result?: unknown }[];
    const withPin = frames.filter((f) => JSON.stringify(f).includes("pinnedAt"));
    expect(withPin).toHaveLength(1);
    expect(withPin[0]).toMatchObject({ type: "rpc", id: 5 });
    expect(frames.indexOf(withPin[0] as never)).toBe(6);
    const s = SessionSchema.parse(withPin[0]?.result);
    expect(typeof s.pinnedAt).toBe("number");
  });
});

describe("session-pin: security and privacy", () => {
  test("the audit row says who and what for pin and unpin, and nothing else", async () => {
    const { pin, auditRows } = setup();
    await pin("s1", true, "device:a");
    await pin("s1", false, "device:b");
    const rows = auditRows();
    expect(rows.map((r) => r.actor)).toEqual(["device:a", "device:b"]);
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { sessionId: "s1", pinned: true },
      { sessionId: "s1", pinned: false },
    ]);
  });

  test("a failed pin (unknown session or bad params) leaves no audit row", async () => {
    const { pin, auditRows } = setup();
    await pin("nope", true);
    await pin("s1", "yes");
    expect(auditRows()).toHaveLength(0);
  });

  test("a pin's session.upsert is never a push", async () => {
    const { pin, events } = setup();
    await pin("s1", true);
    await pin("s1", false);
    for (const e of events.since(0)) expect(alertFor(e, () => "x")).toBeNull();
  });

  test("relay sessions' order helper doesn't change its input and keeps equal pin times stable", () => {
    const list = [{ id: "a", pinnedAt: 5 }, { id: "b", pinnedAt: 5 }, { id: "c" }];
    const copy = structuredClone(list);
    expect(pinnedFirst(list).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(list).toEqual(copy);
  });
});

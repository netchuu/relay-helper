import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RelayEvent, Session } from "../../protocol/index.ts";

/**
 * Pinning a session over the real daemon: two paired phones, a revoked one, a restart, a session that
 * leaves `claude agents` and comes back, and `relay sessions`. Like integration.test.ts, the home lives under a
 * short /tmp path for the Unix socket limit, and `claude` is a stub that prints a JSON file.
 */
const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const HOME = join(ROOT, `relay-pin-${process.pid}`);
const PORT = 20000 + ((process.pid + 13331) % 20000);
const APP = `http://127.0.0.1:${PORT}`;
const REPO = resolve(import.meta.dir, "../..");
const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "debug" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}
const SOCK = join(HOME, "hook.sock");
const A = "pin-sess-aaaa";
const B = "pin-sess-bbbb";
const C = "pin-sess-cccc";
let daemon: ReturnType<typeof Bun.spawn> | null = null;

type Live = { sessionId: string; cwd: string; status: string; name: string };
const live = (id: string, name: string): Live => ({ sessionId: id, cwd: REPO, status: "idle", name });
const agents = (list: Live[]) => writeFileSync(join(HOME, "agents.json"), JSON.stringify(list));

async function admin<T>(method: string, params: object = {}): Promise<T> {
  const res = await fetch("http://relay/admin/rpc", {
    method: "POST",
    unix: SOCK,
    body: JSON.stringify({ method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting");
}

async function startDaemon() {
  daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(() => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok));
}

async function stopDaemon() {
  daemon?.kill();
  await daemon?.exited;
  daemon = null;
}

async function pair(deviceName: string) {
  const { code } = (await fetch("http://relay/admin/pair", { method: "POST", unix: SOCK }).then((r) =>
    r.json(),
  )) as { code: string };
  return (await fetch(`${APP}/pair`, { method: "POST", body: JSON.stringify({ code, deviceName }) }).then(
    (r) => r.json(),
  )) as { token: string; deviceId: string };
}

type Frame = { type: string; id?: number; result?: unknown; error?: { code: string }; event?: RelayEvent };

async function phone(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  } as never);
  const frames: Frame[] = [];
  ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
  await new Promise((r) => (ws.onopen = r));
  let next = 100;
  const send = (method: string, params: object) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  };
  const reply = (id: number) => waitFor(async () => frames.find((f) => f.type === "rpc" && f.id === id));
  const call = (method: string, params: object) => reply(send(method, params));
  const upserts = (id: string) =>
    frames
      .filter((f) => f.event?.type === "session.upsert")
      .map((f) => (f.event as { session: Session }).session)
      .filter((s) => s.id === id);
  return { ws, frames, send, reply, call, upserts };
}

const httpRpc = (token: string | null, method: string, params: object) =>
  fetch(`${APP}/rpc`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ method, params }),
  });

async function cli(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

const listed = async (id: string, includeEnded = false) =>
  (await admin<Session[]>("sessions.list", { includeEnded })).find((s) => s.id === id);

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const claude = join(HOME, "claude");
  writeFileSync(claude, `#!/bin/sh\ncat "${join(HOME, "agents.json")}"\n`);
  chmodSync(claude, 0o755);
  agents([live(A, "alpha-sess"), live(B, "bravo-sess"), live(C, "charlie-sess")]);
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: PORT, claudeBin: claude, preferTyping: false }),
  );
  await startDaemon();
  await waitFor(async () => (await admin<Session[]>("sessions.list")).length === 3);
});

afterAll(async () => {
  await stopDaemon();
  rmSync(HOME, { recursive: true, force: true });
});

describe("session pin over the real daemon", () => {
  let a: { token: string; deviceId: string };
  let b: { token: string; deviceId: string };

  test("a pin from one phone reaches both phones as session.upsert with the reply's pinnedAt", async () => {
    a = await pair("Phone A");
    b = await pair("Phone B");
    const pa = await phone(a.token);
    const pb = await phone(b.token);
    const before = (await listed(A))?.updatedAt;
    const r = await pa.call("session.pin", { sessionId: A, pinned: true });
    const s = r.result as Session;
    expect(typeof s.pinnedAt).toBe("number");
    expect(s.updatedAt).toBe(before as number);
    for (const p of [pa, pb]) {
      const up = await waitFor(async () => p.upserts(A).find((u) => u.pinnedAt != null));
      expect(up.pinnedAt).toBe(s.pinnedAt as number);
    }
    const sync = await pb.call("sync", { sinceSeq: 0 });
    const snap = (sync.result as { snapshot: { sessions: Session[] } }).snapshot.sessions;
    expect(snap.find((x) => x.id === A)?.pinnedAt).toBe(s.pinnedAt as number);
    expect(snap.filter((x) => x.id !== A).every((x) => !("pinnedAt" in x))).toBe(true);
    pa.ws.close();
    pb.ws.close();
  });

  test("two phones pinning the same session at once both get the same pin time", async () => {
    const pa = await phone(a.token);
    const pb = await phone(b.token);
    const [ia, ib] = [
      pa.send("session.pin", { sessionId: B, pinned: true }),
      pb.send("session.pin", { sessionId: B, pinned: true }),
    ];
    const [ra, rb] = await Promise.all([pa.reply(ia), pb.reply(ib)]);
    expect((ra.result as Session).pinnedAt).toBe((rb.result as Session).pinnedAt as number);
    pa.ws.close();
    pb.ws.close();
  });

  test("over HTTPS /rpc: bad params are bad_request, an unknown ID not_found", async () => {
    const bad = (await httpRpc(b.token, "session.pin", { sessionId: C, pinned: "true" }).then((r) =>
      r.json(),
    )) as {
      error: { code: string };
    };
    expect(bad.error.code).toBe("bad_request");
    const gone = (await httpRpc(b.token, "session.pin", { sessionId: "gone", pinned: true }).then((r) =>
      r.json(),
    )) as {
      error: { code: string };
    };
    expect(gone.error.code).toBe("not_found");
    expect(await listed(C)).not.toHaveProperty("pinnedAt");
  });

  test("no token, a wrong token or a revoked phone can't pin", async () => {
    expect((await httpRpc(null, "session.pin", { sessionId: C, pinned: true })).status).toBe(401);
    expect((await httpRpc("x".repeat(43), "session.pin", { sessionId: C, pinned: true })).status).toBe(401);
    const c = await pair("Phone C");
    await fetch("http://relay/admin/devices/revoke", {
      method: "POST",
      unix: SOCK,
      body: JSON.stringify({ id: c.deviceId }),
    });
    expect((await httpRpc(c.token, "session.pin", { sessionId: C, pinned: true })).status).toBe(401);
    expect(await listed(C)).not.toHaveProperty("pinnedAt");
  });

  test("relay sessions lists pinned first, newest pin first, with (pinned) at the end of the line", async () => {
    // B was pinned after A, so B comes first.
    const out = (await cli("sessions")).trim().split("\n");
    expect(out).toHaveLength(3);
    expect(out[0]).toContain(B.slice(0, 8));
    expect(out[1]).toContain(A.slice(0, 8));
    expect(out[2]).toContain(C.slice(0, 8));
    expect(out[0]?.endsWith("(pinned)")).toBe(true);
    expect(out[1]?.endsWith("(pinned)")).toBe(true);
    expect(out[2]).not.toContain("(pinned)");
  });

  test("there is no relay pin command: it prints the usage and pins nothing", async () => {
    await cli("pin", C);
    expect(await listed(C)).not.toHaveProperty("pinnedAt");
  });

  test("the pin survives a restart", async () => {
    const at = (await listed(A))?.pinnedAt;
    await stopDaemon();
    await startDaemon();
    expect((await waitFor(async () => listed(A)))?.pinnedAt).toBe(at as number);
  });

  test("a session that leaves claude agents ends, drops out of sync, stays pinned in relay sessions --all, and comes back pinned", async () => {
    const at = (await listed(A))?.pinnedAt as number;
    const pb = await phone(b.token);
    agents([live(B, "bravo-sess"), live(C, "charlie-sess")]);
    await stopDaemon(); // the reconcile runs at start-up
    await startDaemon();
    await waitFor(async () => (await listed(A, true))?.status === "ended");
    expect(await listed(A)).toBeUndefined();
    const all = (await cli("sessions", "--all")).split("\n").find((l) => l.includes(A.slice(0, 8)));
    expect(all?.endsWith("(pinned)")).toBe(true);
    pb.ws.close();

    const pa = await phone(a.token);
    const sync = await pa.call("sync", { sinceSeq: 0 });
    expect(
      (sync.result as { snapshot: { sessions: Session[] } }).snapshot.sessions.find((s) => s.id === A),
    ).toBeUndefined();

    agents([live(A, "alpha-sess"), live(B, "bravo-sess"), live(C, "charlie-sess")]);
    // The next 20 s reconcile would bring it back; a restart does it now. The phone hears it on reconnect.
    pa.ws.close();
    await stopDaemon();
    await startDaemon();
    const back = await waitFor(async () => {
      const s = await listed(A);
      return s && s.status !== "ended" ? s : null;
    });
    expect(back.pinnedAt).toBe(at);
  });

  test("an ended session can be unpinned from a phone, and unpinning twice still answers", async () => {
    agents([live(B, "bravo-sess"), live(C, "charlie-sess")]);
    await stopDaemon();
    await startDaemon();
    await waitFor(async () => (await listed(A, true))?.status === "ended");
    const pa = await phone(a.token);
    for (let i = 0; i < 2; i++) {
      const r = await pa.call("session.pin", { sessionId: A, pinned: false });
      expect((r.result as Session).status).toBe("ended");
      expect(r.result as Session).not.toHaveProperty("pinnedAt");
    }
    pa.ws.close();
  });

  test("the audit table has one row per successful pin, with the device and { sessionId, pinned }", async () => {
    await stopDaemon();
    const db = new Database(join(HOME, "relay.db"), { readonly: true });
    const rows = db
      .query("SELECT actor, detail FROM audit WHERE action = 'session.pin' ORDER BY id")
      .all() as {
      actor: string;
      detail: string;
    }[];
    db.close();
    // A pinned by Phone A, B by both phones, A unpinned twice; refused and unauthorised calls leave no row.
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { sessionId: A, pinned: true },
      { sessionId: B, pinned: true },
      { sessionId: B, pinned: true },
      { sessionId: A, pinned: false },
      { sessionId: A, pinned: false },
    ]);
    expect(rows[0]?.actor).toContain(a.deviceId);
    expect(rows.map((r) => r.actor).some((x) => x.includes(b.deviceId))).toBe(true);
  });
});

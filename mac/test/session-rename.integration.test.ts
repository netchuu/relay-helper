import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RelayEvent, Session } from "../../protocol/index.ts";

/**
 * Renaming a session over the real daemon: two paired phones, a revoked one, a restart and a
 * `claude agents` reconcile. Like integration.test.ts, the home lives under a short /tmp path for the Unix
 * socket limit, and `claude` is a stub that prints a JSON file, so no real session is ever touched.
 */
const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const HOME = join(ROOT, `relay-rn-${process.pid}`);
const PORT = 20000 + ((process.pid + 7777) % 20000);
const APP = `http://127.0.0.1:${PORT}`;
const REPO = resolve(import.meta.dir, "../..");
const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "debug" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}
const SOCK = join(HOME, "hook.sock");
const SID = "rename-sess-1";
let daemon: ReturnType<typeof Bun.spawn> | null = null;
/** Everything the daemons wrote to stderr (their log, at debug level), across restarts. */
const logs: Promise<string>[] = [];

const agents = (name: string) =>
  writeFileSync(
    join(HOME, "agents.json"),
    JSON.stringify([{ sessionId: SID, cwd: REPO, status: "idle", name }]),
  );

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
    stderr: "pipe",
  });
  logs.push(new Response(daemon.stderr as ReadableStream).text());
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
  return (await fetch(`${APP}/pair`, {
    method: "POST",
    body: JSON.stringify({ code, deviceName }),
  }).then((r) => r.json())) as { token: string; deviceId: string };
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
  const call = async (method: string, params: object) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return waitFor(async () => frames.find((f) => f.type === "rpc" && f.id === id));
  };
  const upserts = () =>
    frames
      .filter((f) => f.event?.type === "session.upsert")
      .map((f) => (f.event as { session: Session }).session)
      .filter((s) => s.id === SID);
  return { ws, frames, call, upserts };
}

const httpRpc = (token: string | null, method: string, params: object) =>
  fetch(`${APP}/rpc`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ method, params }),
  });

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const claude = join(HOME, "claude");
  writeFileSync(claude, `#!/bin/sh\ncat "${join(HOME, "agents.json")}"\n`);
  chmodSync(claude, 0o755);
  agents("claude-one");
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: PORT, claudeBin: claude, preferTyping: false }),
  );
  await startDaemon();
  // The first reconcile runs at start-up and imports the session from `claude agents`.
  await waitFor(async () => (await admin<Session[]>("sessions.list")).find((s) => s.id === SID));
});

afterAll(async () => {
  await stopDaemon();
  rmSync(HOME, { recursive: true, force: true });
});

describe("session rename over the real daemon", () => {
  let a: { token: string; deviceId: string };
  let b: { token: string; deviceId: string };

  test("a rename from one phone reaches both phones as session.upsert, and the reply comes back", async () => {
    a = await pair("Phone A");
    b = await pair("Phone B");
    const pa = await phone(a.token);
    const pb = await phone(b.token);
    const reply = await pa.call("session.rename", { sessionId: SID, name: "  Cart bug 🛒  " });
    expect((reply.result as Session).name).toBe("Cart bug 🛒");
    expect((reply.result as Session).originalName).toBe("claude-one");
    for (const p of [pa, pb]) {
      const s = await waitFor(async () => p.upserts().find((u) => u.name === "Cart bug 🛒"));
      expect(s.originalName).toBe("claude-one");
    }
    // Phone B's sync and list agree with what it was pushed.
    const sync = await pb.call("sync", { sinceSeq: 0 });
    const snap = (sync.result as { snapshot: { sessions: Session[] } }).snapshot.sessions.find(
      (s) => s.id === SID,
    );
    expect(snap?.name).toBe("Cart bug 🛒");
    expect(snap?.originalName).toBe("claude-one");
    pa.ws.close();
    pb.ws.close();
  });

  test("HTTPS /rpc renames too; bad input is a 200 with bad_request, unknown ID not_found", async () => {
    const ok = (await httpRpc(b.token, "session.rename", { sessionId: SID, name: "From B" }).then((r) =>
      r.json(),
    )) as { result: Session };
    expect(ok.result.name).toBe("From B");
    const bad = (await httpRpc(b.token, "session.rename", { sessionId: SID, name: "a\nb" }).then((r) =>
      r.json(),
    )) as { error: { code: string } };
    expect(bad.error.code).toBe("bad_request");
    const gone = (await httpRpc(b.token, "session.rename", { sessionId: "gone", name: "x" }).then((r) =>
      r.json(),
    )) as { error: { code: string } };
    expect(gone.error.code).toBe("not_found");
    expect((await admin<Session[]>("sessions.list")).find((s) => s.id === SID)?.name).toBe("From B");
  });

  test("no token, a wrong token or a revoked phone can't rename", async () => {
    expect((await httpRpc(null, "session.rename", { sessionId: SID, name: "Anon" })).status).toBe(401);
    expect((await httpRpc("x".repeat(43), "session.rename", { sessionId: SID, name: "Anon" })).status).toBe(
      401,
    );
    await fetch("http://relay/admin/devices/revoke", {
      method: "POST",
      unix: SOCK,
      body: JSON.stringify({ id: a.deviceId }),
    });
    expect((await httpRpc(a.token, "session.rename", { sessionId: SID, name: "Revoked" })).status).toBe(401);
    expect((await admin<Session[]>("sessions.list")).find((s) => s.id === SID)?.name).toBe("From B");
  });

  test("the name survives a restart, and Claude Code's new name becomes originalName", async () => {
    await stopDaemon();
    agents("claude-two");
    await startDaemon();
    const s = await waitFor(async () =>
      (await admin<Session[]>("sessions.list")).find((x) => x.id === SID && x.originalName === "claude-two"),
    );
    expect(s.name).toBe("From B");
  });

  test("relay sessions shows the phone's name", async () => {
    const proc = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "sessions"], { env, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("From B");
    expect(out).not.toContain("claude-two");
  });

  test("clearing from a phone brings back Claude Code's current name everywhere", async () => {
    const pb = await phone(b.token);
    const reply = await pb.call("session.rename", { sessionId: SID, name: null });
    expect((reply.result as Session).name).toBe("claude-two");
    expect("originalName" in (reply.result as Session)).toBe(false);
    const listed = (await admin<Session[]>("sessions.list")).find((s) => s.id === SID);
    expect(listed?.name).toBe("claude-two");
    expect(listed && "originalName" in listed).toBe(false);
    pb.ws.close();
  });

  test("the daemon log and the audit table never hold the name text", async () => {
    const db = new Database(join(HOME, "relay.db"), { readonly: true });
    const audit = JSON.stringify(db.query("SELECT * FROM audit WHERE action = 'session.rename'").all());
    db.close();
    expect(audit).toContain(b.deviceId);
    await stopDaemon();
    const log = (await Promise.all(logs)).join("\n");
    expect(log.length).toBeGreaterThan(0);
    for (const name of ["Cart bug", "From B", "Anon", "Revoked"]) {
      expect(audit).not.toContain(name);
      expect(log).not.toContain(name);
    }
  });
});

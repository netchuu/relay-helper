import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InterruptResult, RelayEvent, Session, Turn } from "../../protocol/index.ts";

/**
 * The phone's Stop over the real daemon and the real hook client, with a real tmux on a private server
 * (`tmux -S <its own socket>`, never yours) whose pane records the bytes it gets. No Claude Code runs: the test
 * plays its hooks and writes the transcript marker the way Claude Code 2.1.318 does after an Esc. The daemon gets
 * an isolated RELAY_HOME and HOME (so the transcript lives under a throwaway ~/.claude/projects), and
 * `claude` is /usr/bin/false so it never sees your sessions.
 */
const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const HOME = join(ROOT, `relay-ts-${process.pid}`);
const FAKE_HOME = join(HOME, "h");
const PORT = 20000 + ((process.pid + 7919) % 20000);
const APP = `http://127.0.0.1:${PORT}`;
const REPO = resolve(import.meta.dir, "../..");
const SOCK = join(HOME, "hook.sock");
const TMUX_SOCK = join(HOME, "tmux.sock");
const RECORDED = join(HOME, "pane-bytes");
const SID = "0f3c9a52-6b1e-4d7a-9c2f-1a2b3c4d5e6f";
const PROJECT = join(FAKE_HOME, ".claude", "projects", "relay-turn-stop");
const TRANSCRIPT = join(PROJECT, `${SID}.jsonl`);

const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env)) {
  if (
    v === undefined ||
    k.startsWith("CLAUDE") ||
    k.startsWith("ANTHROPIC") ||
    k === "TMUX" ||
    k === "TMUX_PANE"
  )
    continue;
  if (!(k in env)) env[k] = v;
}
const daemonEnv = { ...env, HOME: FAKE_HOME };
const hasTmux = Bun.which("tmux") !== null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;
let pane = "";
let tmuxEnv: Record<string, string> = {};

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
    env: daemonEnv,
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

async function tmux(...args: string[]) {
  const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, "-f", "/dev/null", ...args], {
    env: { ...env, TERM: "xterm-256color" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function runHook(event: string, fields: object = {}) {
  const proc = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
    stdin: new Blob([
      JSON.stringify({
        session_id: SID,
        hook_event_name: event,
        cwd: REPO,
        transcript_path: TRANSCRIPT,
        ...fields,
      }),
    ]),
    stdout: "pipe",
    env: { ...env, ...tmuxEnv },
  });
  await Promise.all([new Response(proc.stdout).text(), proc.exited]);
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
  const reply = (id: number, ms = 10_000) =>
    waitFor(async () => frames.find((f) => f.type === "rpc" && f.id === id), ms);
  return { ws, frames, send, reply, call: (m: string, p: object) => reply(send(m, p)) };
}

const httpRpc = (token: string | null, method: string, params: object) =>
  fetch(`${APP}/rpc`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ method, params }),
  });

const status = async (token: string) => {
  const r = (await httpRpc(token, "sessions.list", {}).then((x) => x.json())) as { result: Session[] };
  return r.result.find((s) => s.id === SID)?.status;
};
const recorded = () => (existsSync(RECORDED) ? readFileSync(RECORDED, "utf8").trim() : "");
const line = (o: object) =>
  appendFileSync(TRANSCRIPT, `${JSON.stringify({ timestamp: new Date().toISOString(), ...o })}\n`);

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true, mode: 0o700 });
  writeFileSync(TRANSCRIPT, "");
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: PORT, claudeBin: "/usr/bin/false", preferTyping: false }),
  );
  if (hasTmux) {
    // The pane's program: raw mode, every byte it gets appended as hex, one per line.
    const rec = join(HOME, "rec.ts");
    writeFileSync(
      rec,
      `import { appendFileSync } from "node:fs";
process.stdin.setRawMode(true);
process.stdin.on("data", (b) => { for (const x of b) appendFileSync(${JSON.stringify(RECORDED)}, x.toString(16).padStart(2, "0") + "\\n"); });
appendFileSync(${JSON.stringify(RECORDED)}, "");
`,
    );
    await tmux("new-session", "-d", "-s", "relaytest", "-x", "80", "-y", "20", `${process.execPath} ${rec}`);
    pane = await tmux("display-message", "-p", "-t", "relaytest", "#{pane_id}");
    const pid = await tmux("display-message", "-p", "#{pid}");
    tmuxEnv = { TMUX: `${TMUX_SOCK},${pid},0`, TMUX_PANE: pane };
    await waitFor(async () => existsSync(RECORDED));
  }
  await startDaemon();
});

afterAll(async () => {
  await stopDaemon();
  if (hasTmux) await tmux("kill-server");
  rmSync(HOME, { recursive: true, force: true });
});

describe.skipIf(!hasTmux)("turn-stop over the real daemon and a private tmux", () => {
  let a: { token: string; deviceId: string };
  let b: { token: string; deviceId: string };
  let stoppedId = "";

  test("idle and unknown sessions: conflict and not_found, and the pane gets nothing", async () => {
    a = await pair("Phone A");
    b = await pair("Phone B");
    await runHook("SessionStart");
    await waitFor(async () => (await status(a.token)) === "idle");
    const idle = (await httpRpc(a.token, "session.interrupt", { sessionId: SID }).then((r) =>
      r.json(),
    )) as Frame;
    expect(idle.error?.code).toBe("conflict");
    const gone = (await httpRpc(a.token, "session.interrupt", { sessionId: "nope" }).then((r) =>
      r.json(),
    )) as Frame;
    expect(gone.error?.code).toBe("not_found");
    await Bun.sleep(200);
    expect(recorded()).toBe("");
  });

  test("no token, a wrong token or a revoked phone can't stop anything", async () => {
    expect((await httpRpc(null, "session.interrupt", { sessionId: SID })).status).toBe(401);
    expect((await httpRpc("x".repeat(43), "session.interrupt", { sessionId: SID })).status).toBe(401);
    const c = await pair("Phone C");
    await fetch("http://relay/admin/devices/revoke", {
      method: "POST",
      unix: SOCK,
      body: JSON.stringify({ id: c.deviceId }),
    });
    expect((await httpRpc(c.token, "session.interrupt", { sessionId: SID })).status).toBe(401);
  });

  test("two phones stop a working turn: one ESC byte and no Enter in the pane, one stopped turn.done for both", async () => {
    await runHook("UserPromptSubmit", { prompt: "Count slowly to 400" });
    await waitFor(async () => (await status(a.token)) === "working");
    line({ type: "user", message: { content: "Count slowly to 400" } });
    line({ type: "assistant", message: { content: [{ type: "text", text: "1, 2, 3, 4" }] } });
    const pa = await phone(a.token);
    const pb = await phone(b.token);
    const [ia, ib] = [
      pa.send("session.interrupt", { sessionId: SID }),
      pb.send("session.interrupt", { sessionId: SID }),
    ];
    // What Claude Code does once the ESC reaches it.
    await waitFor(async () => recorded().includes("1b"));
    line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]\n" }] } });
    const [ra, rb] = await Promise.all([pa.reply(ia), pb.reply(ib)]);
    const res = ra.result as InterruptResult;
    expect(res.via).toBe("tmux");
    expect(typeof res.turnId).toBe("string");
    expect(rb.result).toEqual(res);
    await Bun.sleep(300);
    expect(recorded().split("\n")).toEqual(["1b"]);
    for (const p of [pa, pb]) {
      const done = await waitFor(async () =>
        p.frames.filter((f) => f.event?.type === "turn.done").map((f) => (f.event as { turn: Turn }).turn),
      );
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({
        id: res.turnId as string,
        stopped: true,
        failed: false,
        summary: "1, 2, 3, 4",
      });
    }
    expect(await status(a.token)).toBe("idle");
    stoppedId = res.turnId as string;
    // Tapped again once it's over: conflict, and no second ESC (two would open Claude Code's rewind menu).
    expect((await pa.call("session.interrupt", { sessionId: SID })).error?.code).toBe("conflict");
    await Bun.sleep(200);
    expect(recorded().split("\n")).toEqual(["1b"]);
    pa.ws.close();
    pb.ws.close();
  });

  test("a late Stop hook adds no second turn", async () => {
    await runHook("Stop", { last_assistant_message: "1, 2, 3, 4" });
    const r = (await httpRpc(a.token, "session.turns", { sessionId: SID, limit: 10 }).then((x) =>
      x.json(),
    )) as {
      result: Turn[];
    };
    const recordedTurns = r.result.filter((t) => !t.id.startsWith("tx:"));
    expect(recordedTurns.map((t) => t.id)).toEqual([stoppedId]);
  });

  test("audit has the route and no text; after a restart the turn still says stopped", async () => {
    await stopDaemon();
    const db = new Database(join(HOME, "relay.db"), { readonly: true });
    const rows = db.query("SELECT actor, detail FROM audit WHERE action = 'session.interrupt'").all() as {
      actor: string;
      detail: string;
    }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail as string)).toEqual({ sessionId: SID, via: "tmux", turnId: stoppedId });
    expect(rows[0]?.detail).not.toContain("Count");
    await startDaemon();
    const r = (await httpRpc(a.token, "session.turns", { sessionId: SID, limit: 10 }).then((x) =>
      x.json(),
    )) as {
      result: Turn[];
    };
    expect(r.result.find((t) => t.id === stoppedId)).toMatchObject({ stopped: true });
    // The transcript history doesn't show the marker as something you typed.
    expect(r.result.some((t) => (t.prompt ?? "").includes("[Request interrupted"))).toBe(false);
  });
});

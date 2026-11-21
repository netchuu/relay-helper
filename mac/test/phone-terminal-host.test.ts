import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { deliver, typeIntoPty } from "../src/daemon/inject.ts";
import { Registry, replyRouteOf } from "../src/daemon/registry.ts";
import { StartError, startSession } from "../src/daemon/startSession.ts";
import { hostLauncher } from "../src/daemon/terminalHost.ts";
import { hostStatePath, readHostState } from "../src/shell/ptyHost.ts";
import { opts } from "./support/terminals.ts";

// A chat started from the phone runs in a `relay host` of its own, with a stub in place of Claude Code.

const CLI = join(import.meta.dir, "../src/cli.ts");
const STUB = join(import.meta.dir, "support/stub-claude.ts");
const dirs: string[] = [];
const hosts: number[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-host-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(bin, 0o755);
  const log = join(dir, "stub.log");
  process.env.STUB_LOG = log;
  const home = join(dir, "pty");
  const launcher = hostLauncher({ dir: home, self: [process.execPath, CLI] });
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at) VALUES ('old', ?, 'proj', 'ended', 1, 2)",
  ).run(dir);
  const start = async (text?: string) => {
    const res = await startSession({
      db,
      registry,
      claudeBin: bin,
      directory: dir,
      terminal: launcher,
      readyTimeoutMs: 15_000,
      ...(text === undefined ? {} : { text }),
    });
    const session = registry.get(res.sessionId);
    if (session?.pid) hosts.push(session.pid);
    return { ...res, session: session as NonNullable<typeof session> };
  };
  const keys = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.startsWith("KEYS "))
          .map((l) => JSON.parse(l.slice(5)) as string)
          .join("")
      : "";
  const waitFor = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !check(); ) await Bun.sleep(25);
    return check();
  };
  return { dir, bin, log, home, launcher, registry, start, keys, waitFor };
}

afterEach(() => {
  for (const pid of hosts.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.STUB_LOG;
  delete process.env.STUB_REFUSE;
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("relay host", () => {
  test("runs the command directly in a terminal, with no tmux, and the session types", async () => {
    const t = setup();
    const { session } = await t.start("first message");
    expect(replyRouteOf(session)).toEqual({ replyRoute: "typed" });
    expect(session.ptySocket).toContain("h-");
    const log = readFileSync(t.log, "utf8");
    expect(log).toContain('ARGS ["--session-id"');
    expect(log).toContain('"--","first message"]');
    expect(log).toContain("TERM xterm-256color SIZE 120x40");
  });

  test("a phone message arrives as typed keys, and a slash command runs", async () => {
    const t = setup();
    const { session } = await t.start();
    expect((await deliver(session, "/model", opts)).via).toBe("pty");
    expect(await t.waitFor(() => t.keys().endsWith("\r"))).toBe(true);
    expect(t.keys()).toBe("\x1b[200~/model\x1b[201~\r");
  });

  test("text with newlines is one paste, and one ending in a semicolon stays whole", async () => {
    const t = setup();
    const { session } = await t.start();
    await deliver(session, "fix; it\nthen test;", opts);
    expect(await t.waitFor(() => t.keys().endsWith("\r"))).toBe(true);
    expect(t.keys()).toBe("\x1b[200~fix; it\nthen test;\x1b[201~\r");
  });

  test("the chat keeps running when the helper's whole process group is killed", async () => {
    const t = setup();
    const script = join(t.dir, "start-and-die.ts");
    writeFileSync(
      script,
      `import { hostLauncher } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/terminalHost.ts"))};
const l = hostLauncher({ dir: ${JSON.stringify(t.home)}, self: [process.execPath, ${JSON.stringify(CLI)}] });
const pane = await l.launch([${JSON.stringify(t.bin)}, "--session-id", "x"], ${JSON.stringify(t.dir)}, "restart1");
console.log(JSON.stringify(pane));
setInterval(() => {}, 1000);
`,
    );
    const daemon = Bun.spawn([process.execPath, script], {
      stdout: "pipe",
      env: process.env,
      detached: true,
    });
    const reader = daemon.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const pane = JSON.parse(first) as { socket: string; token: string; pid: number };
    hosts.push(pane.pid);
    process.kill(-daemon.pid, "SIGKILL");
    await daemon.exited;
    await Bun.sleep(300);
    expect(alive(pane.pid)).toBe(true);
    expect(await typeIntoPty(pane.socket, pane.token, pane.pid, "still here")).toMatchObject({ ok: true });
    expect(await t.waitFor(() => t.keys().includes("still here"))).toBe(true);
  });

  test("a host that died without a word leaves no record or socket behind", async () => {
    const t = setup();
    mkdirSync(t.home, { recursive: true });
    const record = hostStatePath(t.home, "dead1");
    const sock = join(t.home, "h-dead1.sock");
    writeFileSync(record, JSON.stringify({ socket: sock, token: "x", pid: 1, hostPid: 2 ** 22 - 1 }));
    writeFileSync(sock, "");
    await t.start();
    expect(existsSync(record)).toBe(false);
    expect(existsSync(sock)).toBe(false);
  });

  test("when Claude Code exits, the host exits and leaves no socket or record", async () => {
    const t = setup();
    const { session, sessionId } = await t.start();
    const state = readHostState(t.home, session.ptySocket?.match(/h-(\w+)\.sock/)?.[1] ?? "");
    expect(state).not.toBeNull();
    await deliver(session, "/exit", opts);
    expect(await t.waitFor(() => !alive(state?.hostPid ?? 0))).toBe(true);
    expect(existsSync(session.ptySocket as string)).toBe(false);
    expect(existsSync(hostStatePath(t.home, sessionId.slice(0, 8)))).toBe(false);
  });

  test("a refusal reaches the phone and nothing is left behind", async () => {
    const t = setup();
    process.env.STUB_REFUSE = "1";
    const err = await t.start().catch((e) => e);
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).message).toBe("Claude Code couldn't start: Workspace not trusted.");
    expect(t.registry.list().length).toBe(0);
    const leftovers = existsSync(t.home) ? Bun.spawnSync(["ls", t.home]).stdout.toString().trim() : "";
    expect(leftovers).toBe("");
  });

  test("many chats at once each have their own terminal", async () => {
    const t = setup();
    const chats = await Promise.all([t.start(), t.start(), t.start()]);
    expect(new Set(chats.map((c) => c.session.ptySocket)).size).toBe(3);
    expect(new Set(chats.map((c) => c.session.pid)).size).toBe(3);
    for (const c of chats) expect(await deliver(c.session, "hi", opts)).toMatchObject({ via: "pty" });
  });
});

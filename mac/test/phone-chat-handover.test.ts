import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import type { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Handover } from "../src/daemon/handover.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import type { TypeOps } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { type HookEnv, publicSession, Registry } from "../src/daemon/registry.ts";
import { ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { startSession } from "../src/daemon/startSession.ts";
import { hostLauncher, type TerminalLauncher, type TerminalPane } from "../src/daemon/terminalHost.ts";
import { readHostState } from "../src/shell/ptyHost.ts";
import { PROMPT } from "./support/terminals.ts";

// A chat started from the phone, then resumed in the person's own terminal: Relay's copy stops and the chat goes on there.

const CLI = join(import.meta.dir, "../src/cli.ts");
const STUB = join(import.meta.dir, "support/stub-claude.ts");
const HOST: HookEnv = { pty: "/tmp/relay-x/pty/h-abc12345.sock", ptyToken: "tok", claudePid: 4242 };
const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 5151 };
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(launcher?: TerminalLauncher, stop?: (id: string) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handover-"));
  dirs.push(dir);
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const calls: string[] = [];
  const fake: TerminalLauncher = {
    launch: async () => {
      throw new Error("not used");
    },
    look: async () => null,
    close: async (pane: TerminalPane) => void calls.push(`close ${pane.id}`),
    release: async () => {},
  };
  const handover = new Handover({
    registry,
    terminal: launcher ?? fake,
    stop: async (id) => {
      calls.push("stop");
      await stop?.(id);
    },
    openTurn: (id) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM turns WHERE session_id = ? AND ended_at IS NULL LIMIT 1",
        )
        .get(id)?.id ?? null,
  });
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: { settleFromSessionEvent: () => {}, hasOpen: () => false } as unknown as Broker,
    presence: { noteLocalActivity: () => {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    handover,
  });
  const hook = (event: string, fields: Record<string, unknown>, env: HookEnv) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: dir, ...fields }, env } as HookEnvelope,
      new AbortController().signal,
    );
  const resume = () => hook("SessionStart", { source: "resume" }, ITERM);
  const view = () => publicSession(registry.get("s1") as NonNullable<ReturnType<Registry["get"]>>);
  return { dir, db, events, registry, calls, hook, resume, view, handover };
}

function rpcFor(t: ReturnType<typeof setup>, typeOps: TypeOps) {
  return createRpc({
    db: t.db,
    events: t.events,
    registry: t.registry,
    replies: new ReplyQueue(t.db, t.events, t.registry),
    broker: { hasOpen: () => false },
    config: { preferTyping: true },
    typeOps,
    handover: t.handover,
    pauseWait: { inlineMs: 100, pollMs: 20 },
  } as unknown as RpcDeps);
}

describe("a Relay chat resumed in your own terminal", () => {
  test("stops Relay's copy, shows where it went and routes messages to the new terminal", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    await t.resume();
    expect(t.calls).toEqual(["close abc12345"]);
    const s = t.registry.get("s1");
    expect(s?.ptySocket).toBeNull();
    expect(s?.pid).toBe(5151);
    expect(s?.terminal).toBe("iTerm.app");
    const wire = Session.parse(t.view());
    expect(wire.movedToTerminal).toBe(true);
    expect(wire.terminal).toBe("iTerm.app");
    expect(wire.status).toBe("idle");
  });

  test.each(["working", "waiting"] as const)(
    "a chat that is %s is stopped before Relay's copy ends",
    async (status) => {
      const t = setup(undefined, async (id) => t.registry.setStatus(id, "idle"));
      t.registry.touch("s1", { cwd: t.dir, env: HOST });
      t.registry.setStatus("s1", status);
      await t.resume();
      expect(t.calls).toEqual(["stop", "close abc12345"]);
      expect(t.view().status).toBe("idle");
    },
  );

  test("a stop that fails still ends the copy and leaves no stale Working", async () => {
    const t = setup(undefined, async () => {
      throw new Error("no key route");
    });
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    t.registry.setStatus("s1", "working");
    await t.resume();
    expect(t.calls).toEqual(["stop", "close abc12345"]);
    expect(t.view().status).toBe("idle");
  });

  test("the copy's last hooks, including its SessionEnd, don't end the chat or bring its terminal back", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    await t.resume();
    await t.hook("Stop", {}, HOST);
    await t.hook("SessionEnd", {}, HOST);
    expect(t.view().status).toBe("idle");
    expect(t.registry.get("s1")?.ptySocket).toBeNull();
    expect(t.registry.get("s1")?.pid).toBe(5151);
    await t.hook("SessionEnd", {}, ITERM);
    expect(t.view().status).toBe("ended");
  });

  test("a host that already ended (reboot) is cleaned up and the chat shows as continued", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    t.registry.setStatus("s1", "ended");
    await t.resume();
    expect(t.calls).toEqual(["close abc12345"]);
    expect(t.view().status).toBe("idle");
    expect(t.view().movedToTerminal).toBe(true);
  });

  test("nothing happens for a chat that isn't in a Relay terminal, or resumed inside it", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: t.dir, env: { ...ITERM, claudePid: 1111 } });
    await t.resume();
    expect(t.view().movedToTerminal).toBeUndefined();
    const shell = setup();
    shell.registry.touch("s1", {
      cwd: shell.dir,
      env: { pty: "/tmp/relay-shell-1.sock", ptyToken: "t", claudePid: 9 },
    });
    await shell.hook("SessionStart", { source: "resume" }, { ...ITERM });
    expect(shell.calls).toEqual([]);
    const same = setup();
    same.registry.touch("s1", { cwd: same.dir, env: HOST });
    await same.hook("SessionStart", { source: "resume" }, HOST);
    expect(same.calls).toEqual([]);
    expect(same.registry.get("s1")?.ptySocket).toBe(HOST.pty as string);
  });

  test("a message being typed into Relay's copy while you resume goes to your terminal", async () => {
    const t = setup();
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    const typed: string[] = [];
    const ops: TypeOps = {
      pty: async () => {
        await t.resume();
        throw new Error("connect ECONNREFUSED");
      },
      tmuxScreen: async () => null,
      tmux: async () => {},
      routes: () => ["iterm"],
      ttyOf: async () => "/dev/ttys004",
      peek: async () => ({ front: false, screen: PROMPT }),
      inFront: async () => true,
      type: async (_r, tty, text) => {
        typed.push(`${tty}:${text}`);
        return true;
      },
      sleep: async () => {},
    };
    const rpc = rpcFor(t, ops);
    const res = await rpc("session.send", { sessionId: "s1", text: "hello" }, "phone");
    expect(res).toEqual({ result: { via: "iterm" } });
    expect(typed).toEqual(["/dev/ttys004:hello"]);
  });

  test("a message sent during a slow stop is typed into your terminal, never into the copy that is ending", async () => {
    const t = setup(undefined, async (id) => {
      await Bun.sleep(150);
      t.registry.setStatus(id, "idle");
    });
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    t.registry.setStatus("s1", "working");
    const typed: string[] = [];
    const ops: TypeOps = {
      pty: async (socket, _token, _pid, text) => {
        typed.push(`pty ${socket}:${text}`);
        return { ok: true };
      },
      tmuxScreen: async () => null,
      tmux: async () => {},
      routes: () => ["iterm"],
      ttyOf: async () => "/dev/ttys004",
      peek: async () => ({ front: false, screen: PROMPT }),
      inFront: async () => true,
      type: async (_r, tty, text) => {
        typed.push(`${tty}:${text}`);
        return true;
      },
      sleep: async () => {},
    };
    const rpc = rpcFor(t, ops);
    const resuming = t.resume();
    await Bun.sleep(20);
    const res = await rpc("session.send", { sessionId: "s1", text: "hello" }, "phone");
    await resuming;
    expect(res).toEqual({ result: { via: "iterm" } });
    expect(typed).toEqual(["/dev/ttys004:hello"]);
  });

  test("a turn your terminal opens during the stop keeps the chat working", async () => {
    const t = setup(undefined, async (id) => {
      t.registry.setStatus(id, "idle");
      await Bun.sleep(150);
    });
    t.registry.touch("s1", { cwd: t.dir, env: HOST });
    t.registry.setStatus("s1", "working");
    const resuming = t.resume();
    await Bun.sleep(50);
    await t.hook("UserPromptSubmit", { prompt: "go on" }, ITERM);
    await resuming;
    expect(t.view().status).toBe("working");
  });

  test("with a real host: the stub Claude Code stops, nothing is left behind, the chat stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-handover-host-"));
    dirs.push(dir);
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
    chmodSync(bin, 0o755);
    const home = join(dir, "pty");
    const launcher = hostLauncher({ dir: home, self: [process.execPath, CLI] });
    const t = setup(launcher);
    t.db
      .query(
        "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at) VALUES ('old', ?, 'proj', 'ended', 1, 2)",
      )
      .run(dir);
    const { sessionId } = await startSession({
      db: t.db,
      registry: t.registry,
      claudeBin: bin,
      directory: dir,
      terminal: launcher,
      readyTimeoutMs: 15_000,
    });
    const row = t.registry.get(sessionId);
    const pid = row?.pid as number;
    pids.push(pid);
    expect(readHostState(home, sessionId.slice(0, 8))).not.toBeNull();
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(pid)).toBe(true);
    await new Handover({ registry: t.registry, terminal: launcher }).resumed(sessionId, ITERM);
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
    expect(alive(pid)).toBe(false);
    expect(readHostState(home, sessionId.slice(0, 8))).toBeNull();
    expect(existsSync(row?.ptySocket as string)).toBe(false);
    expect(t.registry.get(sessionId)?.ptySocket).toBeNull();
    expect(t.registry.get(sessionId)?.movedAt).not.toBeNull();
  });
});

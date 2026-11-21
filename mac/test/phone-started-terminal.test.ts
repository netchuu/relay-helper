import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { deliver } from "../src/daemon/inject.ts";
import { Registry, replyRouteOf } from "../src/daemon/registry.ts";
import { StartError, startSession, terminalCommand } from "../src/daemon/startSession.ts";
import type { TerminalLauncher, TerminalPane } from "../src/daemon/terminalHost.ts";
import { fakeTerminals, opts, PROMPT } from "./support/terminals.ts";

// A session started from the phone runs in a terminal of Relay's own, which the helper types into, so phone messages arrive as typed input.

const PANE: TerminalPane = { id: "abc12345", socket: "/tmp/relay-test.sock", token: "tok", pid: 4242 };

/** A launcher that shows `screens` one look at a time (the last one stays) and records what it was asked to run. */
function fakeLauncher(screens: { screen: string; exited?: boolean }[]) {
  const ran: { cmd: string[]; cwd: string }[] = [];
  let looks = 0;
  let closed = 0;
  let released = 0;
  const launcher: TerminalLauncher = {
    launch: async (cmd, cwd) => {
      ran.push({ cmd, cwd });
      return PANE;
    },
    look: async () => {
      const s = screens[Math.min(looks++, screens.length - 1)] as { screen: string; exited?: boolean };
      return { screen: s.screen, exited: s.exited ?? false };
    },
    close: async () => void closed++,
    release: async () => void released++,
  };
  return { launcher, ran, looks: () => looks, closed: () => closed, released: () => released };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-phone-start-"));
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at) VALUES ('old', ?, 'proj', 'ended', 1, 2)",
  ).run(dir);
  return { dir, db, registry, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("a session started from the phone", () => {
  test("reports a typing route, and a send types through its terminal instead of the inbox", async () => {
    const { dir, db, registry, done } = setup();
    const { launcher } = fakeLauncher([{ screen: PROMPT }]);
    const { sessionId } = await startSession({
      db,
      registry,
      claudeBin: "/bin/claude",
      directory: dir,
      terminal: launcher,
    });
    const session = registry.get(sessionId);
    expect(session?.canReceive).toBe(true);
    expect(session && replyRouteOf(session)).toEqual({ replyRoute: "typed" });

    const t = fakeTerminals(true);
    const res = await deliver(session as NonNullable<typeof session>, "hello", opts, t.ops);
    expect(res.via).toBe("pty");
    expect(t.typed).toEqual(["pty:hello"]);
    done();
  });

  test("starts Claude Code with its own id, the message after `--`, and nothing wrapped around it", () => {
    expect(terminalCommand("/bin/claude", "abc", "fix; it")).toEqual([
      "/bin/claude",
      "--session-id",
      "abc",
      "--",
      "fix; it",
    ]);
    expect(terminalCommand("/bin/claude", "abc").slice(-2)).toEqual(["--session-id", "abc"]);
  });

  test("runs in the folder it was asked for, named for the phone", async () => {
    const { dir, db, registry, done } = setup();
    const { launcher, ran } = fakeLauncher([{ screen: PROMPT }]);
    const { sessionId } = await startSession({
      db,
      registry,
      claudeBin: "/bin/claude",
      directory: dir,
      name: "triage",
      text: "look at the bugs",
      terminal: launcher,
    });
    expect(ran[0]?.cwd).toBe(dir);
    expect(ran[0]?.cmd).toContain(sessionId);
    expect(registry.get(sessionId)?.name).toBe("triage");
    done();
  });

  test("returns only once the prompt shows, so the first send never meets an unready session", async () => {
    const { dir, db, registry, done } = setup();
    const f = fakeLauncher([{ screen: "" }, { screen: "Welcome to Claude Code" }, { screen: PROMPT }]);
    await startSession({
      db,
      registry,
      claudeBin: "/bin/claude",
      directory: dir,
      terminal: f.launcher,
      pollMs: 1,
    });
    expect(f.looks()).toBe(3);
    done();
  });

  test("Claude Code refusing to start gives its words to the phone and closes the terminal", async () => {
    const { dir, db, registry, done } = setup();
    const f = fakeLauncher([{ screen: "\nWorkspace not trusted.\n", exited: true }]);
    const err = await startSession({
      db,
      registry,
      claudeBin: "/bin/claude",
      directory: dir,
      terminal: f.launcher,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).message).toBe("Claude Code couldn't start: Workspace not trusted.");
    expect(f.closed()).toBe(1);
    expect(f.released()).toBe(0);
    expect(registry.list().length).toBe(0);
    done();
  });

  test("a prompt that never shows: an empty start is closed, one with a message stays", async () => {
    const { dir, db, registry, done } = setup();
    const empty = fakeLauncher([{ screen: "" }]);
    const base = { db, registry, claudeBin: "/bin/claude", directory: dir, readyTimeoutMs: 20, pollMs: 5 };
    await expect(startSession({ ...base, terminal: empty.launcher })).rejects.toThrow(StartError);
    expect(empty.closed()).toBe(1);
    const withText = fakeLauncher([{ screen: "" }]);
    const res = await startSession({ ...base, text: "hi", terminal: withText.launcher });
    expect(registry.get(res.sessionId)?.canReceive).toBe(true);
    expect(withText.closed()).toBe(0);
    expect(withText.released()).toBe(1);
    done();
  });

  test("lets go of the terminal once the prompt shows, so a finished chat leaves no record behind", async () => {
    const { dir, db, registry, done } = setup();
    const f = fakeLauncher([{ screen: PROMPT }]);
    await startSession({ db, registry, claudeBin: "/bin/claude", directory: dir, terminal: f.launcher });
    expect(f.released()).toBe(1);
    done();
  });
});

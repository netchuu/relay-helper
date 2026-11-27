import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { startSession } from "../src/daemon/startSession.ts";
import type { TerminalLauncher } from "../src/daemon/terminalHost.ts";
import { PROMPT } from "./support/terminals.ts";

const RULE = "─".repeat(80);
const TRUST = [
  RULE,
  " Accessing workspace:",
  "",
  " /Users/me/Projects/web-shop",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
].join("\n");
const REFUSED =
  "Claude Code didn't start because this folder isn't trusted.\nRun claude again and choose Yes.";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-trust-start-"));
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at) VALUES ('old', ?, 'proj', 'ended', 1, 2)",
  ).run(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\necho '[]'\n");
  chmodSync(bin, 0o755);
  return { dir, bin, db, events, registry, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function host(first: { screen: string; exited?: boolean }) {
  let now = { screen: first.screen, exited: first.exited ?? false };
  let closed = 0;
  let released = 0;
  const launcher: TerminalLauncher = {
    launch: async () => ({ id: "abc12345", socket: "/tmp/x.sock", token: "t", pid: 4242 }),
    look: async () => now,
    close: async () => void closed++,
    release: async () => void released++,
  };
  return {
    launcher,
    show: (screen: string, exited = false) => {
      now = { screen, exited };
    },
    closed: () => closed,
    released: () => released,
  };
}

async function settle(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(2);
}

async function parked() {
  const s = setup();
  const h = host({ screen: TRUST });
  let clock = 0;
  const { sessionId } = await startSession({
    db: s.db,
    registry: s.registry,
    claudeBin: s.bin,
    directory: s.dir,
    terminal: h.launcher,
    pollMs: 1,
    now: () => clock,
    sleep: async () => {
      await Bun.sleep(1);
    },
  });
  return {
    ...s,
    h,
    sessionId,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("a new chat in a folder Claude Code doesn't trust", () => {
  test("start returns at the dialog, waiting, with its terminal kept", async () => {
    const t = await parked();
    expect(t.registry.get(t.sessionId)?.status).toBe("waiting");
    expect(t.registry.get(t.sessionId)?.canReceive).toBe(true);
    expect(t.h.released()).toBe(0);
    expect(t.h.closed()).toBe(0);
    t.h.show("", true);
    await settle(() => t.registry.get(t.sessionId)?.status === "ended");
    t.done();
  });

  test("reconcile leaves the parked chat alone", async () => {
    const t = await parked();
    await t.registry.reconcile(t.bin);
    expect(t.registry.get(t.sessionId)?.status).toBe("waiting");
    t.h.show(REFUSED, true);
    await settle(() => t.registry.get(t.sessionId)?.status === "ended");
    t.done();
  });

  for (const code of [0, 1]) {
    test(`No ends it as untrusted from the screen line, exit code ${code}`, async () => {
      const t = await parked();
      const seen: string[] = [];
      t.events.subscribe((e) => {
        if (e.type === "session.notice") seen.push(e.text);
      });
      t.h.show(`${REFUSED}\n(exit ${code})`, true);
      await settle(() => t.registry.get(t.sessionId)?.status === "ended");
      const s = t.registry.get(t.sessionId);
      expect(s?.status).toBe("ended");
      expect(s?.endReason).toBe("untrusted");
      expect(seen).toEqual(["Claude Code didn't start because this folder isn't trusted."]);
      expect(t.h.closed()).toBe(1);
      t.done();
    });
  }

  test("a crash that isn't the trust refusal ends it as other", async () => {
    const t = await parked();
    t.h.show("segfault", true);
    await settle(() => t.registry.get(t.sessionId)?.status === "ended");
    expect(t.registry.get(t.sessionId)?.endReason).toBe("other");
    t.done();
  });

  test("an unanswered start stops after 24 hours", async () => {
    const t = await parked();
    t.advance(23 * 3_600_000);
    await Bun.sleep(20);
    expect(t.registry.get(t.sessionId)?.status).toBe("waiting");
    t.advance(2 * 3_600_000);
    await settle(() => t.registry.get(t.sessionId)?.status === "ended");
    expect(t.registry.get(t.sessionId)?.endReason).toBe("stopped");
    expect(t.h.closed()).toBe(1);
    t.done();
  });

  test("Yes lets the prompt show: the host is released and the chat stays", async () => {
    const t = await parked();
    t.h.show(PROMPT);
    await settle(() => t.h.released() === 1);
    expect(t.h.released()).toBe(1);
    expect(t.registry.get(t.sessionId)?.status).toBe("waiting");
    t.done();
  });
});

import { describe, expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { deliver, fullTty, sameTty, type TypeOps } from "../src/daemon/inject.ts";
import { Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { inFront, parseProcs } from "../src/platform/foreground.ts";

// `ps` and tmux's pane_tty name a terminal differently on macOS and Linux; the pane check must read both.

describe("terminal names", () => {
  test("fullTty reads macOS and Linux ps names, and none for no terminal", () => {
    expect(fullTty("ttys003")).toBe("/dev/ttys003");
    expect(fullTty("pts/0")).toBe("/dev/pts/0");
    expect(fullTty("tty1")).toBe("/dev/tty1");
    expect(fullTty("??")).toBeNull();
    expect(fullTty("?")).toBeNull();
    expect(fullTty("")).toBeNull();
  });

  test("sameTty ignores the /dev/ prefix and refuses other terminals or none", () => {
    expect(sameTty("/dev/pts/0", "/dev/pts/0")).toBe(true);
    expect(sameTty("/dev/pts/0", "pts/0")).toBe(true);
    expect(sameTty("/dev/ttys003", "/dev/ttys003")).toBe(true);
    expect(sameTty("/dev/pts/0", "/dev/pts/1")).toBe(false);
    expect(sameTty("/dev/pts/1", "/dev/pts/10")).toBe(false);
    expect(sameTty("/dev/pts/0", null)).toBe(false);
    expect(sameTty(null, null)).toBe(false);
  });

  test("a Linux ps listing puts a process in front on its pts", () => {
    const procs = parseProcs(
      "  900   900   900 pts/0     claude\n  901   900   900 pts/0     node mcp\n  50 50 -1 ? sshd\n",
    );
    expect(inFront(procs, 900, null)).toBe(true);
    expect(inFront(procs, 50, null)).toBe(false);
  });
});

describe("the tmux pane check on Linux names", () => {
  test("a session in its pane (/dev/pts/0 against pts/0) is typed into", async () => {
    const db = openDb(":memory:");
    const registry = new Registry(db, new EventLog(db));
    registry.touch("s", {
      cwd: "/p",
      env: { tmux: "/tmp/tmux-1000/default,1,0", tmuxPane: "%0", termProgram: "tmux", claudePid: 900 },
    });
    const typed: string[] = [];
    const ops = {
      pty: async () => ({ ok: false, reason: "not_foreground" }),
      tmuxScreen: async () => "❯ \n",
      tmux: async (_s: string, pane: string, text: string) => void typed.push(`tmux ${pane}:${text}`),
      tmuxPaneTty: async () => "/dev/pts/0",
      routes: () => [],
      ttyOf: async (pid: number | null) => (pid ? fullTty("pts/0") : null),
      peek: async () => ({ front: true, screen: null }),
      inFront: async () => true,
      type: async () => true,
    } as unknown as TypeOps;
    const res = await deliver(
      registry.get("s") as SessionRecord,
      "hi",
      { userTypingNow: false, preferTyping: true },
      ops,
    );
    expect(res).toEqual({ via: "tmux" });
    expect(typed).toEqual(["tmux %0:hi"]);
  });
});

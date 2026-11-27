import { describe, expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { deliver, type KeyOps, pressEscape, type TypeOps } from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import type { TabView } from "../src/platform/types.ts";

// A session first seen in tmux pane %3 and then resumed in a plain terminal tab must not be typed (or sent Esc)
// into %3, which may be a bare shell by now.

const TMUX_ENV: HookEnv = {
  tmux: "/tmp/tmux-501/default,1,0",
  tmuxPane: "%3",
  termProgram: "tmux",
  claudePid: 4242,
};
const PLAIN_ENV: HookEnv = { tmux: null, tmuxPane: null, termProgram: "iTerm.app", claudePid: 5151 };
const SHELL_SCREEN = "user@mac ~ % \n";
const TAB: TabView = { front: true, screen: null };

function registryWith() {
  const db = openDb(":memory:");
  return new Registry(db, new EventLog(db));
}

function fakeOps(init: { tmuxScreen: string; paneTty: string; ttys: Record<number, string> }) {
  const typed: string[] = [];
  const ops = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmuxScreen: async () => init.tmuxScreen,
    tmux: async (_s: string, pane: string, text: string) => void typed.push(`tmux ${pane}:${text}`),
    tmuxPaneTty: async () => init.paneTty,
    routes: (t: string | null) => (t === "iTerm.app" ? ["iterm"] : []),
    ttyOf: async (pid: number | null) => (pid ? (init.ttys[pid] ?? null) : null),
    peek: async () => TAB,
    inFront: async () => true,
    type: async (route: string, tty: string, text: string) => (typed.push(`${route} ${tty}:${text}`), true),
  };
  return { ops: ops as unknown as TypeOps, typed };
}

const opts = { idleSeconds: 600, userTypingNow: false, preferTyping: true };

describe("a session that left its tmux pane", () => {
  test("touch outside tmux forgets the pane; touch without env keeps it", () => {
    const registry = registryWith();
    registry.touch("s", { cwd: "/p", env: TMUX_ENV });
    expect(registry.get("s")).toMatchObject({ pid: 4242, tmuxPane: "%3" });
    registry.touch("s", { cwd: "/p", env: { claudePid: 4242 } }, false);
    expect(registry.get("s")?.tmuxPane).toBe("%3");
    registry.touch("s", { cwd: "/p", env: PLAIN_ENV });
    expect(registry.get("s")).toMatchObject({ pid: 5151, tmuxPane: null, tmuxSocket: null });
  });

  test("deliver types into the session's current terminal, not the old pane", async () => {
    const registry = registryWith();
    registry.touch("s", { cwd: "/p", env: TMUX_ENV });
    registry.touch("s", { cwd: "/p", env: PLAIN_ENV });
    const t = fakeOps({ tmuxScreen: SHELL_SCREEN, paneTty: "/dev/ttys003", ttys: { 5151: "/dev/ttys009" } });
    const res = await deliver(registry.get("s") as SessionRecord, "hi", opts, t.ops);
    expect(res).toEqual({ via: "iterm" });
    expect(t.typed.some((x) => x.startsWith("tmux"))).toBe(false);
    expect(t.typed).toEqual(["iterm /dev/ttys009:hi"]);
  });

  test("a stale pane that still has the old record isn't typed into when Claude runs on another tty", async () => {
    const registry = registryWith();
    registry.touch("s", { cwd: "/p", env: TMUX_ENV });
    // the record still names the pane (e.g. from before this fix), but the process is elsewhere
    registry.touch("s", { cwd: "/p", env: { claudePid: 5151, termProgram: "iTerm.app" } });
    expect(registry.get("s")?.tmuxPane).toBe("%3");
    const t = fakeOps({ tmuxScreen: SHELL_SCREEN, paneTty: "/dev/ttys003", ttys: { 5151: "/dev/ttys009" } });
    const res = await deliver(registry.get("s") as SessionRecord, "hi", opts, t.ops);
    expect(res).toEqual({ via: "iterm" });
    expect(t.typed.some((x) => x.startsWith("tmux"))).toBe(false);
  });

  test("a session still in its pane is typed into, and gets Esc", async () => {
    const registry = registryWith();
    registry.touch("s", { cwd: "/p", env: TMUX_ENV });
    const t = fakeOps({
      tmuxScreen: `${"─".repeat(80)}\n❯ \n${"─".repeat(80)}`,
      paneTty: "/dev/ttys003",
      ttys: { 4242: "/dev/ttys003" },
    });
    expect(await deliver(registry.get("s") as SessionRecord, "hi", opts, t.ops)).toEqual({ via: "tmux" });
    expect(t.typed).toEqual(["tmux %3:hi"]);
  });

  test("Esc goes to a pane only when Claude Code is in front in that pane", async () => {
    const registry = registryWith();
    registry.touch("s", { cwd: "/p", env: TMUX_ENV });
    registry.touch("s", { cwd: "/p", env: { claudePid: 5151, termProgram: "iTerm.app" } });
    const sent: string[] = [];
    const keys = (paneTty: string): KeyOps => ({
      pty: async () => ({ ok: false, reason: "not_foreground" }),
      tmux: async (_s, pane) => void sent.push(`tmux ${pane}`),
      tmuxPaneTty: async () => paneTty,
      inFront: async () => true,
      routes: () => ["iterm"],
      app: async (_r, tty) => {
        sent.push(`app ${tty}`);
        return true;
      },
      ttyOf: async () => "/dev/ttys009",
    });
    const s = registry.get("s") as SessionRecord;
    expect(await pressEscape(s, keys("/dev/ttys003"))).toBe("iterm");
    expect(sent).toEqual(["app /dev/ttys009"]);
    sent.length = 0;
    expect(await pressEscape(s, keys("/dev/ttys009"))).toBe("tmux");
    expect(sent).toEqual(["tmux %3"]);
  });
});

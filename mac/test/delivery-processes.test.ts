import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type DeliverOptions, defaultTypeOps, deliver, type TypeOps } from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { ReplyQueue } from "../src/daemon/replyQueue.ts";
import { answerRequest, isForeground, type RequestContext } from "../src/shell/ptyShell.ts";

// How many processes one reply starts, per route. Every Bun.spawn is answered here and counted.

const RULE = "─".repeat(100);
const EMPTY = ["⏺ Done.", RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const PS = ["4242 1 4242 4242 ttys042 claude", "999 1 999 999 ttys001 -zsh"].join("\n");

let started: string[][] = [];
let spawn: ReturnType<typeof spyOn>;

beforeEach(() => {
  started = [];
  spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
    started.push(cmd);
    const [bin, ...rest] = cmd;
    let out = "";
    if (bin === "ps") out = rest.includes("-A") ? PS : "4242 4242 4242\n999 999 4242\n";
    else if (bin === "tmux" && rest.includes("capture-pane")) out = `/dev/ttys042\n${EMPTY}\n`;
    else if (bin === "wezterm" && rest.includes("get-text")) out = EMPTY;
    else if (bin === "wezterm" && rest.includes("list"))
      out = JSON.stringify([{ pane_id: 7, tty_name: "/dev/ttys042" }]);
    else if (bin === "kitty" && rest.includes("get-text")) out = EMPTY;
    else if (bin === "kitty" && rest.includes("ls"))
      out = JSON.stringify([{ tabs: [{ windows: [{ id: 5, foreground_processes: [{ pid: 4242 }] }] }] }]);
    return { stdout: new Blob([out]), stderr: new Blob([""]), exited: Promise.resolve(0), kill() {} };
  }) as never);
});
afterEach(() => spawn.mockRestore());

function session(env: HookEnv): SessionRecord {
  const db = openDb(":memory:");
  const made = new Registry(db, new EventLog(db)).touch("s1", { cwd: "/p", env }).session;
  // Registering a session reads its git folder; only what a reply starts is counted.
  started = [];
  return made;
}

const opts = (): DeliverOptions => ({
  userTypingNow: false,
  preferTyping: true,
});

const ops: TypeOps = {
  ...defaultTypeOps,
  routes: () => [],
  sleep: async () => {},
};

/** The processes that read state, as against the ones that type (the mode check comes with the typing). */
const reads = () =>
  started.filter((c) => !/send-keys|paste-buffer|load-buffer|send-text|pane_in_mode/.test(c.join(" ")));

const TMUX: HookEnv = {
  tmux: "/tmp/tmux-501/default,1,0",
  tmuxPane: "%3",
  claudePid: 4242,
  termProgram: "tmux",
};
const WEZ: HookEnv = {
  termProgram: "WezTerm",
  weztermPane: "7",
  weztermSocket: "/tmp/wez/sock",
  claudePid: 4242,
};
const KITTY: HookEnv = {
  termProgram: "kitty",
  kittyWindowId: "5",
  kittyListenOn: "unix:/tmp/kitty-9",
  claudePid: 4242,
};

describe("processes started for one reply", () => {
  test("tmux: one tmux call for the screen and the pane's tty, one ps, then the typing (one mode check first)", async () => {
    expect(await deliver(session(TMUX), "go", opts(), ops)).toEqual({ via: "tmux" });
    expect(reads().map((c) => c[0])).toEqual(["tmux", "ps"]);
    expect(reads()[0]).toContain(";");
    expect(started.length).toBe(5);
  });

  test("WezTerm: the screen, the pane list and one ps", async () => {
    expect(await deliver(session(WEZ), "go", opts(), ops)).toEqual({ via: "wezterm" });
    expect(reads().map((c) => c[0])).toEqual(["wezterm", "wezterm", "ps"]);
  });

  test("kitty: the screen, the window list and one ps", async () => {
    expect(await deliver(session(KITTY), "go", opts(), ops)).toEqual({ via: "kitty" });
    expect(reads().map((c) => c[0])).toEqual(["kitty", "kitty", "ps"]);
  });

  test("a terminal tab: one ps for the tab's tty and the in-front check together", async () => {
    const tab: TypeOps = {
      ...ops,
      routes: () => ["iterm"],
      peek: async () => ({ screen: EMPTY, front: false }),
      type: async () => true,
    };
    const res = await deliver(session({ termProgram: "iTerm.app", claudePid: 4242 }), "go", opts(), tab);
    expect(res).toEqual({ via: "iterm" });
    expect(started.map((c) => c[0])).toEqual(["ps"]);
  });

  test("relay shell: the helper starts nothing; the shell asks ps once per check", async () => {
    const pty: TypeOps = { ...ops, pty: async () => ({ ok: true }), ptyScreen: async () => EMPTY };
    const env: HookEnv = {
      termProgram: "zed",
      claudePid: 4242,
      pty: "/tmp/pty.sock",
      ptyToken: "tok",
    } as HookEnv;
    expect(await deliver(session(env), "go", opts(), pty)).toEqual({ via: "pty" });
    expect(started).toEqual([]);

    const ctx: RequestContext = {
      token: "tok",
      shellPid: 999,
      isForeground,
      pasteOn: () => false,
      write: () => {},
      sleep: async () => {},
      now: () => 1_000_000,
    };
    const reply = await answerRequest(JSON.stringify({ token: "tok", pid: 4242, text: "go" }), ctx);
    expect(reply).toEqual({ ok: true });
    expect(started.map((c) => c[0])).toEqual(["ps", "ps"]);
  });
});

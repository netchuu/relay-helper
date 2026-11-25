import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type DeliverOptions, deliver, type GuiOps, type TypeOps } from "../src/daemon/inject.ts";
import { PartlyTyped } from "../src/daemon/paneTerminals.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import type { TabView, TypingRoute } from "../src/platform/types.ts";

const RULE = "─".repeat(100);
const screenWith = (prompt: string) =>
  [" ▐▛███▜▌   Claude Code v2.1.319", "", RULE, `❯ ${prompt}`, RULE, "  ⏵⏵ bypass permissions on"].join("\n");

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

async function inbox() {
  const path = join(mkdtempSync(join(tmpdir(), "relay-unconf-")), "in.sock");
  const state = { connections: 0 };
  const server = createServer(() => void state.connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return { path, state };
}

function sessionWith(env: HookEnv): SessionRecord {
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  return registry.get("s1") as SessionRecord;
}

const opts = (more: Partial<DeliverOptions> = {}): DeliverOptions => ({
  userTypingNow: false,
  preferTyping: true,
  submitted: () => false,
  submitWaitMs: 10,
  ...more,
});

const gui = (over: Partial<GuiOps> = {}): GuiOps => ({
  desktopReady: async () => false,
  sendToDesktop: async () => "failed",
  isIdeSession: () => false,
  axAllowed: () => true,
  sendToIde: async () => "failed",
  ...over,
});

const termOps = (over: Partial<TypeOps> = {}): TypeOps => ({
  pty: async () => ({ ok: false, reason: "not_foreground" }),
  tmuxScreen: async () => null,
  tmux: async () => {},
  routes: () => [],
  ttyOf: async () => null,
  peek: async () => null,
  type: async () => false,
  inFront: async () => true,
  sleep: async () => {},
  gui: gui(),
  ...over,
});

describe("typed, arrival not seen: submitted:false, no inbox", () => {
  test("the desktop app", async () => {
    const box = await inbox();
    const s = sessionWith({ socket: box.path });
    const ops = termOps({
      gui: gui({ desktopReady: async () => true, sendToDesktop: async () => "unconfirmed" }),
    });
    expect(await deliver(s, "hello", opts(), ops)).toEqual({ via: "desktop", submitted: false });
    expect(box.state.connections).toBe(0);
  });

  test("the editor extension", async () => {
    const box = await inbox();
    const s = sessionWith({ socket: box.path });
    const ops = termOps({
      gui: gui({ isIdeSession: () => true, sendToIde: async () => "unconfirmed" }),
    });
    expect(await deliver(s, "hello", opts(), ops)).toEqual({ via: "ide", submitted: false });
    expect(box.state.connections).toBe(0);
  });

  test("a tmux pane with the message still in its prompt", async () => {
    const box = await inbox();
    const s = sessionWith({
      tmux: "/tmp/tmux/default,1,0",
      tmuxPane: "%3",
      claudePid: 4242,
      termProgram: "tmux",
      socket: box.path,
    });
    let typed = false;
    const ops = termOps({
      tmuxScreen: async () => screenWith(typed ? "hello there" : ""),
      tmux: async () => {
        typed = true;
      },
      tmuxEnter: async () => {},
    });
    expect(await deliver(s, "hello there", opts({}), ops)).toEqual({
      via: "tmux",
      submitted: false,
    });
    expect(box.state.connections).toBe(0);
  });

  test("an iTerm2 tab with the message still in its prompt", async () => {
    const box = await inbox();
    const s = sessionWith({ termProgram: "iTerm.app", claudePid: 4242, socket: box.path });
    let typed = false;
    const tab = (): TabView => ({ front: false, screen: screenWith(typed ? "hello there" : "") });
    const ops = termOps({
      routes: () => ["iterm"] as TypingRoute[],
      ttyOf: async () => "/dev/ttys004",
      peek: async () => tab(),
      type: async () => {
        typed = true;
        return true;
      },
      enter: async () => true,
    });
    expect(await deliver(s, "hello there", opts({}), ops)).toEqual({
      via: "iterm",
      submitted: false,
    });
    expect(box.state.connections).toBe(0);
  });

  test("relay shell whose hook never comes, even after the second Enter", async () => {
    const box = await inbox();
    const s = sessionWith({ pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242, socket: box.path });
    const ops = termOps({
      pty: async () => ({ ok: true }),
      enterPty: async () => ({ ok: true }),
    });
    expect(await deliver(s, "hello", opts(), ops)).toEqual({ via: "pty", submitted: false });
    expect(box.state.connections).toBe(0);
  });

  test("relay shell whose agent left the front after the text was written", async () => {
    const box = await inbox();
    const s = sessionWith({ pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242, socket: box.path });
    const ops = termOps({ pty: async () => ({ ok: false, reason: "typed_not_sent" }) });
    expect(await deliver(s, "hello", opts({ submitted: undefined }), ops)).toEqual({
      via: "pty",
      submitted: false,
    });
    expect(box.state.connections).toBe(0);
  });

  test("relay shell refusing before anything is typed still falls through", async () => {
    const box = await inbox();
    const s = sessionWith({ pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242, socket: box.path });
    expect(await deliver(s, "hello", opts(), termOps())).toEqual({ via: "socket" });
    await Bun.sleep(20);
    expect(box.state.connections).toBe(1);
  });

  test("tmux typed the text, then a later step failed", async () => {
    const box = await inbox();
    const s = sessionWith({
      tmux: "/tmp/tmux/default,1,0",
      tmuxPane: "%3",
      claudePid: 4242,
      termProgram: "tmux",
      socket: box.path,
    });
    const ops = termOps({
      tmuxScreen: async () => screenWith(""),
      tmux: async () => {
        throw new PartlyTyped("tmux send-keys failed (1)");
      },
    });
    expect(await deliver(s, "hello", opts({ submitted: undefined }), ops)).toEqual({
      via: "tmux",
      submitted: false,
    });
    expect(box.state.connections).toBe(0);
  });

  test("tmux failing before any key went in still falls through", async () => {
    const box = await inbox();
    const s = sessionWith({
      tmux: "/tmp/tmux/default,1,0",
      tmuxPane: "%3",
      claudePid: 4242,
      termProgram: "tmux",
      socket: box.path,
    });
    const ops = termOps({
      tmuxScreen: async () => screenWith(""),
      tmux: async () => {
        throw new Error("tmux load-buffer failed (1)");
      },
    });
    expect(await deliver(s, "hello", opts({}), ops)).toEqual({ via: "socket" });
    await Bun.sleep(20);
    expect(box.state.connections).toBe(1);
  });

  test("a WezTerm pane typed the text, then a later step failed", async () => {
    const box = await inbox();
    const s = sessionWith({ weztermPane: "7", claudePid: 4242, socket: box.path });
    const ops = termOps({
      paneScreen: async () => screenWith(""),
      paneInfo: async () => ({ pids: [4242] }),
      paneType: async () => {
        throw new PartlyTyped("wezterm send-text failed (1)");
      },
    });
    expect(await deliver(s, "hello", opts({ submitted: undefined }), ops)).toEqual({
      via: "wezterm",
      submitted: false,
    });
    expect(box.state.connections).toBe(0);
  });
});

describe("a route that doesn't apply still falls through", () => {
  test("a draft in the desktop composer, then a tab not open in the editor: the inbox", async () => {
    const box = await inbox();
    const s = sessionWith({ socket: box.path });
    const ops = termOps({
      gui: gui({
        desktopReady: async () => true,
        sendToDesktop: async () => "draft",
        isIdeSession: () => true,
        sendToIde: async () => "not-found",
      }),
    });
    expect(await deliver(s, "hello", opts(), ops)).toEqual({ via: "socket" });
    await Bun.sleep(20);
    expect(box.state.connections).toBe(1);
  });
});

// A phone message is never typed while a terminal dialog is on screen: it waits (or is refused) until the prompt is back.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import type { TypeOps } from "../src/daemon/inject.ts";
import { Registry } from "../src/daemon/registry.ts";
import { deliverQueued, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView } from "../src/platform/types.ts";

const RULE = "─".repeat(80);
const PROMPT = [RULE, "❯ ", RULE].join("\n");
const THEME = [
  RULE,
  " Choose a theme",
  "",
  " ❯ 1. Dark mode",
  "   2. Light mode",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");

const read = platform.presence.read;
beforeEach(() => {
  platform.presence.read = async () => ({ idleSeconds: 60, locked: false, source: "test" });
});
afterEach(() => {
  platform.presence.read = read;
});

function setup(env: Record<string, unknown> = {}, extra: Partial<TypeOps> = {}) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", {
    cwd: "/Users/me/web-shop",
    env: { termProgram: "iTerm.app", claudePid: 4242, ...env },
  });
  const queue = new ReplyQueue(db, events, registry);
  const seen: RelayEvent[] = [];
  events.subscribe?.((e: RelayEvent) => seen.push(e));
  const state = { tab: { front: false, screen: THEME } as TabView };
  const typed: string[] = [];
  const ops: TypeOps = {
    pty: async () => ({ ok: true }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: async () => "/dev/ttys004",
    peek: async () => state.tab,
    inFront: async () => true,
    type: async (route, _tty, text) => {
      typed.push(`${route}:${text}`);
      return true;
    },
    ...extra,
  };
  const rpc = createRpc({
    db,
    events,
    registry,
    replies: queue,
    broker: { hasOpen: () => false },
    config: { preferTyping: true },
    typeOps: ops,
  } as unknown as RpcDeps);
  const drain = () =>
    queue.drain(deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: ops }));
  return { rpc, queue, state, typed, seen, drain };
}

const msg = { sessionId: "s1", text: "Ship it", sendId: "m1" };

test("a phone that knows dialogs gets the message held, and nothing is typed", async () => {
  const { rpc, typed, queue, seen } = setup();
  const out = await rpc("session.send", msg, "phone", { dialogs: true });
  expect(out).toEqual({ result: { via: "queued", reason: "dialog" } });
  expect(typed).toEqual([]);
  expect(queue.list("s1").map((r) => [r.text, r.waitsFor])).toEqual([["Ship it", "dialog"]]);
  expect(seen.some((e) => e.type === "reply.waiting" && e.reason === "dialog")).toBe(true);
});

test("an older phone is refused with the sentence, and nothing is typed or held", async () => {
  const { rpc, typed, queue } = setup();
  const out = await rpc("session.send", msg, "phone");
  expect(out).toEqual({
    error: {
      code: "conflict",
      message:
        "Claude Code is asking something on your computer: Choose a theme. Answer it, then send again.",
    },
  });
  expect(typed).toEqual([]);
  expect(queue.list("s1")).toEqual([]);
});

test("a held message stays while the dialog shows and is typed once the prompt is back", async () => {
  const { rpc, typed, queue, state, drain, seen } = setup();
  await rpc("session.send", msg, "phone", { dialogs: true });
  await drain();
  expect(typed).toEqual([]);
  expect(queue.list("s1")).toHaveLength(1);
  state.tab = { front: false, screen: PROMPT };
  await drain();
  expect(typed).toEqual(["iterm:Ship it"]);
  expect(queue.list("s1")).toEqual([]);
  expect(seen.at(-1)).toMatchObject({ type: "reply.waiting", reason: null });
});

test("a message sent while an earlier one waits goes behind it, and the order holds", async () => {
  const { rpc, typed, state, drain } = setup();
  await rpc("session.send", msg, "phone", { dialogs: true });
  state.tab = { front: false, screen: PROMPT };
  const second = await rpc("session.send", { sessionId: "s1", text: "Then this" }, "phone", {
    dialogs: true,
  });
  expect(second).toEqual({ result: { via: "queued", reason: "dialog" } });
  await drain();
  expect(typed).toEqual(["iterm:Ship it", "iterm:Then this"]);
});

test("a normal prompt is typed at once", async () => {
  const { rpc, typed, state } = setup();
  state.tab = { front: false, screen: PROMPT };
  expect(await rpc("session.send", msg, "phone", { dialogs: true })).toEqual({ result: { via: "iterm" } });
  expect(typed).toEqual(["iterm:Ship it"]);
});

const STATUS = ["  Working on it", "  · Reading files", "  Esc to cancel"].join("\n");
const LOGIN = ["  Login successful. Press Enter to continue…"].join("\n");

test("a pty chat with a dialog open is held, and nothing is typed", async () => {
  const ptyTyped: string[] = [];
  const { rpc } = setup(
    { pty: "/p.sock", ptyToken: "t" },
    {
      ptyScreen: async () => THEME,
      pty: async (_s, _t, _p, text) => {
        ptyTyped.push(text);
        return { ok: true };
      },
    },
  );
  const out = await rpc("session.send", msg, "phone", { dialogs: true });
  expect(out).toEqual({ result: { via: "queued", reason: "dialog" } });
  expect(ptyTyped).toEqual([]);
});

test("a tmux chat with a dialog open is held, and nothing is typed", async () => {
  const tmuxTyped: string[] = [];
  const { rpc } = setup(
    { tmux: "/tmp/tmux-1/default,1,0", tmuxPane: "%1" },
    { tmuxScreen: async () => THEME, tmux: async (_s, _p, text) => void tmuxTyped.push(text) },
  );
  const out = await rpc("session.send", msg, "phone", { dialogs: true });
  expect(out).toEqual({ result: { via: "queued", reason: "dialog" } });
  expect(tmuxTyped).toEqual([]);
});

test("a screen with no prompt on it is held, not typed into", async () => {
  for (const screen of [STATUS, LOGIN]) {
    const { rpc, typed, state } = setup();
    state.tab = { front: false, screen };
    const out = await rpc("session.send", msg, "phone", { dialogs: true });
    expect(out).toEqual({ result: { via: "queued", reason: "dialog" } });
    expect(typed).toEqual([]);
  }
});

test("the same send repeated while it is held still says dialog", async () => {
  const { rpc } = setup();
  await rpc("session.send", msg, "phone", { dialogs: true });
  const again = await rpc("session.send", msg, "phone", { dialogs: true });
  expect(again).toEqual({ result: { via: "queued", reason: "dialog", repeat: true } });
});

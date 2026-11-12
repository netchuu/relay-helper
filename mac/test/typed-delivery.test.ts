import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import {
  type DeliverOptions,
  DeliveryError,
  deliver,
  PAUSE_SECONDS,
  TYPE_ANYWAY_MS,
  type TypeOps,
  WaitForPause,
  WaitForUnlock,
} from "../src/daemon/inject.ts";
import { afterBreak, promptDraft } from "../src/daemon/promptLine.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { deliverQueued, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { parsePeek } from "../src/platform/darwin.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView, TypingRoute } from "../src/platform/types.ts";
import { answerRequest, DraftTracker, type RequestContext } from "../src/shell/ptyShell.ts";

// A phone message is always typed into its terminal, never sent through the inbox. When typing now could
// mix into what the person at the Mac is typing, it waits for a pause.

const RULE = "─".repeat(100);
/** What Claude Code 2.1.319 shows in tmux (`capture-pane -p`), with `prompt` in its input. */
const claudeScreen = (...prompt: string[]) =>
  [
    " ▐▛███▜▌   Claude Code v2.1.319",
    "",
    "⏺ Done. The tests pass.",
    "",
    "                                                                                  ● high · /effort",
    RULE,
    ...prompt,
    RULE,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
const EMPTY = claudeScreen("❯ ");
const PLACEHOLDER = claudeScreen('❯ Try "fix typecheck errors"');
const DRAFT = claudeScreen("❯ also check the signup");

describe("the prompt line (promptDraft)", () => {
  test("an empty prompt, or its dimmed suggestion, holds no draft", () => {
    expect(promptDraft(EMPTY)).toBeNull();
    expect(promptDraft(PLACEHOLDER)).toBeNull();
    expect(promptDraft(claudeScreen("❯"))).toBeNull();
  });

  test("text in the prompt is a draft, over several lines too", () => {
    expect(promptDraft(DRAFT)).toBe("also check the signup");
    expect(promptDraft(claudeScreen("❯ hello draftline two", "  line three"))).toBe(
      "hello draftline two\nline three",
    );
    // Shell mode.
    expect(promptDraft(claudeScreen("! git status"))).toBe("git status");
  });

  test("the older box, with `>`", () => {
    const box = (inner: string) =>
      [
        "╭──────────────────────────╮",
        `│ > ${inner.padEnd(23)}│`,
        "╰──────────────────────────╯",
        "  ? for shortcuts",
      ].join("\n");
    expect(promptDraft(box(""))).toBeNull();
    expect(promptDraft(box("half a thought"))).toBe("half a thought");
  });

  test("nothing to read: no prompt line, a dialog, a bare shell", () => {
    expect(promptDraft("")).toBeNull();
    expect(promptDraft("me@mac ~ % ls\nREADME.md\nme@mac ~ % ")).toBeNull();
    // The folder-trust dialog has one rule and a `❯` menu: not a prompt.
    expect(
      promptDraft(
        [RULE, " Accessing workspace:", "", " ❯ No, exit", "   Yes, I trust this folder"].join("\n"),
      ),
    ).toBeNull();
    // Two rules with something else between them.
    expect(promptDraft([RULE, "  1. Yes", "  2. No", RULE].join("\n"))).toBeNull();
  });

  test("only the last prompt line counts, not a rule further up", () => {
    expect(promptDraft([RULE, "❯ old", RULE, "output", EMPTY].join("\n"))).toBeNull();
  });

  test("a clean break before the phone's text", () => {
    expect(afterBreak("from the phone")).toBe("\n\nfrom the phone");
  });
});

describe("the iTerm2 peek's answer (parsePeek)", () => {
  test("front or back, then the tab's text", () => {
    expect(parsePeek(`front\n${DRAFT}`)).toEqual({ front: true, screen: DRAFT });
    expect(parsePeek("back\n❯ ")).toEqual({ front: false, screen: "❯ " });
    expect(parsePeek("back")).toEqual({ front: false, screen: null });
    expect(parsePeek("not-found")).toBeNull();
    expect(parsePeek("no-app")).toBeNull();
    expect(parsePeek("")).toBeNull();
  });
});

/** A fake set of terminals: records what was typed where, and what it was asked. */
function fakeTerminals(init: {
  tab?: TabView | null;
  tmuxScreen?: string | null;
  pty?: (force: boolean) => { ok: true } | { ok: false; reason: "typing" | "draft" | "not_foreground" };
}) {
  const state = { tab: init.tab ?? null, tmuxScreen: init.tmuxScreen ?? null };
  const typed: string[] = [];
  const ptyCalls: boolean[] = [];
  const ops: TypeOps = {
    pty: async (_s, _t, _p, text, force) => {
      ptyCalls.push(force);
      const reply = init.pty ? init.pty(force) : { ok: true as const };
      if (reply.ok) typed.push(`pty:${text}`);
      return reply;
    },
    tmuxScreen: async () => state.tmuxScreen,
    tmux: async (_s, _p, text) => void typed.push(`tmux:${text}`),
    routes: (t) => (t === "iTerm.app" || !t ? ["iterm"] : []),
    ttyOf: async (pid) => (pid ? "/dev/ttys004" : null),
    peek: async (_r: TypingRoute) => state.tab,
    inFront: async () => true,
    type: async (route, _tty, text) => {
      typed.push(`${route}:${text}`);
      return true;
    },
  };
  return { ops, typed, ptyCalls, state };
}

/** A temporary inbox socket that records what Claude Code would receive. */
async function inbox(): Promise<{ path: string; got: string[]; server: Server }> {
  const path = join(mkdtempSync(join(tmpdir(), "relay-typed-")), "in.sock");
  const got: string[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
    });
    c.on("end", () => {
      for (const line of buf.trim().split("\n")) {
        const msg = JSON.parse(line);
        if (msg.type === "user") got.push(msg.message.content);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, got, server };
}

function setup(env: HookEnv) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const notices: string[] = [];
  events.subscribe((e: RelayEvent) => {
    if (e.type === "session.notice") notices.push(e.text);
  });
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  const queue = new ReplyQueue(db, events, registry);
  const session = () => registry.get("s1") as SessionRecord;
  return { db, events, registry, queue, notices, session };
}

const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };
const opts = (idleSeconds: number | null, more: Partial<DeliverOptions> = {}): DeliverOptions => ({
  idleSeconds,
  userTypingNow: idleSeconds !== null && idleSeconds < 8,
  preferTyping: true,
  ...more,
});

describe("deliver: typed into the terminal, or waiting for a pause", () => {
  test("tab in front and the Mac in use: waits (never the inbox); after a pause it's typed", async () => {
    const box = await inbox();
    const s = setup({ ...ITERM, socket: box.path });
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    const err = await deliver(s.session(), "check the build", opts(0.5), t.ops).catch((e) => e);
    expect(err).toBeInstanceOf(WaitForPause);
    expect(err).toMatchObject({ route: "iterm", reason: "typing" });
    expect(t.typed).toEqual([]);
    expect(await deliver(s.session(), "check the build", opts(PAUSE_SECONDS), t.ops)).toEqual({
      via: "iterm",
    });
    expect(t.typed).toEqual(["iterm:check the build"]);
    await Bun.sleep(30);
    expect(box.got).toEqual([]);
    box.server.close();
  });

  test("another tab or app in front: typed at once, even while you type", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: EMPTY } });
    expect(await deliver(s.session(), "hi", opts(0), t.ops)).toEqual({ via: "iterm" });
  });

  test("a draft in the prompt: waits even with the keyboard still; after TYPE_ANYWAY_MS, after a clean break", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT } });
    const err = await deliver(s.session(), "deploy it", opts(600), t.ops).catch((e) => e);
    expect(err).toMatchObject({ route: "iterm", reason: "draft" });
    expect(t.typed).toEqual([]);
    expect(await deliver(s.session(), "deploy it", opts(0.2, { typeAnyway: true }), t.ops)).toEqual({
      via: "iterm",
    });
    expect(t.typed).toEqual(["iterm:\n\ndeploy it"]);
  });

  test("an unknown idle time doesn't count as typing", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: null } });
    expect(await deliver(s.session(), "x", opts(null), t.ops)).toEqual({ via: "iterm" });
  });

  test("tmux: any input at the Mac waits (it can't tell which pane you look at); a draft waits too", async () => {
    const s = setup({
      tmux: "/tmp/tmux-501/default,1,0",
      tmuxPane: "%3",
      claudePid: 4242,
      termProgram: "tmux",
    });
    const t = fakeTerminals({ tmuxScreen: EMPTY });
    await expect(deliver(s.session(), "x", opts(1), t.ops)).rejects.toMatchObject({
      route: "tmux",
      reason: "typing",
    });
    t.state.tmuxScreen = DRAFT;
    await expect(deliver(s.session(), "x", opts(60), t.ops)).rejects.toMatchObject({
      route: "tmux",
      reason: "draft",
    });
    t.state.tmuxScreen = EMPTY;
    expect(await deliver(s.session(), "x", opts(60), t.ops)).toEqual({ via: "tmux" });
    // The pane is gone: not a reason to wait, the next route gets its turn.
    t.state.tmuxScreen = null;
    await expect(deliver(s.session(), "x", opts(1), t.ops)).rejects.toBeInstanceOf(DeliveryError);
  });

  test("relay shell (Zed): typing or a draft in that tab waits; after TYPE_ANYWAY_MS it's asked to type anyway", async () => {
    let reply: "typing" | "draft" | null = "typing";
    const s = setup({ pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242, termProgram: "zed" });
    const t = fakeTerminals({
      pty: (force) => (force || !reply ? { ok: true } : { ok: false, reason: reply }),
    });
    await expect(deliver(s.session(), "x", opts(100), t.ops)).rejects.toMatchObject({
      route: "pty",
      reason: "typing",
    });
    reply = "draft";
    await expect(deliver(s.session(), "x", opts(100), t.ops)).rejects.toMatchObject({
      route: "pty",
      reason: "draft",
    });
    expect(await deliver(s.session(), "x", opts(100, { typeAnyway: true }), t.ops)).toEqual({ via: "pty" });
    expect(t.ptyCalls).toEqual([false, false, true]);
  });

  test("relay shell with the agent not in front: no waiting, the other routes (here the inbox)", async () => {
    const box = await inbox();
    const s = setup({
      pty: "/tmp/pty.sock",
      ptyToken: "tok",
      claudePid: 4242,
      termProgram: "zed",
      socket: box.path,
    });
    const t = fakeTerminals({ pty: () => ({ ok: false, reason: "not_foreground" }) });
    expect(await deliver(s.session(), "x", opts(0), t.ops)).toEqual({ via: "socket" });
    box.server.close();
  });

  test("a session with no typing route (Warp) still uses the inbox, even while you type", async () => {
    const box = await inbox();
    const s = setup({ termProgram: "WarpTerminal", claudePid: 4242, socket: box.path });
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    expect(await deliver(s.session(), "from the phone", opts(0), t.ops)).toEqual({ via: "socket" });
    await Bun.sleep(30);
    expect(box.got).toHaveLength(1);
    expect(box.got[0]).toContain("from the phone");
    box.server.close();
  });

  test("an iTerm2 session whose tab Relay can't find (closed, iTerm2 not running) isn't kept waiting", async () => {
    const box = await inbox();
    const s = setup({ ...ITERM, socket: box.path });
    const t = fakeTerminals({ tab: null });
    expect(await deliver(s.session(), "x", opts(0), t.ops)).toEqual({ via: "socket" });
    box.server.close();
  });
});

describe("session.send: waits for a pause, in order", () => {
  const read = platform.presence.read;
  let idle: number | null = 0;
  beforeEach(() => {
    idle = 0;
    platform.presence.read = async () => ({ idleSeconds: idle, locked: false, source: "test" });
  });
  afterEach(() => {
    platform.presence.read = read;
  });

  function rpcFor(s: ReturnType<typeof setup>, ops: TypeOps, extra: Partial<RpcDeps> = {}) {
    return createRpc({
      db: s.db,
      events: s.events,
      registry: s.registry,
      replies: s.queue,
      broker: { hasOpen: () => false },
      config: { preferTyping: true },
      typeOps: ops,
      pauseWait: { inlineMs: 400, pollMs: 20 },
      ...extra,
    } as unknown as RpcDeps);
  }

  test("tab in front and the Mac in use: the reply waits for the pause, then is typed (not the inbox)", async () => {
    const box = await inbox();
    const s = setup({ ...ITERM, socket: box.path });
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    setTimeout(() => {
      idle = PAUSE_SECONDS + 0.5;
    }, 100);
    const res = await rpcFor(s, t.ops)("session.send", { sessionId: "s1", text: "two photos" }, "phone");
    expect(res).toEqual({ result: { via: "iterm" } });
    expect(t.typed).toEqual(["iterm:two photos"]);
    expect(s.queue.list()).toEqual([]);
    await Bun.sleep(30);
    expect(box.got).toEqual([]);
    box.server.close();
  });

  test("still typing when the phone's reply is due: answered queued at once, then typed after the pause", async () => {
    const box = await inbox();
    const s = setup({ ...ITERM, socket: box.path });
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    const rpc = rpcFor(s, t.ops);
    const started = Date.now();
    expect(await rpc("session.send", { sessionId: "s1", text: "one" }, "phone")).toEqual({
      result: { via: "queued", reason: "typing" },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.queue.list().map((r) => [r.text, r.waitsFor])).toEqual([["one", "pause"]]);
    // Still typing: the drain leaves it.
    const deliverIt = deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: t.ops });
    await s.queue.drain(false, deliverIt);
    expect(t.typed).toEqual([]);
    idle = 5;
    await s.queue.drain(false, deliverIt);
    expect(t.typed).toEqual(["iterm:one"]);
    expect(s.queue.list()).toEqual([]);
    expect(box.got).toEqual([]);
    box.server.close();
  });

  test("several waiting messages arrive in the order they were sent", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    const rpc = rpcFor(s, t.ops);
    // Sent close together (another phone, or the same one): each waits behind the one before.
    const results = await Promise.all(
      ["first", "second", "third"].map((text) => rpc("session.send", { sessionId: "s1", text }, "phone")),
    );
    expect(results).toEqual([1, 2, 3].map(() => ({ result: { via: "queued", reason: "typing" } })));
    expect(s.queue.list().map((r) => r.text)).toEqual(["first", "second", "third"]);
    // A fourth while they wait goes behind them, without waiting itself.
    expect(await rpc("session.send", { sessionId: "s1", text: "fourth" }, "phone")).toEqual({
      result: { via: "queued", reason: "typing" },
    });
    idle = 10;
    await s.queue.drain(
      false,
      deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: t.ops }),
    );
    expect(t.typed).toEqual(["iterm:first", "iterm:second", "iterm:third", "iterm:fourth"]);
  });

  test("a message that comes in while an earlier one waits for the pause goes after it", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    const rpc = rpcFor(s, t.ops, { pauseWait: { inlineMs: 2_000, pollMs: 20 } });
    const first = rpc("session.send", { sessionId: "s1", text: "first" }, "phone");
    await Bun.sleep(50);
    const second = rpc("session.send", { sessionId: "s1", text: "second" }, "phone");
    await Bun.sleep(50);
    idle = 4;
    expect(await first).toEqual({ result: { via: "iterm" } });
    expect(await second).toEqual({ result: { via: "iterm" } });
    expect(t.typed).toEqual(["iterm:first", "iterm:second"]);
  });

  test("a draft in the prompt: waits for it to be sent or cleared", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT } });
    idle = 30;
    setTimeout(() => {
      t.state.tab = { front: false, screen: EMPTY };
    }, 100);
    expect(await rpcFor(s, t.ops)("session.send", { sessionId: "s1", text: "after you" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(t.typed).toEqual(["iterm:after you"]);
  });

  test("still waiting after TYPE_ANYWAY_MS: typed anyway, after a clean break from a draft", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: DRAFT } });
    s.queue.add("s1", "waited", 1_000, "pause");
    const at = (now: number) =>
      deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: t.ops, now: () => now });
    await s.queue.drain(false, at(1_000 + TYPE_ANYWAY_MS - 1), 1_000 + TYPE_ANYWAY_MS - 1);
    expect(t.typed).toEqual([]);
    await s.queue.drain(false, at(1_000 + TYPE_ANYWAY_MS), 1_000 + TYPE_ANYWAY_MS);
    expect(t.typed).toEqual(["iterm:\n\nwaited"]);
  });

  test("a question open in the session: the waiting reply isn't typed into it", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: EMPTY } });
    s.queue.add("s1", "later", 1, "pause");
    let open = true;
    const deliverIt = deliverQueued({ preferTyping: true, hasOpenPrompt: () => open, typeOps: t.ops });
    await s.queue.drain(false, deliverIt, 10);
    expect(t.typed).toEqual([]);
    open = false;
    await s.queue.drain(false, deliverIt, 10);
    expect(t.typed).toEqual(["iterm:later"]);
  });

  test("relay shell already waited for that tab: queued at once instead of asking it again", async () => {
    const s = setup({ pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242, termProgram: "zed" });
    const t = fakeTerminals({ pty: () => ({ ok: false, reason: "typing" }) });
    const res = await rpcFor(s, t.ops, { pauseWait: { inlineMs: 5_000, pollMs: 20 } })(
      "session.send",
      { sessionId: "s1", text: "x" },
      "phone",
    );
    expect(res).toEqual({ result: { via: "queued", reason: "typing" } });
    expect(t.ptyCalls).toEqual([false]);
  });

  test("a session without a typing route still uses the inbox at once, while you type", async () => {
    const box = await inbox();
    const s = setup({ termProgram: "ghostty", claudePid: 4242, socket: box.path });
    const t = fakeTerminals({});
    const res = await rpcFor(s, t.ops)("session.send", { sessionId: "s1", text: "hello" }, "phone");
    expect(res).toEqual({ result: { via: "socket" } });
    expect(s.queue.list()).toEqual([]);
    await Bun.sleep(30);
    expect(box.got).toHaveLength(1);
    box.server.close();
  });
});

// The phone is told why its message waits (locked, typing, or a draft), not always "locked".
describe("why a message waits", () => {
  const read = platform.presence.read;
  let idle: number | null = 0;
  beforeEach(() => {
    idle = 0;
    platform.presence.read = async () => ({ idleSeconds: idle, locked: false, source: "test" });
  });
  afterEach(() => {
    platform.presence.read = read;
  });

  function rpcFor(s: ReturnType<typeof setup>, ops: TypeOps) {
    return createRpc({
      db: s.db,
      events: s.events,
      registry: s.registry,
      replies: s.queue,
      broker: { hasOpen: () => false },
      config: { preferTyping: true },
      typeOps: ops,
      pauseWait: { inlineMs: 100, pollMs: 20 },
    } as unknown as RpcDeps);
  }
  /** The reply.waiting events a session's queue sent, in order. */
  function waitingEvents(s: ReturnType<typeof setup>) {
    const seen: (string | null)[] = [];
    s.events.subscribe((e: RelayEvent) => {
      if (e.type === "reply.waiting") seen.push(e.reason);
    });
    return seen;
  }

  test("a draft in the terminal: queued with reason draft, and the draft going sends it within a drain", async () => {
    const s = setup(ITERM);
    const seen = waitingEvents(s);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT } });
    idle = 600;
    const res = await rpcFor(s, t.ops)("session.send", { sessionId: "s1", text: "new bug" }, "phone");
    expect(res).toEqual({ result: { via: "queued", reason: "draft" } });
    const deliverIt = deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: t.ops });
    await s.queue.drain(false, deliverIt);
    expect(t.typed).toEqual([]);
    expect(seen).toEqual(["draft"]);
    // The draft is sent at the Mac: the message goes, and the phone hears nothing waits.
    t.state.tab = { front: false, screen: EMPTY };
    await s.queue.drain(false, deliverIt);
    expect(t.typed).toEqual(["iterm:new bug"]);
    expect(seen).toEqual(["draft", null]);
  });

  test("typing right now: reason typing; the reason changes to draft when the typing stops with text left", async () => {
    const s = setup(ITERM);
    const seen = waitingEvents(s);
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    const res = await rpcFor(s, t.ops)("session.send", { sessionId: "s1", text: "x" }, "phone");
    expect(res).toEqual({ result: { via: "queued", reason: "typing" } });
    const deliverIt = deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: t.ops });
    await s.queue.drain(false, deliverIt);
    idle = 30;
    t.state.tab = { front: true, screen: DRAFT };
    await s.queue.drain(false, deliverIt);
    expect(seen).toEqual(["typing", "draft"]);
    expect(t.typed).toEqual([]);
  });

  test("a locked Mac (desktop app): reason locked, and nothing waits once it is unlocked and typed", async () => {
    const s = setup({ termProgram: "ghostty", claudePid: 4242 });
    const seen = waitingEvents(s);
    s.queue.add("s1", "later", 1, "unlock");
    await s.queue.drain(true, async () => {});
    await s.queue.drain(true, async () => {});
    expect(seen).toEqual(["locked"]);
    await s.queue.drain(false, async () => {});
    expect(seen).toEqual(["locked", null]);
    expect(s.queue.list()).toEqual([]);
  });

  test("a message behind one that waits gets the same reason", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT } });
    idle = 600;
    const rpc = rpcFor(s, t.ops);
    expect(await rpc("session.send", { sessionId: "s1", text: "one" }, "phone")).toEqual({
      result: { via: "queued", reason: "draft" },
    });
    expect(await rpc("session.send", { sessionId: "s1", text: "two" }, "phone")).toEqual({
      result: { via: "queued", reason: "draft" },
    });
  });

  test("a question open at the Mac has no wording of its own: no reason is sent", async () => {
    const s = setup(ITERM);
    const seen = waitingEvents(s);
    s.queue.add("s1", "later", 1, "pause");
    const t = fakeTerminals({ tab: { front: false, screen: EMPTY } });
    await s.queue.drain(
      false,
      deliverQueued({ preferTyping: true, hasOpenPrompt: () => true, typeOps: t.ops }),
      10,
    );
    expect(seen).toEqual([]);
  });

  test("a question opening after a draft clears the stale draft reason (the reply still waits)", async () => {
    const s = setup(ITERM);
    const seen = waitingEvents(s);
    s.queue.add("s1", "later", 1, "pause");
    const t = fakeTerminals({ tab: { front: false, screen: EMPTY } });
    s.queue.setReason("s1", "draft");
    await s.queue.drain(
      false,
      deliverQueued({ preferTyping: true, hasOpenPrompt: () => true, typeOps: t.ops }),
      10,
    );
    expect(seen).toEqual(["draft", null]);
    expect(s.queue.list().map((r) => r.text)).toEqual(["later"]);
  });

  test("a send that arrives while a reply is being delivered: the phone isn't told nothing waits", async () => {
    const s = setup(ITERM);
    const seen = waitingEvents(s);
    s.queue.add("s1", "first", 1, "pause");
    await s.queue.drain(
      false,
      async () => {
        s.queue.add("s1", "second", 2, "pause");
        s.queue.setReason("s1", "draft");
      },
      10,
    );
    expect(s.queue.list().map((r) => r.text)).toEqual(["second"]);
    expect(seen).toEqual(["draft"]);
    expect(s.queue.reasonOf("s1")).toBe("draft");
  });

  test("the sessions' reasons are separate", async () => {
    const s = setup(ITERM);
    s.registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    const seen: string[] = [];
    s.events.subscribe((e: RelayEvent) => {
      if (e.type === "reply.waiting") seen.push(`${e.sessionId}:${e.reason}`);
    });
    s.queue.setReason("s1", "draft");
    s.queue.setReason("s2", "locked");
    s.queue.setReason("s1", "draft");
    expect(seen).toEqual(["s1:draft", "s2:locked"]);
    expect(s.queue.reasonOf("s1")).toBe("draft");
  });
});

describe("the reply queue with pause waits", () => {
  test("while locked, a reply waiting for a pause is still typed; one waiting for the unlock isn't", async () => {
    const s = setup(ITERM);
    s.registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    s.queue.add("s2", "for the desktop app", 1, "unlock");
    s.queue.add("s1", "for iTerm2", 2, "pause");
    const sent: string[] = [];
    await s.queue.drain(true, async (session, text) => void sent.push(`${session.id}:${text}`), 10);
    expect(sent).toEqual(["s1:for iTerm2"]);
    expect(s.queue.list().map((r) => r.text)).toEqual(["for the desktop app"]);
  });

  test("one session waiting for a pause doesn't hold another back", async () => {
    const s = setup(ITERM);
    s.registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    s.queue.add("s1", "a", 1, "pause");
    s.queue.add("s1", "b", 2, "pause");
    s.queue.add("s2", "c", 3, "pause");
    const sent: string[] = [];
    await s.queue.drain(
      false,
      async (session, text) => {
        if (session.id === "s1") throw new WaitForPause("iterm", "typing");
        sent.push(text);
      },
      10,
    );
    expect(sent).toEqual(["c"]);
    expect(s.queue.list().map((r) => r.text)).toEqual(["a", "b"]);
  });

  test("the session ended while its reply waited for a pause: dropped with its own notice", async () => {
    const s = setup(ITERM);
    s.queue.add("s1", "late", 1, "pause");
    s.registry.setStatus("s1", "ended");
    await s.queue.drain(false, async () => {}, 10);
    expect(s.queue.list()).toEqual([]);
    expect(s.notices).toEqual([
      "Your message to web-shop wasn't sent: the session ended before it could be typed in.",
    ]);
  });

  test("a reply queued before this version waits for the unlock, as it did", () => {
    const path = join(mkdtempSync(join(tmpdir(), "relay-typed-")), "relay.db");
    const old = openDb(path);
    old.exec(
      "DROP TABLE queued_replies; CREATE TABLE queued_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL); PRAGMA user_version = 12;",
    );
    old.query("INSERT INTO queued_replies (session_id, text, created_at) VALUES ('s1', 'kept', 5)").run();
    old.close();
    const db = openDb(path);
    const events = new EventLog(db);
    const queue = new ReplyQueue(db, events, new Registry(db, events));
    expect(queue.list().map((r) => [r.text, r.createdAt, r.waitsFor])).toEqual([["kept", 5, "unlock"]]);
    queue.add("s1", "new", 6, "pause");
    expect(queue.list().map((r) => r.waitsFor)).toEqual(["unlock", "pause"]);
    expect(queue.list()[1]?.id).toBeGreaterThan(queue.list()[0]?.id ?? Infinity);
  });

  test("WaitForUnlock still keeps the order, as before", async () => {
    const s = setup(ITERM);
    s.queue.add("s1", "a", 1);
    s.queue.add("s1", "b", 2);
    await s.queue.drain(
      false,
      async () => {
        throw new WaitForUnlock("locked");
      },
      10,
    );
    expect(s.queue.list().map((r) => [r.text, r.waitsFor])).toEqual([
      ["a", "unlock"],
      ["b", "unlock"],
    ]);
  });
});

describe("relay shell: drafts and typing anyway", () => {
  function ctx(over: Partial<RequestContext> = {}) {
    const written: string[] = [];
    let t = 100_000;
    const c: RequestContext = {
      token: "tok",
      shellPid: 1,
      isForeground: async () => true,
      lastInput: () => 0,
      hasDraft: () => false,
      pasteOn: () => true,
      write: (d) => void written.push(d),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      ...over,
    };
    return { c, written, advance: (ms: number) => (t += ms), now: () => t };
  }
  const req = (more: object = {}) => JSON.stringify({ token: "tok", pid: 7, text: "hi", ...more });

  test("a draft in the prompt: refused as draft, nothing written", async () => {
    const { c, written } = ctx({ hasDraft: () => true });
    expect(await answerRequest(req(), c)).toEqual({ ok: false, reason: "draft" });
    expect(written).toEqual([]);
  });

  test("force: typed at once while you type, after a clean break from a draft", async () => {
    const x = ctx({ hasDraft: () => true });
    x.c.lastInput = () => x.now();
    expect(await answerRequest(req({ force: true }), x.c)).toEqual({ ok: true });
    expect(x.written).toEqual(["\x1b[200~\n\nhi\x1b[201~", "\r"]);
  });

  test("no draft: typed as before", async () => {
    const { c, written } = ctx();
    expect(await answerRequest(req(), c)).toEqual({ ok: true });
    expect(written).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
  });

  test("a key that answered a dialog stops counting as a draft once you stop typing", () => {
    let t = 1_000;
    const d = new DraftTracker(() => t);
    d.feed("1");
    expect(d.pending).toBe(true);
    t += DraftTracker.STALE_MS - 1;
    expect(d.pending).toBe(true);
    t += 1;
    expect(d.pending).toBe(false);
    // Typing again counts again.
    d.feed("fix");
    expect(d.pending).toBe(true);
  });

  test("a real draft you paused on for minutes is still a draft", () => {
    let t = 1_000;
    const d = new DraftTracker(() => t);
    d.feed("fix the failing test in");
    t += 10 * 60_000;
    expect(d.pending).toBe(true);
    t += DraftTracker.LONG_STALE_MS;
    expect(d.pending).toBe(false);
  });

  test("the draft follows what you type: Enter sends it, Ctrl+U, Ctrl+C and Esc Esc clear it", () => {
    const d = new DraftTracker();
    expect(d.pending).toBe(false);
    d.feed("fix th");
    expect(d.pending).toBe(true);
    d.feed("e test\r");
    expect(d.pending).toBe(false);
    d.feed("ab");
    d.feed("\x7f\x7f");
    expect(d.pending).toBe(false);
    for (const clear of ["\x15", "\x03", "\x1b\x1b"]) {
      d.feed("draft");
      d.feed(clear);
      expect(d.pending).toBe(false);
    }
    // Arrow keys don't type anything; Option+Enter is a new line, not a send.
    d.feed("\x1b[A\x1b[B\x1bOC");
    expect(d.pending).toBe(false);
    d.feed("line one\x1b\r");
    expect(d.pending).toBe(true);
    d.feed("\r");
    // A paste counts; an empty one doesn't.
    d.feed("\x1b[200~\x1b[201~");
    expect(d.pending).toBe(false);
    d.feed("\x1b[200~pasted\ntext\x1b[201~");
    expect(d.pending).toBe(true);
  });
});

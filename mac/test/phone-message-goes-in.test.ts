import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { clearDraftKept, deliver, draftSubmitted, type GuiOps, type TypeOps } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { platform } from "../src/platform/index.ts";
import type { TypingRoute } from "../src/platform/types.ts";

// A phone message is typed in at once: a draft is stashed, typing at the Mac or a locked screen make no wait.

const RULE = "─".repeat(100);
const screen = (prompt: string) =>
  ["⏺ Done.", RULE, `❯ ${prompt}`, RULE, "  ⏵⏵ bypass permissions on"].join("\n");
const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };
const TMUX: HookEnv = { tmux: "/tmp/tmux-501/default,1,0", tmuxPane: "%3", claudePid: 4242 };

function rig(env: HookEnv) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  const queue = new ReplyQueue(db, events, registry);
  clearDraftKept("s1");
  return { db, events, registry, queue, session: registry.get("s1") as SessionRecord };
}

/** A terminal whose prompt holds `prompt`; Ctrl+S empties it and Claude Code brings it back when a message is sent. */
function terminal(prompt: string) {
  const state = { prompt, stashed: "", log: [] as string[] };
  const stash = () => {
    state.log.push("stash");
    state.stashed = state.prompt;
    state.prompt = "";
  };
  const type = (text: string) => {
    state.log.push(`type:${text}`);
    state.prompt = text;
    // Sent: the prompt is empty, and the stashed draft is back.
    state.prompt = state.stashed;
    state.stashed = "";
  };
  const ops: TypeOps = {
    pty: async () => ({ ok: true }),
    tmuxScreen: async () => screen(state.prompt),
    tmux: async (_s, _p, text) => type(text),
    tmuxStash: async () => stash(),
    routes: (t) => (t === "iTerm.app" ? (["iterm"] as TypingRoute[]) : []),
    ttyOf: async () => "/dev/ttys004",
    peek: async () => ({ front: true, screen: screen(state.prompt) }),
    type: async (_r, _t, text) => {
      type(text);
      return true;
    },
    stash: async () => {
      stash();
      return true;
    },
    inFront: async () => true,
    sleep: async () => {},
  };
  return { ops, state };
}

const opts = { userTypingNow: false, preferTyping: true };

describe("what the phone's message does with the prompt", () => {
  test("a draft: the message is typed at once, and the draft is back in the prompt afterwards", async () => {
    const t = terminal("also check the signup");
    expect(await deliver(rig(TMUX).session, "deploy it", opts, t.ops)).toEqual({ via: "tmux" });
    expect(t.state.log).toEqual(["stash", "type:deploy it"]);
    expect(t.state.prompt).toBe("also check the signup");
  });

  test("only the suggestion is shown: typed at once, nothing stashed or put back", async () => {
    const t = terminal("\u001b[7mc\u001b[27m\u001b[2montinue, but use edit tool\u001b[22m");
    expect(await deliver(rig(TMUX).session, "deploy it", opts, t.ops)).toEqual({ via: "tmux" });
    expect(t.state.log).toEqual(["type:deploy it"]);
    expect(t.state.prompt).toBe("");
  });

  test("a stash that leaves the draft in the prompt: the message goes after a clean break, never into it", async () => {
    const t = terminal("my draft");
    t.ops.tmuxStash = async () => void t.state.log.push("stash");
    await deliver(rig(TMUX).session, "deploy it", opts, t.ops);
    expect(t.state.log).toEqual(["stash", "type:\n\ndeploy it"]);
  });

  test("a draft on iTerm2, with no key pressed since the prompt, is kept for the next message too", async () => {
    const t = terminal("my draft");
    let noKey = false;
    t.ops.noKeySincePrompt = () => noKey;
    const { session } = rig(ITERM);
    await deliver(session, "one", opts, t.ops);
    noKey = true;
    await deliver(session, "two", opts, t.ops);
    expect(t.state.log).toEqual(["stash", "type:one", "stash", "type:two"]);
    expect(t.state.prompt).toBe("my draft");
  });
});

describe("a kept draft after the person sent it", () => {
  test("Claude Code suggests the same text later: it is a suggestion, nothing is stashed", async () => {
    const t = terminal("commit this");
    let noKey = false;
    t.ops.noKeySincePrompt = () => noKey;
    const { session } = rig(ITERM);
    await deliver(session, "one", opts, t.ops);
    draftSubmitted("s1", "commit this");
    t.state.log.length = 0;
    noKey = true;
    await deliver(session, "two", opts, t.ops);
    expect(t.state.log).toEqual(["type:two"]);
  });
});

describe("a kept draft and the UserPromptSubmit hook", () => {
  function submitter(r: ReturnType<typeof rig>) {
    const hooks = new HookHandler({
      db: r.db,
      events: r.events,
      registry: r.registry,
      broker: new Broker(r.db, r.events),
      presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
      config: { previewChars: 600 } as RelayConfig,
    });
    return (prompt: string) =>
      hooks.handle(
        {
          payload: {
            hook_event_name: "UserPromptSubmit",
            session_id: "s1",
            cwd: "/Users/me/Projects/web-shop",
            prompt,
          },
          env: {},
        },
        new AbortController().signal,
      );
  }

  test("the phone's own message, equal to the draft, is submitted: the draft is still kept", async () => {
    const t = terminal("yes");
    let noKey = false;
    t.ops.noKeySincePrompt = () => noKey;
    const r = rig(ITERM);
    const submit = submitter(r);
    await deliver(r.session, "yes", opts, t.ops);
    await submit("yes");
    t.state.log.length = 0;
    noKey = true;
    await deliver(r.session, "two", opts, t.ops);
    expect(t.state.log).toEqual(["stash", "type:two"]);
  });

  test("a draft the person edits before sending is forgotten, so the same suggestion later is not stashed", async () => {
    const t = terminal("commit this");
    let noKey = false;
    t.ops.noKeySincePrompt = () => noKey;
    const r = rig(ITERM);
    const submit = submitter(r);
    await deliver(r.session, "one", opts, t.ops);
    await submit("commit this and push");
    t.state.log.length = 0;
    noKey = true;
    await deliver(r.session, "two", opts, t.ops);
    expect(t.state.log).toEqual(["type:two"]);
  });
});

describe("session.send: no wait for typing, a draft or a locked Mac", () => {
  const read = platform.presence.read;
  let locked = false;
  beforeEach(() => {
    locked = false;
    platform.presence.read = async () => ({ idleSeconds: 0, locked, source: "test" });
  });
  afterEach(() => {
    platform.presence.read = read;
  });

  function rpcFor(r: ReturnType<typeof rig>, ops: TypeOps) {
    return createRpc({
      db: r.db,
      events: r.events,
      registry: r.registry,
      replies: r.queue,
      broker: { hasOpen: () => false },
      config: { preferTyping: true },
      typeOps: ops,
    } as unknown as RpcDeps);
  }

  test("keys pressed on the Mac a moment ago and a draft: typed at once, the draft kept, nothing queued", async () => {
    const r = rig(TMUX);
    const t = terminal("half a thought");
    const res = await rpcFor(r, t.ops)("session.send", { sessionId: "s1", text: "go on" }, "phone");
    expect(res).toEqual({ result: { via: "tmux" } });
    expect(t.state.log).toEqual(["stash", "type:go on"]);
    expect(t.state.prompt).toBe("half a thought");
    expect(r.queue.list()).toEqual([]);
  });

  test("a locked Mac with a terminal route: typed at once", async () => {
    locked = true;
    const r = rig(TMUX);
    const t = terminal("");
    const res = await rpcFor(r, t.ops)("session.send", { sessionId: "s1", text: "go on" }, "phone");
    expect(res).toEqual({ result: { via: "tmux" } });
    expect(r.queue.list()).toEqual([]);
  });

  test("a locked Mac with only the desktop app and no inbox socket: fails at once with a plain line", async () => {
    locked = true;
    const r = rig({ claudePid: 4242 });
    const gui: GuiOps = {
      desktopReady: async () => true,
      sendToDesktop: async () => "locked",
      isIdeSession: () => false,
      axAllowed: () => true,
      sendToIde: async () => "failed",
    };
    const t = terminal("");
    t.ops.gui = gui;
    const res = await rpcFor(r, t.ops)("session.send", { sessionId: "s1", text: "hi" }, "phone");
    expect(res).toEqual({
      error: { code: "unavailable", message: "Unlock your Mac to send to the Claude app" },
    });
    expect(r.queue.list()).toEqual([]);
  });

  for (const [name, ide] of [
    ["desktop app", false],
    ["editor", true],
  ] as const) {
    test(`a locked Mac with the ${name} and an inbox socket: the socket takes the message`, async () => {
      locked = true;
      const dir = mkdtempSync(join(tmpdir(), "relay-inbox-"));
      const sock = join(dir, "i.sock");
      const server = createServer((c) => c.on("data", () => {}));
      await new Promise<void>((ok) => server.listen(sock, ok));
      const r = rig({ claudePid: 4242, socket: sock });
      let toGui = 0;
      const gui: GuiOps = {
        desktopReady: async () => true,
        sendToDesktop: async () => (toGui++, "locked"),
        isIdeSession: () => ide,
        axAllowed: () => true,
        sendToIde: async () => (toGui++, "locked"),
      };
      const t = terminal("");
      t.ops.gui = gui;
      const res = await rpcFor(r, t.ops)("session.send", { sessionId: "s1", text: "hi" }, "phone");
      server.close();
      rmSync(dir, { recursive: true, force: true });
      expect(res).toEqual({ result: { via: "socket" } });
      expect(toGui).toBe(0);
      expect(r.queue.list()).toEqual([]);
    });
  }
});

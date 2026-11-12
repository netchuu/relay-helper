import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type DeliverOptions, deliver, type TypeOps, typingRouteFor } from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView } from "../src/platform/types.ts";

// A phone message is typed into the session's tab after the session was resumed under a new id, after
// the helper restarted, and when the process's own tty is not a tab (a background host); it goes through the inbox only
// when no lookup finds a tab, and then says so.

const EMPTY: TabView = { front: false, screen: null };

/** Fake terminals: the tabs that exist are the ttys in `tabs`; records every peek and what was typed. */
function terminals(init: { tabs: string[]; ttys?: Record<number, string | null>; viewer?: string | null }) {
  const peeks: string[] = [];
  const typed: string[] = [];
  const ops: TypeOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    routes: (t) => (t === "iTerm.app" || !t ? ["iterm"] : []),
    ttyOf: async (pid) => (pid ? ((init.ttys ?? {})[pid] ?? "/dev/ttys004") : null),
    viewerTtyOf: async () => init.viewer ?? null,
    peek: async (_r, tty) => {
      peeks.push(tty);
      return init.tabs.includes(tty) ? EMPTY : null;
    },
    inFront: async () => true,
    type: async (_r, tty, text) => {
      typed.push(`${tty}:${text}`);
      return true;
    },
  };
  return { ops, peeks, typed };
}

const opts: DeliverOptions = { idleSeconds: 600, userTypingNow: false, preferTyping: true };
const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };

function registryWith() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  return { db, events, registry };
}

async function inboxAt(): Promise<{ path: string; got: string[] }> {
  const path = join(mkdtempSync(join(tmpdir(), "relay-resume-")), "in.sock");
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
  return { path, got };
}

describe("typed delivery after a resume, a restart, a host", () => {
  test("a session resumed under a new id in the same tab is typed into", async () => {
    const { registry } = registryWith();
    registry.touch("old", { cwd: "/p", env: ITERM });
    const t = terminals({ tabs: ["/dev/ttys004"] });
    expect(await deliver(registry.get("old") as SessionRecord, "one", opts, t.ops)).toEqual({ via: "iterm" });
    // `claude --resume`: a new session id, the same process and terminal; its first hook is the only thing that arrives.
    registry.touch("new", { cwd: "/p", env: { termProgram: "iTerm.app", claudePid: 4242 } });
    expect(await deliver(registry.get("new") as SessionRecord, "two", opts, t.ops)).toEqual({ via: "iterm" });
    // `claude --continue` in a new process on the same tty: any later hook reports the new pid.
    registry.touch("new", { cwd: "/p", env: { claudePid: 5151 } });
    const moved = terminals({ tabs: ["/dev/ttys009"], ttys: { 5151: "/dev/ttys009" } });
    expect(await deliver(registry.get("new") as SessionRecord, "three", opts, moved.ops)).toEqual({
      via: "iterm",
    });
    expect(moved.typed).toEqual(["/dev/ttys009:three"]);
  });

  test("after a helper restart a session learnt from one hook (no SessionStart, no terminal name) is typed into", async () => {
    const { registry } = registryWith();
    // A fresh daemon: the first hook it sees is a late one from the running session, carrying the pid only.
    registry.touch("s", { cwd: "/p", env: { claudePid: 4242 } });
    const t = terminals({ tabs: ["/dev/ttys004"] });
    expect(await deliver(registry.get("s") as SessionRecord, "hi", opts, t.ops)).toEqual({ via: "iterm" });
    expect(t.typed).toEqual(["/dev/ttys004:hi"]);
  });

  test("lookup order: the process's tty, then the tab it was typed into before, then the attached tab", async () => {
    const { registry } = registryWith();
    registry.touch("order", { cwd: "/p", env: ITERM });
    const s = () => registry.get("order") as SessionRecord;
    // The process's own tty is a host's: no tab. The tab it is shown in is found through the viewer.
    const host = terminals({
      tabs: ["/dev/ttys014"],
      ttys: { 4242: "/dev/ttys010" },
      viewer: "/dev/ttys014",
    });
    expect(await deliver(s(), "a", opts, host.ops)).toEqual({ via: "iterm" });
    expect(host.peeks).toEqual(["/dev/ttys010", "/dev/ttys014"]);
    expect(host.typed).toEqual(["/dev/ttys014:a"]);
    // The viewer can't be told now, the earlier tab still takes it.
    const later = terminals({ tabs: ["/dev/ttys014"], ttys: { 4242: "/dev/ttys010" } });
    expect(await deliver(s(), "b", opts, later.ops)).toEqual({ via: "iterm" });
    expect(later.peeks).toEqual(["/dev/ttys010", "/dev/ttys014"]);
  });

  test("no tab anywhere: the inbox, and doctor can tell there is no typing route", async () => {
    const { registry } = registryWith();
    const box = await inboxAt();
    registry.touch("closed", { cwd: "/p", env: { ...ITERM, claudePid: 7001, socket: box.path } });
    const t = terminals({ tabs: [] });
    const session = registry.get("closed") as SessionRecord;
    expect(await typingRouteFor(session, t.ops)).toBeNull();
    expect(await deliver(session, "hi", opts, t.ops)).toEqual({ via: "socket" });
    await Bun.sleep(30);
    expect(box.got).toHaveLength(1);
    const ok = terminals({ tabs: ["/dev/ttys004"] });
    registry.touch("open", { cwd: "/p", env: ITERM });
    expect(await typingRouteFor(registry.get("open") as SessionRecord, ok.ops)).toBe("iterm");
  });
});

describe("a photo that has to go through the inbox says so", () => {
  const read = platform.presence.read;
  beforeEach(() => {
    platform.presence.read = async () => ({ idleSeconds: 600, locked: false, source: "test" });
  });
  afterEach(() => {
    platform.presence.read = read;
  });

  function rpcFor(s: ReturnType<typeof registryWith>, ops: TypeOps) {
    return createRpc({
      db: s.db,
      events: s.events,
      registry: s.registry,
      replies: new ReplyQueue(s.db, s.events, s.registry),
      broker: { hasOpen: () => false },
      config: { preferTyping: true },
      typeOps: ops,
      pauseWait: { inlineMs: 100, pollMs: 20 },
      attachments: { forSend: () => [{ path: "/tmp/photo.jpg" }] },
    } as unknown as RpcDeps);
  }

  test("through the inbox: a notice (images arrive as paths); typed: none", async () => {
    const s = registryWith();
    const box = await inboxAt();
    const notices: string[] = [];
    s.events.subscribe((e: RelayEvent) => {
      if (e.type === "session.notice") notices.push(e.text);
    });
    s.registry.touch("a", { cwd: "/p", env: { ...ITERM, claudePid: 7001, socket: box.path } });
    const none = terminals({ tabs: [] });
    const res = await rpcFor(s, none.ops)(
      "session.send",
      { sessionId: "a", text: "look", attachments: ["x"] },
      "phone",
    );
    expect(res).toEqual({ result: { via: "socket" } });
    expect(notices).toEqual(["Sent as a note; images arrive as file paths."]);

    s.registry.touch("b", { cwd: "/p", env: ITERM });
    const tab = terminals({ tabs: ["/dev/ttys004"] });
    const typed = await rpcFor(s, tab.ops)(
      "session.send",
      { sessionId: "b", text: "look", attachments: ["x"] },
      "phone",
    );
    expect(typed).toEqual({ result: { via: "iterm" } });
    expect(notices).toHaveLength(1);
  });
});

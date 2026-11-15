import { expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import {
  type DeliverOptions,
  deliver,
  type KeyOps,
  pressEscape,
  setKnownPids,
  type TypeOps,
} from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { inFront, parseProcs } from "../src/platform/foreground.ts";
import type { TabView } from "../src/platform/types.ts";

const EMPTY: TabView = { front: false, screen: null };
const opts: DeliverOptions = { idleSeconds: 600, userTypingNow: false, preferTyping: true };
const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };

function registry() {
  const db = openDb(":memory:");
  return new Registry(db, new EventLog(db));
}

/** Key transports over a fake iTerm2 whose tabs are `tabs`; `ps` decides who is in front. */
function keys(tabs: string[], own: string, ps: string, sent: string[], viewer: string | null = null): KeyOps {
  return {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: async () => own,
    viewerTtyOf: async () => viewer,
    inFront: ((pid: number, tty: string | null, others?: number[]) =>
      Promise.resolve(inFront(parseProcs(ps), pid, tty, others))) as KeyOps["inFront"],
    app: async (_r, tty) => {
      if (!tabs.includes(tty)) return false;
      sent.push(tty);
      return true;
    },
  };
}

const viewerPs = [
  " 4242  4242  4242 ttys010  claude --bg-pty-host-child",
  " 5000  5000  5000 ttys014  claude",
].join("\n");
const otherPs = [
  " 4242  4242  4242 ttys010  claude --bg-pty-host-child",
  " 6000  6000  6000 ttys014  claude",
].join("\n");

test("Stop: no Esc into the earlier tab once another known session runs there", async () => {
  const r = registry();
  r.touch("a", { cwd: "/p", env: ITERM });
  const a = r.get("a") as SessionRecord;
  let ps = viewerPs;
  let viewer: string | null = "/dev/ttys014";
  const typed: string[] = [];
  const typeOps: TypeOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: async () => "/dev/ttys010",
    viewerTtyOf: async () => viewer,
    peek: async (_r, tty) => (tty === "/dev/ttys014" ? EMPTY : null),
    inFront: async (pid, tty, others) => inFront(parseProcs(ps), pid, tty, others),
    type: async (_r, tty, text) => {
      typed.push(`${tty}:${text}`);
      return true;
    },
  };
  try {
    setKnownPids(() => [6000]);
    expect(await deliver(a, "one", opts, typeOps)).toEqual({ via: "iterm" });
    ps = otherPs;
    viewer = null;
    await deliver(a, "two", opts, typeOps).catch(() => null);
    expect(typed).toEqual(["/dev/ttys014:one"]);
    const sent: string[] = [];
    const route = await pressEscape(a, keys(["/dev/ttys014"], "/dev/ttys010", ps, sent));
    expect({ route, sent }).toEqual({ route: null, sent: [] });
  } finally {
    setKnownPids(() => []);
  }
});

test("Stop: no Esc into the session's own tab while Claude Code is suspended there", async () => {
  const r = registry();
  r.touch("z", { cwd: "/p", env: { termProgram: "iTerm.app", claudePid: 7000 } });
  const z = r.get("z") as SessionRecord;
  // Ctrl-Z: vim (pgid 7100) holds the foreground of ttys020, claude (pgid 7000) is in the background.
  const ps = [" 7000  7000  7100 ttys020  claude", " 7100  7100  7100 ttys020  vim notes.txt"].join("\n");
  expect(inFront(parseProcs(ps), 7000, null)).toBe(false);
  const sent: string[] = [];
  const route = await pressEscape(z, keys(["/dev/ttys020"], "/dev/ttys020", ps, sent));
  expect({ route, sent }).toEqual({ route: null, sent: [] });
});

test("Stop: Esc still goes through the viewer tab of a background-hosted session", async () => {
  const r = registry();
  r.touch("a", { cwd: "/p", env: ITERM });
  const a = r.get("a") as SessionRecord;
  const sent: string[] = [];
  const route = await pressEscape(a, keys(["/dev/ttys014"], "/dev/ttys010", viewerPs, sent, "/dev/ttys014"));
  expect({ route, sent }).toEqual({ route: "iterm", sent: ["/dev/ttys014"] });
});

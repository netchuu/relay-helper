import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/daemon/db.ts";
import { EventLog } from "../../src/daemon/events.ts";
import type { DeliverOptions, TypeOps } from "../../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../../src/daemon/registry.ts";
import type { TabView, TypingRoute } from "../../src/platform/types.ts";

// Fakes for the routes `deliver` types through, and an inbox socket, for the tests of what reaches a terminal.

/** A temporary inbox socket that records what Claude Code would receive. */
export async function inbox(): Promise<{ path: string; got: string[]; server: Server }> {
  const path = join(mkdtempSync(join(tmpdir(), "relay-safety-")), "in.sock");
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

export function sessionWith(env: HookEnv): SessionRecord {
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  return registry.get("s1") as SessionRecord;
}

export const RULE = "─".repeat(100);
export const PROMPT = `${RULE}\n❯ \n${RULE}`;

export function fakeTerminals(front: boolean) {
  const typed: string[] = [];
  const asked: [number, string | null][] = [];
  const entered: string[] = [];
  const ops: TypeOps = {
    pty: async (_s, _t, _p, text) => {
      typed.push(`pty:${text}`);
      return { ok: true };
    },
    tmuxScreen: async () => PROMPT,
    tmux: async (_s, _p, text) => void typed.push(`tmux:${text}`),
    routes: (t) => (t === "iTerm.app" || !t ? ["iterm"] : []),
    ttyOf: async (pid) => (pid ? "/dev/ttys004" : null),
    peek: async (_r: TypingRoute): Promise<TabView> => ({ front: false, screen: PROMPT }),
    inFront: async (pid, tty) => {
      asked.push([pid, tty]);
      return front;
    },
    type: async (route, _tty, text) => {
      typed.push(`${route}:${text}`);
      return true;
    },
    tmuxEnter: async () => void entered.push("tmux"),
    enter: async (route) => {
      entered.push(route);
      return true;
    },
    sleep: async () => {},
  };
  return { ops, typed, asked, entered };
}

export const opts: DeliverOptions = { idleSeconds: 600, userTypingNow: false, preferTyping: true };
export const TMUX: HookEnv = {
  tmux: "/tmp/tmux-501/default,1,0",
  tmuxPane: "%3",
  claudePid: 4242,
  termProgram: "tmux",
};
export const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };

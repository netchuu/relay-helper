import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import {
  confirmModelSwitch,
  type DeliverOptions,
  deliver,
  type GuiOps,
  ptyScreenOf,
  readSuggestion,
  type TypeOps,
} from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { answerHostRequest } from "../src/shell/ptyHost.ts";

const RULE = "─".repeat(100);
const promptScreen = (prompt: string) =>
  [" ▐▛███▜▌   Claude Code v2.1.319", "", RULE, `❯ ${prompt}`, RULE, "  ⏵⏵ bypass permissions on"].join("\n");
const question = readFileSync(
  join(import.meta.dir, "fixtures/screens/claude-2.1.327-switch-model-question.txt"),
  "utf8",
);

const ENV: HookEnv = { pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242 };

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

function sessionWith(env: HookEnv = ENV): SessionRecord {
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  return registry.get("s1") as SessionRecord;
}

const gui: GuiOps = {
  desktopReady: async () => false,
  sendToDesktop: async () => "failed",
  isIdeSession: () => false,
  axAllowed: () => true,
  sendToIde: async () => "failed",
};

const ptyOps = (over: Partial<TypeOps> = {}): TypeOps => ({
  pty: async () => ({ ok: true }),
  tmuxScreen: async () => null,
  tmux: async () => {},
  routes: () => [],
  ttyOf: async () => null,
  peek: async () => null,
  type: async () => false,
  inFront: async () => true,
  sleep: async () => {},
  gui,
  ...over,
});

const opts = (more: Partial<DeliverOptions> = {}): DeliverOptions => ({
  userTypingNow: false,
  preferTyping: true,
  submitted: () => false,
  submitWaitMs: 10,
  ...more,
});

describe("the pty route reads its screen", () => {
  test("ptyScreenOf asks a host for its screen with the token", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "relay-ptyscreen-")), "h.sock");
    const server = createServer((sock) =>
      sock.on("data", async (chunk) => {
        const reply = await answerHostRequest(chunk.toString("utf8").trim(), {
          token: "tok",
          screen: () => promptScreen("hello"),
          release: () => {},
          resize: () => {},
          type: async () => ({ ok: true }),
        });
        sock.end(`${JSON.stringify(reply)}\n`);
      }),
    );
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, r));
    expect(await ptyScreenOf(path, "tok")).toBe(promptScreen("hello"));
    expect(await ptyScreenOf(path, "wrong")).toBeNull();
    expect(await ptyScreenOf(join(tmpdir(), "no-such.sock"), "tok")).toBeNull();
  });

  test("a hookless /context gets no second Enter and no unsent notice", async () => {
    let enters = 0;
    const ops = ptyOps({
      ptyScreen: async () => promptScreen("/context"),
      enterPty: async () => {
        enters++;
        return { ok: true };
      },
    });
    expect(await deliver(sessionWith(), "/context", opts(), ops)).toEqual({
      via: "pty",
      submitted: undefined,
    });
    expect(enters).toBe(0);
  });

  test("a plain message still sitting in the prompt gets one Enter", async () => {
    let enters = 0;
    const ops = ptyOps({
      ptyScreen: async () => promptScreen("hello there"),
      enterPty: async () => {
        enters++;
        return { ok: true };
      },
    });
    expect(await deliver(sessionWith(), "hello there", opts(), ops)).toEqual({
      via: "pty",
      submitted: false,
    });
    expect(enters).toBe(1);
  });

  test("a message that left the prompt gets no Enter", async () => {
    let enters = 0;
    const ops = ptyOps({
      ptyScreen: async () => promptScreen(""),
      enterPty: async () => {
        enters++;
        return { ok: true };
      },
    });
    await deliver(sessionWith(), "hello there", opts(), ops);
    expect(enters).toBe(0);
  });

  test("the suggestion shows over pty", async () => {
    const ops = ptyOps({ ptyScreen: async () => promptScreen("\u001b[2mrun the tests\u001b[0m") });
    expect(await readSuggestion(sessionWith(), ops)).toBe("run the tests");
  });

  test("an unreadable screen gives no suggestion answer", async () => {
    expect(await readSuggestion(sessionWith(), ptyOps({ ptyScreen: async () => null }))).toBeUndefined();
  });

  test("Switch model? is confirmed with one Enter", async () => {
    const keys: string[] = [];
    const ops = ptyOps({
      ptyScreen: async () => question,
      enterPty: async () => {
        keys.push("enter");
        return { ok: true };
      },
    });
    expect(await confirmModelSwitch(sessionWith(), "pty", "sonnet", ops, 0, 50)).toBe("confirmed");
    expect(keys).toEqual(["enter"]);
  });
});

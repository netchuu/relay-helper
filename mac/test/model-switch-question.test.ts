import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import type { TypeOps } from "../src/daemon/inject.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView } from "../src/platform/types.ts";

const screen = (name: string) => readFileSync(new URL(`./fixtures/screens/${name}`, import.meta.url), "utf8");
const QUESTION = screen("claude-2.1.327-switch-model-question.txt");
const PICKER = screen("claude-2.1.327-model-picker.txt");
const EMPTY = ["─".repeat(80), "❯ ", "─".repeat(80)].join("\n");
const DONE = [
  "❯ /model sonnet",
  "  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions",
  EMPTY,
].join("\n");

const tabRoutes = platform.typing.routes;
beforeAll(() => {
  platform.typing.routes = (t) => (t === "iTerm.app" || !t ? ["iterm"] : []);
});
afterAll(() => {
  platform.typing.routes = tabRoutes;
});

/** A terminal whose screen becomes `after` once the command is typed. */
function setup(after: string | string[], start = EMPTY) {
  const frames = Array.isArray(after) ? after : [after];
  let typed = false;
  let shown = 1;
  const tab: TabView = { front: false, screen: start };
  const log: string[] = [];
  const ops: TypeOps = {
    pty: async () => ({ ok: true }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: async () => "/dev/ttys004",
    peek: async () => {
      if (typed) tab.screen = frames[Math.min(shown++, frames.length - 1)] as string;
      return tab;
    },
    inFront: async () => true,
    type: async (_route, _tty, text) => {
      log.push(`type ${text}`);
      typed = true;
      tab.screen = frames[0] as string;
      return true;
    },
    enter: async () => {
      log.push("enter");
      tab.screen = DONE;
      return true;
    },
    sleep: async () => {},
  };
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", { cwd: "/work/shop", env: { termProgram: "iTerm.app", claudePid: 4242 } as never });
  const rpc = createRpc({
    db,
    events,
    registry,
    broker: { hasOpen: () => false },
    config: { preferTyping: true },
    typeOps: ops,
  } as unknown as RpcDeps);
  return { rpc, log };
}

describe("the model question at the computer", () => {
  test("the recorded question is answered Yes, once, and the switch finishes", async () => {
    const { rpc, log } = setup(QUESTION);
    expect(await rpc("session.model", { sessionId: "s1", model: "sonnet" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(log).toEqual(["type /model sonnet", "enter"]);
  });

  test("a full model id matches the question's model name", async () => {
    const { rpc, log } = setup(QUESTION);
    await rpc("session.model", { sessionId: "s1", model: "sonnet[1m]" }, "phone");
    expect(log).toEqual(["type /model sonnet[1m]", "enter"]);
  });

  test("the default alias matches a model shown as (default)", async () => {
    const { rpc, log } = setup(screen("claude-2.1.327-switch-model-question-default.txt"));
    expect(await rpc("session.model", { sessionId: "s1", model: "default" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(log).toEqual(["type /model default", "enter"]);
  });

  test("a model switched earlier in the history is not this command's result", async () => {
    const history = [
      "❯ /model sonnet",
      "  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions",
      "❯ say ok",
      "⏺ ok",
      "❯ /model opus",
      EMPTY,
    ].join("\n");
    const { rpc, log } = setup(
      [history, history, history, history, `${history}\n${QUESTION.replaceAll("Sonnet 5.5", "Opus 5.5")}`],
      [...history.split("\n").slice(0, 4), EMPTY].join("\n"),
    );
    expect(await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(log).toEqual(["type /model opus", "enter"]);
  });

  test("an earlier switch above an empty prompt is not this command's result", async () => {
    const history = [
      "❯ /model sonnet",
      "  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions",
      "❯ say ok",
      "⏺ ok",
      EMPTY,
    ].join("\n");
    const question = `${history}\n${QUESTION.replaceAll("Sonnet 5.5", "Opus 5.5")}`;
    const { rpc, log } = setup([history, history, history, question], history);
    expect(await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(log).toEqual(["type /model opus", "enter"]);
  });

  test("a question about another model is left alone", async () => {
    const { rpc, log } = setup(QUESTION);
    const out = await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
    expect(out).toEqual({
      error: { code: "conflict", message: "The computer is asking something else. Answer it there." },
    });
    expect(log).toEqual(["type /model opus"]);
  });

  test("another question on the screen is left alone", async () => {
    const { rpc, log } = setup(PICKER);
    const out = await rpc("session.model", { sessionId: "s1", model: "sonnet" }, "phone");
    expect(out).toMatchObject({ error: { code: "conflict" } });
    expect(log).toEqual(["type /model sonnet"]);
  });

  test("no question: nothing is pressed", async () => {
    const { rpc, log } = setup(DONE);
    expect(await rpc("session.model", { sessionId: "s1", model: "sonnet" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(log).toEqual(["type /model sonnet"]);
  });

  test("an effort is never answered", async () => {
    const { rpc, log } = setup(QUESTION);
    await rpc("session.model", { sessionId: "s1", effort: "low" }, "phone");
    expect(log).toEqual(["type /effort low"]);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { readPromptHoldsText, readSuggestion, type TypeOps } from "../src/daemon/inject.ts";
import { noKeySince, promptDraft, promptHoldsText } from "../src/daemon/promptLine.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { SuggestionWatcher, suggestionOf } from "../src/daemon/suggestion.ts";
import {
  bindSuggestionSeen,
  clearSuggestionSeen,
  forgetSuggestionKnown,
  noteSuggestionSeen,
  noteTurnEnded,
  noteTypedDuringTurn,
  resetSuggestionSeen,
  suggestionKnownOf,
  suggestionSeenOf,
  untypedStopAt,
} from "../src/daemon/suggestionSeen.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView } from "../src/platform/types.ts";

// An iTerm2 tab's text has no attributes. What the prompt showed when the session went idle is Claude Code's grey
// suggestion; the same text later is still that, whatever keys were pressed, and anything else is typing.

const RULE = "─".repeat(80);
const screen = (text: string) => [RULE, `❯ ${text}`, RULE].join("\n");
const SUGGESTION = "how is it going";

const tabRoutes = platform.typing.routes;
const presence = platform.presence.read;
beforeAll(() => {
  platform.typing.routes = (t) => (t === "iTerm.app" || !t ? ["iterm"] : []);
});
afterAll(() => {
  platform.typing.routes = tabRoutes;
});
beforeEach(() => {
  resetSuggestionSeen();
  platform.presence.read = async () => ({ idleSeconds: 60, locked: false, source: "test" });
});
afterEach(() => {
  platform.presence.read = presence;
  resetSuggestionSeen();
});

function helper() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("seen1", {
    cwd: "/Users/me/web-shop",
    env: { termProgram: "iTerm.app", claudePid: 4242 } as never,
  });
  const state = {
    tab: { front: false, screen: screen(SUGGESTION) } as TabView,
    clock: 10_000_000,
    lastKey: 10_000_000,
  };
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
    // a key was pressed in another terminal after the prompt was submitted
    noKeySincePrompt: () => false,
    now: () => state.clock,
  };
  const keyIdle = () => (state.clock - state.lastKey) / 1000;
  /** The turn ends a minute in; its last key, pressed anywhere at the Mac, was \`typedAt\` ms into it. */
  const endTurn = (typedAt = 0) => {
    state.lastKey = state.clock + typedAt;
    state.clock += 60_000;
    noteTurnEnded("seen1", state.clock);
  };
  const rpc = createRpc({
    db,
    events,
    registry,
    broker: { hasOpen: () => false },
    config: { preferTyping: true },
    typeOps: ops,
  } as unknown as RpcDeps);
  const session = () => registry.get("seen1") as NonNullable<ReturnType<Registry["get"]>>;
  return { db, rpc, ops, typed, state, session, endTurn, keyIdle, touch: () => registry.touch("seen1", {}) };
}

const pick = (h: ReturnType<typeof helper>) =>
  h.rpc("session.model", { sessionId: "seen1", model: "fable" }, "phone");
const DRAFT_ERROR = { error: { code: "conflict", message: expect.stringContaining("text in the prompt") } };

const typeAfterStop = (h: ReturnType<typeof helper>, text: string) => {
  h.state.lastKey = h.state.clock + 10_000;
  h.state.clock += 20_000;
  h.state.tab = { front: false, screen: screen(text) };
};

describe("a grey suggestion is not a draft", () => {
  test("after a key elsewhere during the turn, the suggestion seen at idle lets session.model through", async () => {
    const h = helper();
    h.endTurn(30_000);
    expect(await readSuggestion(h.session(), h.ops)).toBe(SUGGESTION);
    expect(suggestionSeenOf("seen1")).toBe(SUGGESTION);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
    expect(h.typed).toEqual(["iterm:/model fable"]);
  });

  test("an empty first look gives way to the suggestion drawn a moment later", async () => {
    const h = helper();
    h.endTurn();
    h.state.tab = { front: false, screen: screen("") };
    await readSuggestion(h.session(), h.ops);
    expect(suggestionSeenOf("seen1")).toBe("");
    // a key in another app half a second later does not matter
    h.state.clock += 500;
    h.state.lastKey = h.state.clock;
    h.state.tab = { front: false, screen: screen(SUGGESTION) };
    await readSuggestion(h.session(), h.ops);
    expect(suggestionSeenOf("seen1")).toBe(SUGGESTION);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
  });

  test("text typed before the first look (a restart, a phone connecting late) stays a draft", async () => {
    const h = helper();
    h.endTurn();
    typeAfterStop(h, "fix the login");
    expect(await readSuggestion(h.session(), h.ops)).toBeNull();
    expect(suggestionSeenOf("seen1")).toBeUndefined();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("text typed 4 s after an empty look stays a draft", async () => {
    const h = helper();
    h.endTurn();
    h.state.tab = { front: false, screen: screen("") };
    await readSuggestion(h.session(), h.ops);
    h.state.clock += 4_000;
    h.state.lastKey = h.state.clock - 500;
    h.state.tab = { front: false, screen: screen("fix the login") };
    await readSuggestion(h.session(), h.ops);
    expect(suggestionSeenOf("seen1")).toBe("");
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("typing after the Stop, then a hook, then a look keeps nothing and refuses the model", async () => {
    const h = helper();
    h.endTurn();
    typeAfterStop(h, "fix the login");
    h.touch();
    expect(await readSuggestion(h.session(), h.ops)).toBeNull();
    expect(suggestionSeenOf("seen1")).toBeUndefined();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("text seen in the prompt during the turn keeps nothing and refuses the model", async () => {
    const h = helper();
    noteTypedDuringTurn("seen1");
    h.endTurn(30_000);
    h.state.clock += 20_000;
    h.touch();
    h.state.tab = { front: false, screen: screen("also check the signup") };
    expect(h.keyIdle()).toBeGreaterThan(20);
    expect(await readSuggestion(h.session(), h.ops)).toBeNull();
    expect(suggestionSeenOf("seen1")).toBeUndefined();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("a Stop with no phone, typing, then a phone connecting shows no chip and refuses the model", async () => {
    const h = helper();
    const idle = { ...h.session(), status: "idle", canReceive: true };
    let phone = false;
    const watcher = new SuggestionWatcher({
      registry: { get: () => idle, list: () => [idle], publish: () => {} } as never,
      read: (s) => readSuggestion(s, h.ops),
      sleep: async () => {},
      phoneConnected: () => phone,
    });
    watcher.clear("seen1");
    h.endTurn();
    watcher.lookNow();
    await Bun.sleep(20);
    typeAfterStop(h, "fix the login");
    h.touch();
    phone = true;
    watcher.lookNow();
    await Bun.sleep(50);
    expect(suggestionOf("seen1")).toBeUndefined();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
    watcher.clear("seen1");
  });

  test("a Stop with no phone, a key elsewhere, then a phone connecting shows the chip and lets the model through", async () => {
    const h = helper();
    const idle = { ...h.session(), status: "idle", canReceive: true };
    let phone = false;
    const watcher = new SuggestionWatcher({
      registry: { get: () => idle, list: () => [idle], publish: () => {} } as never,
      read: (s) => readSuggestion(s, h.ops),
      sleep: () => Bun.sleep(1),
      phoneConnected: () => phone,
    });
    watcher.clear("seen1");
    h.endTurn();
    watcher.lookNow();
    await Bun.sleep(60);
    expect(suggestionSeenOf("seen1")).toBe(SUGGESTION);
    expect(suggestionOf("seen1")).toBeUndefined();
    h.state.clock += 30_000;
    h.state.lastKey = h.state.clock;
    phone = true;
    watcher.lookNow();
    await Bun.sleep(50);
    expect(suggestionOf("seen1")).toBe(SUGGESTION);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
    watcher.clear("seen1");
  });

  test("text typed after the last tool hook, before the Stop, is a draft", async () => {
    const h = helper();
    let status = "working";
    const watcher = new SuggestionWatcher({
      registry: {
        get: () => ({ ...h.session(), status, canReceive: true }),
        list: () => [],
        publish() {},
      } as never,
      holdsText: async () => true,
      read: async () => undefined,
      sleep: async () => {},
      phoneConnected: () => false,
    });
    h.state.tab = { front: false, screen: screen("also check the signup") };
    await watcher.beforeStop("seen1");
    status = "idle";
    h.endTurn(50_000);
    expect(untypedStopAt("seen1")).toBeUndefined();
    expect(await readSuggestion(h.session(), h.ops)).toBeNull();
    expect(suggestionSeenOf("seen1")).toBeUndefined();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("the watcher's own read passes the seen suggestion as known", async () => {
    const h = helper();
    h.endTurn(30_000);
    await readSuggestion(h.session(), h.ops);
    const known = suggestionKnownOf("seen1");
    expect(await readPromptHoldsText(h.session(), h.ops, known)).toBe(false);
    typeAfterStop(h, "fix the login");
    expect(await readPromptHoldsText(h.session(), h.ops, known)).toBe(true);
  });

  test("the watcher notes text in a working session's prompt, and not after the turn ends", async () => {
    const h = helper();
    let holds: boolean | undefined = false;
    let status = "working";
    let at = 0;
    const watcher = new SuggestionWatcher({
      registry: {
        get: () => ({ ...h.session(), status, canReceive: true }),
        list: () => [],
        publish: () => {},
      } as never,
      holdsText: async () => holds,
      read: async () => undefined,
      sleep: async () => {},
      phoneConnected: () => false,
      now: () => at,
    });
    const turn = async () => {
      at += 10_000;
      watcher.duringTurn("seen1");
      await Bun.sleep(5);
      watcher.turnEnded("seen1");
      return untypedStopAt("seen1");
    };
    expect(await turn()).toBeDefined();
    watcher.clear("seen1");
    holds = true;
    expect(await turn()).toBeUndefined();
    watcher.clear("seen1");
    status = "idle";
    expect(await turn()).toBeDefined();
    watcher.clear("seen1");
  });

  test("a restart in the middle of a turn loses nothing that matters", async () => {
    const h = helper();
    bindSuggestionSeen(h.db);
    resetSuggestionSeen();
    bindSuggestionSeen(h.db);
    h.endTurn(30_000);
    expect(await readSuggestion(h.session(), h.ops)).toBe(SUGGESTION);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
  });

  test("text seen during the turn is still remembered after a restart", async () => {
    const h = helper();
    bindSuggestionSeen(h.db);
    noteTypedDuringTurn("seen1");
    resetSuggestionSeen();
    bindSuggestionSeen(h.db);
    h.endTurn(30_000);
    expect(untypedStopAt("seen1")).toBeUndefined();
    expect(await readSuggestion(h.session(), h.ops)).toBeNull();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("after a restart the kept suggestion is still known", async () => {
    const h = helper();
    bindSuggestionSeen(h.db);
    noteSuggestionSeen("seen1", SUGGESTION);
    resetSuggestionSeen();
    expect(suggestionSeenOf("seen1")).toBeUndefined();
    bindSuggestionSeen(h.db);
    expect(suggestionSeenOf("seen1")).toBe(SUGGESTION);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
  });

  test("text typed after the snapshot is a draft and is refused", async () => {
    const h = helper();
    await readSuggestion(h.session(), h.ops);
    h.state.tab = { front: false, screen: screen("also check the signup") };
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("typing that extends the suggestion is a draft", async () => {
    const h = helper();
    await readSuggestion(h.session(), h.ops);
    h.state.tab = { front: false, screen: screen(`${SUGGESTION} with the build`) };
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("with nothing known (no snapshot, keys elsewhere) the text counts as a draft", async () => {
    const h = helper();
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
  });

  test("an empty snapshot never makes typed text a suggestion; later looks don't replace the first", () => {
    noteSuggestionSeen("seen1", "", 0);
    expect(promptDraft(screen("hello"), { seen: "" })).toBe("hello");
    noteSuggestionSeen("seen1", "hello", 60_000);
    expect(suggestionSeenOf("seen1")).toBe("");
    noteSuggestionSeen("s2", SUGGESTION, 0);
    noteSuggestionSeen("s2", "typed", 1);
    expect(suggestionSeenOf("s2")).toBe(SUGGESTION);
  });

  test("whitespace and wrapping don't change what matches", () => {
    expect(
      promptDraft(["─".repeat(80), "❯ how is it", "  going", "─".repeat(80)].join("\n"), {
        seen: SUGGESTION,
      }),
    ).toBeNull();
  });
});

describe("the suggestion the helper read stays a suggestion", () => {
  /** A turn Claude Code starts itself (a notification, a wakeup): nobody submitted a prompt, background shells run. */
  const selfStartedTurn = (h: ReturnType<typeof helper>) => {
    clearSuggestionSeen("seen1");
    noteTypedDuringTurn("seen1");
    h.state.clock += 120_000;
    h.state.lastKey = h.state.clock - 30_000;
    h.state.tab = { front: false, screen: screen(SUGGESTION) };
  };

  test("after a self-started turn the phone's message is typed at once", async () => {
    const h = helper();
    h.endTurn(30_000);
    expect(await readSuggestion(h.session(), h.ops)).toBe(SUGGESTION);
    selfStartedTurn(h);
    h.endTurn(30_000);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
    expect(h.typed).toEqual(["iterm:/model fable"]);
  });

  test("a phone message equal to the suggestion is typed at once", async () => {
    const h = helper();
    h.endTurn(30_000);
    await readSuggestion(h.session(), h.ops);
    selfStartedTurn(h);
    expect(await h.rpc("session.send", { sessionId: "seen1", text: SUGGESTION }, "phone")).not.toMatchObject(
      DRAFT_ERROR,
    );
    expect(h.typed).toEqual([`iterm:${SUGGESTION}`]);
  });

  test("a typed draft that differs from the suggestion still holds", async () => {
    const h = helper();
    h.endTurn(30_000);
    await readSuggestion(h.session(), h.ops);
    selfStartedTurn(h);
    h.state.tab = { front: false, screen: screen("fix the login") };
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
    expect(h.typed).toEqual([]);
  });

  test("the old suggestion on screen during a self-started turn is not typing, so the next one is read", async () => {
    const h = helper();
    h.endTurn(30_000);
    await readSuggestion(h.session(), h.ops);
    clearSuggestionSeen("seen1");
    const watcher = new SuggestionWatcher({
      registry: {
        get: () => ({ ...h.session(), status: "working", canReceive: true }),
        list: () => [],
        publish() {},
      } as never,
      holdsText: async (_s, _o, known) => promptHoldsText(h.state.tab.screen as string, known),
      read: async () => undefined,
      sleep: async () => {},
      phoneConnected: () => false,
    });
    watcher.duringTurn("seen1");
    await Bun.sleep(10);
    h.state.clock += 120_000;
    h.state.lastKey = h.state.clock - 30_000;
    h.endTurn(30_000);
    expect(untypedStopAt("seen1")).toBeDefined();
    h.state.tab = { front: false, screen: screen("run the tests") };
    expect(await readSuggestion(h.session(), h.ops)).toBe("run the tests");
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
  });

  test("the known suggestion survives a restart during a self-started turn", async () => {
    const h = helper();
    bindSuggestionSeen(h.db);
    h.endTurn(30_000);
    await readSuggestion(h.session(), h.ops);
    selfStartedTurn(h);
    resetSuggestionSeen();
    bindSuggestionSeen(h.db);
    h.endTurn(30_000);
    expect(await pick(h)).toEqual({ result: { via: "iterm" } });
    expect(h.typed).toEqual(["iterm:/model fable"]);
  });

  test("a submitted prompt uses the suggestion up", async () => {
    const h = helper();
    h.endTurn(30_000);
    await readSuggestion(h.session(), h.ops);
    forgetSuggestionKnown("seen1");
    selfStartedTurn(h);
    expect(await pick(h)).toMatchObject(DRAFT_ERROR);
  });
});

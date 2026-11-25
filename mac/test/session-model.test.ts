import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelResult, RpcSchemas, Session } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { TypeOps } from "../src/daemon/inject.ts";
import { displayModel, SessionModels, sessionModels } from "../src/daemon/model.ts";
import { pendingPicks } from "../src/daemon/pendingPick.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { mergeHooks } from "../src/install.ts";
import * as claudeDesktop from "../src/integrations/claudeDesktop.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView } from "../src/platform/types.ts";

// Choosing the model from the phone: `session.model` types /model or /effort into the session's own terminal, only
// when Claude is idle and the prompt is empty; the session shows the model Claude Code reports.

const EMPTY_PROMPT = ["─".repeat(80), "❯ ", "─".repeat(80)].join("\n");
const DRAFT_PROMPT = ["─".repeat(80), "❯ half a thought", "─".repeat(80)].join("\n");

function terminal() {
  const state = { tab: { front: false, screen: EMPTY_PROMPT } as TabView | null };
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
  };
  return { ops, typed, state };
}

// The Linux build has no terminal app to type into; these sessions stand for the Mac's iTerm2.
const tabRoutes = platform.typing.routes;
beforeAll(() => {
  platform.typing.routes = (t) => (t === "iTerm.app" || !t ? ["iterm"] : []);
});
afterAll(() => {
  platform.typing.routes = tabRoutes;
});

function helper(env: Record<string, unknown> = { termProgram: "iTerm.app", claudePid: 4242 }) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env: env as never });
  const t = terminal();
  let open = false;
  const rpc = createRpc({
    db,
    events,
    registry,
    broker: { hasOpen: () => open },
    config: { preferTyping: true },
    typeOps: t.ops,
  } as unknown as RpcDeps);
  return { rpc, t, registry, events, setOpen: (v: boolean) => (open = v) };
}

describe("displayModel", () => {
  test("ids and aliases become what people read", () => {
    expect(displayModel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(displayModel("claude-opus-4-7-20260101")).toBe("Opus 4.7");
    expect(displayModel("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(displayModel("opus[1m]")).toBe("Opus (1M)");
    expect(displayModel("sonnet")).toBe("Sonnet");
    expect(displayModel("claude-sonnet-4-5@20250929")).toBe("Sonnet 4.5");
    expect(displayModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(displayModel("anthropic.claude-opus-4-1-20250805-v1:0")).toBe("Opus 4.1");
  });
  test("nothing readable is no model", () => {
    expect(displayModel("")).toBeNull();
    expect(displayModel(undefined)).toBeNull();
    expect(displayModel("5-2")).toBeNull();
    expect(displayModel("x".repeat(200))).toBeNull();
  });
});

describe("SessionModels", () => {
  test("reports a change once and forgets", () => {
    const m = new SessionModels();
    expect(m.setModel("a", "claude-fable-5-2")).toBe(true);
    expect(m.setModel("a", "claude-fable-5-2")).toBe(false);
    expect(m.setModel("a", 42)).toBe(false);
    expect(m.get("a")).toEqual({ model: "Fable 5.2" });
    m.forget("a");
    expect(m.get("a")).toEqual({});
  });
});

describe("the session's model on the wire", () => {
  beforeEach(() => sessionModels.forget("s1"));
  afterEach(() => sessionModels.forget("s1"));

  test("a known model is in the public session, never an effort; unknown leaves it out", () => {
    const { registry } = helper();
    const record = registry.get("s1");
    if (!record) throw new Error("no session");
    expect(publicSession(record)).not.toHaveProperty("model");
    sessionModels.setModel("s1", "claude-fable-5-2");
    const shown = Session.parse(publicSession(record));
    expect(shown.model).toBe("Fable 5.2");
    expect(shown.effort).toBeUndefined();
  });

  test("a desktop app or editor session shows no model: /model can't be typed there", () => {
    const { registry } = helper({ claudePid: 4242 });
    const record = registry.get("s1");
    if (!record) throw new Error("no session");
    const app = spyOn(claudeDesktop, "desktopTitle").mockReturnValue("Fix login");
    try {
      sessionModels.setModel("s1", "claude-fable-5-2");
      expect(publicSession(record)).not.toHaveProperty("model");
      // A session the helper types into keeps it, even when the app knows it too.
      expect(publicSession({ ...record, terminal: "iTerm.app" })).toHaveProperty("model");
      expect(publicSession({ ...record, ptySocket: "/p.sock" })).toHaveProperty("model");
      app.mockReturnValue(null);
      expect(publicSession(record)).toHaveProperty("model");
    } finally {
      app.mockRestore();
    }
  });

  test("the fixture decodes", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "../../protocol/fixtures/model.json"), "utf8"),
    );
    expect(Session.parse(fixture.session).model).toBe("Fable 5.2");
    expect(Session.parse(fixture.sessionUnknown).model).toBeUndefined();
    expect(ModelResult.parse(fixture.result).via).toBe("tmux");
  });

  test("the hook wiring includes PostModelSwitch", () => {
    const merged = mergeHooks({}, "/usr/local/bin/relay-hook") as { hooks: Record<string, unknown> };
    expect(Object.keys(merged.hooks)).toContain("PostModelSwitch");
  });
});

describe("session.model", () => {
  const read = platform.presence.read;
  beforeEach(() => {
    platform.presence.read = async () => ({ idleSeconds: 60, locked: false, source: "test" });
  });
  afterEach(() => {
    platform.presence.read = read;
    sessionModels.forget("s1");
  });

  test("the params take one of a model or an effort, from the fixed lists", () => {
    const p = RpcSchemas["session.model"];
    expect(p.safeParse({ sessionId: "s1", model: "opus" }).success).toBe(true);
    expect(p.safeParse({ sessionId: "s1", model: "opus[1m]" }).success).toBe(true);
    expect(p.safeParse({ sessionId: "s1", effort: "xhigh" }).success).toBe(true);
    expect(p.safeParse({ sessionId: "s1" }).success).toBe(false);
    expect(p.safeParse({ sessionId: "s1", model: "opus", effort: "low" }).success).toBe(false);
    expect(p.safeParse({ sessionId: "s1", model: "gpt-9" }).success).toBe(false);
    expect(p.safeParse({ sessionId: "s1", model: "opus\n/quit" }).success).toBe(false);
  });

  test("types /model into the terminal when Claude is idle and the prompt is empty", async () => {
    const { rpc, t } = helper();
    expect(await rpc("session.model", { sessionId: "s1", model: "fable" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(t.typed).toEqual(["iterm:/model fable"]);
  });

  test("an effort is typed as /effort; the session doesn't show it", async () => {
    const { rpc, t } = helper();
    expect(await rpc("session.model", { sessionId: "s1", effort: "high" }, "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(t.typed).toEqual(["iterm:/effort high"]);
    expect(sessionModels.get("s1")).toEqual({});
  });

  test("a pick queued behind a phone message waits once that message made Claude work", async () => {
    const { rpc, t, registry } = helper();
    // Typing the message starts the turn, as Claude Code's hook would report.
    const type = t.ops.type;
    t.ops.type = async (route, tty, text) => {
      const ok = await type(route, tty, text);
      registry.setStatus("s1", "working");
      return ok;
    };
    const send = rpc("session.send", { sessionId: "s1", text: "fix the tests" }, "phone");
    const pick = rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
    await send;
    expect(await pick).toEqual({ result: { via: "queued" } });
    expect(t.typed).toEqual(["iterm:fix the tests"]);
  });

  test("while Claude works the pick waits and nothing is typed", async () => {
    const { rpc, t, registry } = helper();
    registry.setStatus("s1", "working");
    const out = await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
    expect(out).toEqual({ result: { via: "queued" } });
    expect(t.typed).toEqual([]);
    expect(publicSession(registry.get("s1") as never)).toMatchObject({ pendingModel: "opus" });
  });

  test("with a prompt open the pick waits", async () => {
    const { rpc, t, setOpen } = helper();
    setOpen(true);
    const out = await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
    expect(out).toEqual({ result: { via: "queued" } });
    expect(t.typed).toEqual([]);
  });

  describe("a pick made while Claude works", () => {
    afterEach(() => {
      pendingPicks.clear("s1");
      pendingPicks.clearRefusal("s1");
    });

    test("is typed once the session goes idle, and the pending fields go", async () => {
      const { rpc, t, registry } = helper();
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
      await rpc("session.model", { sessionId: "s1", effort: "high" }, "phone");
      await rpc.applyPicks();
      expect(t.typed).toEqual([]);
      registry.setStatus("s1", "idle");
      await rpc.applyPicks();
      expect(t.typed).toEqual(["iterm:/model opus", "iterm:/effort high"]);
      expect(publicSession(registry.get("s1") as never)).not.toHaveProperty("pendingModel");
      expect(publicSession(registry.get("s1") as never)).not.toHaveProperty("pendingEffort");
    });

    test("a later pick replaces the earlier one", async () => {
      const { rpc, t, registry } = helper();
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
      await rpc("session.model", { sessionId: "s1", model: "haiku" }, "phone");
      expect(publicSession(registry.get("s1") as never)).toMatchObject({ pendingModel: "haiku" });
      registry.setStatus("s1", "idle");
      await rpc.applyPicks();
      expect(t.typed).toEqual(["iterm:/model haiku"]);
    });

    test("is typed after a late idle, before a message sent then", async () => {
      const { rpc, t, registry } = helper();
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", effort: "low" }, "phone");
      // The turn ends late: the phone's message arrives in the same moment the session reports idle.
      setTimeout(() => registry.setStatus("s1", "idle"), 30);
      await Bun.sleep(60);
      await rpc("session.send", { sessionId: "s1", text: "go on" }, "phone");
      expect(t.typed).toEqual(["iterm:/effort low", "iterm:go on"]);
    });

    test("a tick and a send during a slow pick wait for it", async () => {
      const { rpc, t, registry } = helper();
      const events: string[] = [];
      const type = t.ops.type;
      t.ops.type = async (route, tty, text) => {
        events.push(`start:${text}`);
        await Bun.sleep(text.startsWith("/") ? 80 : 0);
        const ok = await type(route, tty, text);
        events.push(`end:${text}`);
        return ok;
      };
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
      await rpc("session.model", { sessionId: "s1", effort: "low" }, "phone");
      registry.setStatus("s1", "idle");
      const first = rpc.applyPicks();
      await Bun.sleep(20);
      const second = rpc.applyPicks();
      const send = rpc("session.send", { sessionId: "s1", text: "go on" }, "phone");
      await Promise.all([first, second, send]);
      expect(events).toEqual([
        "start:/model opus",
        "end:/model opus",
        "start:/effort low",
        "end:/effort low",
        "start:go on",
        "end:go on",
      ]);
    });

    test("a pick made during a slow pick is typed before a send that waited for it", async () => {
      const { rpc, t, registry } = helper();
      const type = t.ops.type;
      t.ops.type = async (route, tty, text) => {
        await Bun.sleep(text.startsWith("/") ? 60 : 0);
        return type(route, tty, text);
      };
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
      registry.setStatus("s1", "idle");
      const tick = rpc.applyPicks();
      await Bun.sleep(20);
      await rpc("session.model", { sessionId: "s1", model: "haiku" }, "phone");
      await rpc("session.send", { sessionId: "s1", text: "go on" }, "phone");
      await tick;
      expect(t.typed).toEqual(["iterm:/model opus", "iterm:/model haiku", "iterm:go on"]);
    });

    test("a pick made once idle, with an older one waiting, replaces it", async () => {
      const { rpc, t, registry } = helper();
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone");
      registry.setStatus("s1", "idle");
      expect(await rpc("session.model", { sessionId: "s1", model: "haiku" }, "phone")).toEqual({
        result: { via: "queued" },
      });
      await rpc.applyPicks();
      expect(t.typed).toEqual(["iterm:/model haiku"]);
    });

    test("after Stop it waits for the next idle moment", async () => {
      const { rpc, t, registry } = helper();
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", effort: "max" }, "phone");
      await rpc.applyPicks();
      expect(t.typed).toEqual([]);
      registry.setStatus("s1", "idle");
      await rpc.applyPicks();
      expect(t.typed).toEqual(["iterm:/effort max"]);
    });

    test("a failed apply drops the pick and sends the refusal once", async () => {
      const { rpc, t, registry, events } = helper();
      const seen: Array<{ pickRefusal?: string; pendingEffort?: string }> = [];
      events.subscribe((e) => {
        if (e.type === "session.upsert") seen.push(e.session);
      });
      registry.setStatus("s1", "working");
      await rpc("session.model", { sessionId: "s1", effort: "low" }, "phone");
      t.state.tab = { front: false, screen: DRAFT_PROMPT };
      registry.setStatus("s1", "idle");
      await rpc.applyPicks();
      expect(t.typed).toEqual([]);
      const refusal = "There is text in the prompt at the computer. Send or clear it first.";
      expect(seen.some((s) => s.pickRefusal === refusal && s.pendingEffort === undefined)).toBe(true);
      const after = publicSession(registry.get("s1") as never);
      expect(after).not.toHaveProperty("pickRefusal");
      expect(after).not.toHaveProperty("pendingEffort");
    });
  });

  test("a draft in the prompt is never typed into, and the effort stays as it was", async () => {
    const { rpc, t } = helper();
    t.state.tab = { front: false, screen: DRAFT_PROMPT };
    const out = await rpc("session.model", { sessionId: "s1", effort: "low" }, "phone");
    expect(out).toEqual({
      error: {
        code: "conflict",
        message: "There is text in the prompt at the computer. Send or clear it first.",
      },
    });
    expect(t.typed).toEqual([]);
    expect(sessionModels.get("s1")).toEqual({});
  });

  test("keys pressed at the computer a moment ago don't hold the change", async () => {
    platform.presence.read = async () => ({ idleSeconds: 0, locked: false, source: "test" });
    const { rpc, t } = helper();
    t.state.tab = { front: true, screen: EMPTY_PROMPT };
    const out = await rpc("session.model", { sessionId: "s1", model: "haiku" }, "phone");
    expect(out).not.toHaveProperty("error");
    expect(t.typed[0]).toBe("iterm:/model haiku");
  });

  test("a session with no terminal to type into is refused, never sent through the inbox", async () => {
    const { rpc, t } = helper({ claudePid: 4242, socketPath: "/tmp/inbox.sock" });
    t.state.tab = null;
    t.ops.routes = () => [];
    const out = await rpc("session.model", { sessionId: "s1", model: "sonnet" }, "phone");
    expect(out).toEqual({
      error: { code: "unavailable", message: "This session can't be changed from the phone." },
    });
    expect(t.typed).toEqual([]);
  });

  test("an unknown or ended session is not found", async () => {
    const { rpc, registry } = helper();
    expect(await rpc("session.model", { sessionId: "nope", model: "opus" }, "phone")).toMatchObject({
      error: { code: "not_found" },
    });
    registry.setStatus("s1", "ended");
    expect(await rpc("session.model", { sessionId: "s1", model: "opus" }, "phone")).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("what Claude Code reports", () => {
  afterEach(() => sessionModels.forget("h1"));

  function hooks() {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const handler = new HookHandler({
      db,
      events,
      registry,
      broker: { settleFromSessionEvent() {}, hasOpen: () => false, listOpen: () => [] },
      presence: { noteLocalActivity() {}, get: () => ({}) },
      config: { previewChars: 600 },
    } as unknown as ConstructorParameters<typeof HookHandler>[0]);
    const fire = (payload: Record<string, unknown>) =>
      handler.handle(
        { payload: { session_id: "h1", cwd: "/tmp", ...payload }, env: {} } as never,
        new AbortController().signal,
      );
    const models = () =>
      events
        .since(0)
        .flatMap((e) => (e.type === "session.upsert" ? [e.session.model ?? null] : []))
        .pop();
    return { fire, models };
  }

  test("SessionStart's model shows on the session", async () => {
    const { fire, models } = hooks();
    await fire({ hook_event_name: "SessionStart", source: "startup", model: "claude-fable-5-2" });
    expect(models()).toBe("Fable 5.2");
  });

  test("PostModelSwitch shows the new model", async () => {
    const { fire, models } = hooks();
    await fire({ hook_event_name: "SessionStart", source: "startup", model: "claude-fable-5-2" });
    await fire({
      hook_event_name: "PostModelSwitch",
      from_model: "claude-fable-5-2",
      to_model: "claude-opus-4-7",
    });
    expect(models()).toBe("Opus 4.7");
  });

  test("a session that started without a model has none, and a hook without one changes nothing", async () => {
    const { fire, models } = hooks();
    await fire({ hook_event_name: "SessionStart", source: "resume" });
    expect(models()).toBeNull();
    await fire({ hook_event_name: "PostModelSwitch" });
    expect(models()).toBeNull();
  });

  test("the model is read from the transcript when the helper missed the start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-model-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", content: [] } })}\n`,
    );
    const { fire, models } = hooks();
    await fire({ hook_event_name: "UserPromptSubmit", prompt: "hi", transcript_path: file });
    expect(models()).toBe("Haiku 5.5");
    rmSync(dir, { recursive: true, force: true });
  });

  test("when the session ends its model is forgotten", async () => {
    const { fire } = hooks();
    await fire({ hook_event_name: "SessionStart", source: "startup", model: "claude-fable-5-2" });
    await fire({ hook_event_name: "SessionEnd" });
    expect(sessionModels.get("h1")).toEqual({});
  });
});

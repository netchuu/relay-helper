import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LiveTurn, type Turn, TurnsWithLive } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { StepTracker } from "../src/daemon/steps.ts";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: 0 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/p", ...fields }, env: {} },
      new AbortController().signal,
    );
  const call = async (method: string, params: object, opts = {}) => {
    const res = await rpc(method as never, params as never, "device:x", opts);
    if (!("result" in res)) throw new Error(`${method} failed`);
    return res.result;
  };
  return { hook, call };
}

const turn = async (t: ReturnType<typeof setup>, prompt: string) => {
  await t.hook("UserPromptSubmit", { prompt });
  await t.hook("Stop", { last_assistant_message: `Done ${prompt}` });
};

describe("session.turns with withLive", () => {
  test("a running turn comes with the page, the same as session.live answers", async () => {
    const t = setup();
    await turn(t, "first");
    await t.hook("UserPromptSubmit", { prompt: "second" });
    await t.hook("PreToolUse", { tool_use_id: "a", tool_name: "Bash", tool_input: { command: "ls" } });
    const both = TurnsWithLive.parse(
      await t.call("session.turns", { sessionId: "s1", limit: 5, withLive: true }),
    );
    expect(both.turns.map((x) => x.prompt)).toEqual(["first"]);
    expect(both.live?.prompt).toBe("second");
    expect(both.live?.step).toBeDefined();
    expect(both.live).toEqual(LiveTurn.parse(await t.call("session.live", { sessionId: "s1" })));
  });

  test("no running turn: live is null, present in the reply", async () => {
    const t = setup();
    await turn(t, "first");
    const reply = (await t.call("session.turns", { sessionId: "s1", limit: 5, withLive: true })) as object;
    expect(reply).toHaveProperty("live", null);
    expect(TurnsWithLive.parse(reply).turns).toHaveLength(1);
  });

  test("without withLive the reply is the plain array, as before", async () => {
    const t = setup();
    await turn(t, "first");
    await t.hook("UserPromptSubmit", { prompt: "second" });
    const reply = (await t.call("session.turns", { sessionId: "s1", limit: 5 })) as Turn[];
    expect(Array.isArray(reply)).toBe(true);
    expect(reply.map((x) => x.prompt)).toEqual(["first"]);
  });

  test("the live turn's size counts against the frame, the turns give way", async () => {
    const t = setup();
    for (let i = 0; i < 8; i++) await turn(t, `p${i} ${"x".repeat(60_000)}`);
    await t.hook("UserPromptSubmit", { prompt: "now" });
    const reply = TurnsWithLive.parse(
      await t.call("session.turns", { sessionId: "s1", limit: 20, withLive: true }, { overRelay: true }),
    );
    expect(reply.live?.prompt).toBe("now");
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(256 * 1024);
  });
});

describe("protocol fixture turns-with-live.json", () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "../../protocol/fixtures/turns-with-live.json"), "utf8"),
  );
  test("parses as written", () => {
    expect(TurnsWithLive.parse(fixture.running).live?.turnId).toBe("t_live");
    expect(TurnsWithLive.parse(fixture.idle).live).toBeNull();
    expect(Array.isArray(fixture.plain)).toBe(true);
  });
});

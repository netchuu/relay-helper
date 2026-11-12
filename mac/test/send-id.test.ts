import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeliveryCheck, RelayEvent, RpcSchemas, SendResult } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { DeliveryError, type TypeOps } from "../src/daemon/inject.ts";
import { Registry } from "../src/daemon/registry.ts";
import { deliverQueued, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { SentMessages } from "../src/daemon/sentMessages.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView } from "../src/platform/types.ts";

// `session.send` carries the phone's id for the message. A send whose reply was lost is never typed twice: the
// phone asks `session.delivered` before it says "Couldn't send", and Try Again with the same id is answered without
// typing it again.

const EMPTY_PROMPT = ["─".repeat(80), "❯ ", "─".repeat(80)].join("\n");

/** An iTerm2 tab that records what's typed into it; `fail` makes typing fail, `tab` is what the peek sees. */
function terminal() {
  const state = { fail: false, tab: { front: false, screen: EMPTY_PROMPT } as TabView | null };
  const typed: string[] = [];
  const ops: TypeOps = {
    pty: async () => ({ ok: true }),
    tmuxScreen: async () => null,
    tmux: async (_s, _p, text) => void typed.push(`tmux:${text}`),
    routes: () => ["iterm"],
    ttyOf: async () => "/dev/ttys004",
    peek: async () => state.tab,
    inFront: async () => true,
    type: async (route, _tty, text) => {
      if (state.fail) throw new DeliveryError("terminal unreachable: test");
      typed.push(`${route}:${text}`);
      return true;
    },
  };
  return { ops, typed, state };
}

function helper(extra: Partial<RpcDeps> = {}) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", {
    cwd: "/Users/me/Projects/web-shop",
    env: { termProgram: "iTerm.app", claudePid: 4242 },
  });
  registry.touch("s2", { cwd: "/Users/me/Projects/api", env: { termProgram: "iTerm.app", claudePid: 4343 } });
  const queue = new ReplyQueue(db, events, registry);
  const t = terminal();
  const rpc = createRpc({
    db,
    events,
    registry,
    replies: queue,
    broker: { hasOpen: () => false },
    config: { preferTyping: true },
    typeOps: t.ops,
    pauseWait: { inlineMs: 400, pollMs: 20 },
    ...extra,
  } as unknown as RpcDeps);
  return { rpc, t, queue, db };
}

const send = (text: string, sendId?: string, sessionId = "s1") => ({ sessionId, text, sendId });

describe("session.send with a sendId", () => {
  const read = platform.presence.read;
  let idle: number | null = 60;
  beforeEach(() => {
    idle = 60;
    platform.presence.read = async () => ({ idleSeconds: idle, locked: false, source: "test" });
  });
  afterEach(() => {
    platform.presence.read = read;
  });

  test("the same id again is answered as the first time, with repeat, and typed nothing", async () => {
    const { rpc, t } = helper();
    expect(await rpc("session.send", send("Ship it", "id-1"), "phone")).toEqual({ result: { via: "iterm" } });
    expect(await rpc("session.send", send("Ship it", "id-1"), "phone")).toEqual({
      result: { via: "iterm", repeat: true },
    });
    expect(await rpc("session.send", send("Ship it", "id-1"), "phone")).toEqual({
      result: { via: "iterm", repeat: true },
    });
    expect(t.typed).toEqual(["iterm:Ship it"]);
  });

  test("another id, or none, is another message: typed again", async () => {
    const { rpc, t } = helper();
    await rpc("session.send", send("Yes", "id-1"), "phone");
    await rpc("session.send", send("Yes", "id-2"), "phone");
    await rpc("session.send", send("Yes"), "phone");
    await rpc("session.send", send("Yes"), "phone");
    expect(t.typed).toEqual(["iterm:Yes", "iterm:Yes", "iterm:Yes", "iterm:Yes"]);
  });

  test("ids are per session: the same id in another session is its own message", async () => {
    const { rpc, t } = helper();
    await rpc("session.send", send("Run it", "id-1", "s1"), "phone");
    expect(await rpc("session.send", send("Run it", "id-1", "s2"), "phone")).toEqual({
      result: { via: "iterm" },
    });
    expect(t.typed).toEqual(["iterm:Run it", "iterm:Run it"]);
    expect(await rpc("session.delivered", { sessionId: "s2", sendId: "id-1" }, "phone")).toEqual({
      result: { delivered: true, via: "iterm" },
    });
  });

  test("a repeat while the first still waits for a pause waits for it, and it's typed once", async () => {
    const { rpc, t } = helper({ pauseWait: { inlineMs: 2_000, pollMs: 20 } });
    idle = 0;
    t.state.tab = { front: true, screen: EMPTY_PROMPT };
    const first = rpc("session.send", send("After you", "id-1"), "phone");
    await Bun.sleep(60);
    const again = rpc("session.send", send("After you", "id-1"), "phone");
    const asked = rpc("session.delivered", { sessionId: "s1", sendId: "id-1" }, "phone");
    await Bun.sleep(60);
    expect(t.typed).toEqual([]);
    idle = 5;
    expect(await first).toEqual({ result: { via: "iterm" } });
    expect(await again).toEqual({ result: { via: "iterm", repeat: true } });
    expect(await asked).toEqual({ result: { delivered: true, via: "iterm" } });
    expect(t.typed).toEqual(["iterm:After you"]);
  });

  test('"queued" keeps working with the id: a repeat says queued and the reply queue holds it once', async () => {
    const { rpc, t, queue } = helper();
    idle = 0;
    t.state.tab = { front: true, screen: EMPTY_PROMPT };
    expect(await rpc("session.send", send("Later", "id-1"), "phone")).toEqual({
      result: { via: "queued", reason: "typing" },
    });
    expect(await rpc("session.send", send("Later", "id-1"), "phone")).toEqual({
      result: { via: "queued", reason: "typing", repeat: true },
    });
    expect(await rpc("session.delivered", { sessionId: "s1", sendId: "id-1" }, "phone")).toEqual({
      result: { delivered: true, via: "queued" },
    });
    expect(queue.list().map((r) => r.text)).toEqual(["Later"]);
    idle = 10;
    await queue.drain(
      false,
      deliverQueued({ preferTyping: true, hasOpenPrompt: () => false, typeOps: t.ops }),
    );
    expect(t.typed).toEqual(["iterm:Later"]);
    // Typed by the queue meanwhile: a late Try Again still types nothing.
    await rpc("session.send", send("Later", "id-1"), "phone");
    expect(t.typed).toEqual(["iterm:Later"]);
  });

  test("a send that failed is forgotten: the question says not delivered, and Try Again types it", async () => {
    const { rpc, t } = helper();
    t.state.fail = true;
    const failed = await rpc("session.send", send("Deploy", "id-1"), "phone");
    expect(failed).toMatchObject({ error: { code: "unavailable" } });
    expect(await rpc("session.delivered", { sessionId: "s1", sendId: "id-1" }, "phone")).toEqual({
      result: { delivered: false },
    });
    t.state.fail = false;
    expect(await rpc("session.send", send("Deploy", "id-1"), "phone")).toEqual({ result: { via: "iterm" } });
    expect(await rpc("session.send", send("Deploy", "id-1"), "phone")).toEqual({
      result: { via: "iterm", repeat: true },
    });
    expect(t.typed).toEqual(["iterm:Deploy"]);
  });

  test("a refused send (empty, unknown session) isn't remembered either", async () => {
    const { rpc } = helper();
    expect(await rpc("session.send", send("", "id-1"), "phone")).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(await rpc("session.send", send("Hi", "id-2", "nope"), "phone")).toMatchObject({
      error: { code: "not_found" },
    });
    expect(await rpc("session.delivered", { sessionId: "s1", sendId: "id-1" }, "phone")).toEqual({
      result: { delivered: false },
    });
    expect(await rpc("session.delivered", { sessionId: "nope", sendId: "id-2" }, "phone")).toEqual({
      result: { delivered: false },
    });
  });

  test("a repeat after the session ended is still answered: the message got there", async () => {
    const { rpc, t, db } = helper();
    await rpc("session.send", send("Bye", "id-1"), "phone");
    db.query("UPDATE sessions SET status = 'ended'").run();
    expect(await rpc("session.send", send("Bye", "id-2"), "phone")).toMatchObject({
      error: { code: "not_found" },
    });
    expect(await rpc("session.send", send("Bye", "id-1"), "phone")).toEqual({
      result: { via: "iterm", repeat: true },
    });
    expect(t.typed).toEqual(["iterm:Bye"]);
  });

  test("session.delivered: an id never sent isn't delivered; a bad id is refused", async () => {
    const { rpc } = helper();
    expect(await rpc("session.delivered", { sessionId: "s1", sendId: "never" }, "phone")).toEqual({
      result: { delivered: false },
    });
    expect(await rpc("session.delivered", { sessionId: "s1", sendId: "" }, "phone")).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(await rpc("session.send", send("x", "y".repeat(101)), "phone")).toMatchObject({
      error: { code: "bad_request" },
    });
  });
});

describe("SentMessages", () => {
  test("remembered for a day, then forgotten", async () => {
    let now = 1_000;
    const sent = new SentMessages(24 * 3600_000, 100, () => now);
    await sent.track("s1", "a", Promise.resolve({ via: "tmux" }));
    expect(await sent.get("s1", "a")).toEqual({ via: "tmux" });
    now += 24 * 3600_000;
    expect(await sent.get("s1", "a")).toEqual({ via: "tmux" });
    now += 1;
    expect(sent.get("s1", "a")).toBeUndefined();
  });

  test("at most `max`: the oldest go first", async () => {
    const sent = new SentMessages(24 * 3600_000, 3, () => 0);
    for (const id of ["a", "b", "c", "d"]) await sent.track("s1", id, Promise.resolve({ via: id }));
    expect(sent.size).toBe(3);
    expect(sent.get("s1", "a")).toBeUndefined();
    expect(await sent.get("s1", "d")).toEqual({ via: "d" });
  });

  test("a failed send is gone before anyone waiting on it hears", async () => {
    const sent = new SentMessages();
    let fail: (err: Error) => void = () => {};
    sent.track("s1", "a", new Promise((_, reject) => (fail = reject))).catch(() => {});
    const waiting = sent.get("s1", "a");
    fail(new Error("no"));
    await expect(waiting).rejects.toThrow("no");
    expect(sent.get("s1", "a")).toBeUndefined();
  });

  test("only `via` is kept, not other fields of the result", async () => {
    const sent = new SentMessages();
    await sent.track("s1", "a", Promise.resolve({ via: "tmux", repeat: true }));
    expect(await sent.get("s1", "a")).toEqual({ via: "tmux" });
  });
});

describe("protocol fixtures (sends.json)", () => {
  const fixtures = JSON.parse(
    readFileSync(join(import.meta.dir, "../../protocol/fixtures/sends.json"), "utf8"),
  );

  test("parse with the schemas", () => {
    expect(RpcSchemas["session.send"].parse(fixtures.params).sendId).toBe(fixtures.check.sendId);
    expect(RpcSchemas["session.delivered"].parse(fixtures.check)).toEqual(fixtures.check);
    for (const name of [
      "result",
      "resultQueued",
      "resultQueuedLocked",
      "resultQueuedTyping",
      "resultQueuedDraft",
      "resultRepeat",
    ])
      SendResult.parse(fixtures[name]);
    for (const name of ["delivered", "deliveredQueued", "notDelivered"]) DeliveryCheck.parse(fixtures[name]);
  });

  test("the waiting events parse, and a queued result without a reason (an older helper) still does", () => {
    for (const e of fixtures.waitingEvents) RelayEvent.parse(e);
    expect(fixtures.waitingEvents.map((e: { reason: string | null }) => e.reason)).toEqual([
      "draft",
      "typing",
      null,
    ]);
    expect(SendResult.parse(fixtures.resultQueued).reason).toBeUndefined();
  });

  test("a send without sendId (older phones) still parses", () => {
    const { sendId: _, ...older } = fixtures.params;
    expect(RpcSchemas["session.send"].parse(older).sendId).toBeUndefined();
  });
});

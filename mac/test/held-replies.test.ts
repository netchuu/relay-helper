import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterruptResult, RelayEvent, SendResult, Session } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeldReplies } from "../src/daemon/held.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import { PHONE_PREFIX, STOP_MESSAGE } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { type HookEnv, publicSession, Registry } from "../src/daemon/registry.ts";
import { deliverQueued, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { TurnStopper } from "../src/daemon/stop.ts";
import { platform } from "../src/platform/index.ts";

// Claude Code may hold an inbox message at the Mac for approval; the helper tells the phone by whether the prompt hook follows.

const dirs: string[] = [];
const servers: Server[] = [];
const read = platform.presence.read;
afterEach(() => {
  platform.presence.read = read;
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const WAIT = 80;
const EXPIRE = 400;

// One session id per test: the held and mode state is kept per id, and a timer left over from an earlier test must not touch this one.
let counter = 0;

async function setup(headless?: { has: () => boolean; send: () => Promise<void> }) {
  const sid = `s${++counter}`;
  platform.presence.read = async () => ({ idleSeconds: 60, locked: false, source: "test" });
  const dir = mkdtempSync(join(tmpdir(), "relay-held-"));
  dirs.push(dir);
  const path = join(dir, "i.sock");
  const inbox: string[] = [];
  const server = createServer((s) =>
    s.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === "user") inbox.push(msg.message.content);
      }
    }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));

  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const held = new HeldReplies({ events, registry, timing: { waitMs: WAIT, expireMs: EXPIRE } });
  const broker = new Broker(db, events);
  const config = { previewChars: 600, preferTyping: false } as RelayConfig;
  const presence = { noteLocalActivity: () => {} } as unknown as PresenceMonitor;
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config,
    held,
    keys: {
      pty: async () => ({ ok: false, reason: "bad_request" }),
      tmux: async () => {},
      routes: () => [],
      app: async () => false,
      ttyOf: async () => null,
    } as never,
    inbox: async (_p, _t, text) => void inbox.push(text),
    timing: { graceMs: 5, markerMs: 50, inboxMs: 150, pollMs: 20 },
    transcriptPath: () => null,
  });
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper, held });
  const rpc = createRpc({
    db,
    events,
    registry,
    broker,
    presence,
    config,
    stopper,
    held,
    headless,
  } as unknown as RpcDeps);
  const env: HookEnv = { socket: path, token: "tok", claudePid: 4242, termProgram: "vscode" };
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: sid, cwd: dir, ...fields }, env } as HookEnvelope,
      new AbortController().signal,
    );
  await hook("SessionStart", { permission_mode: "bypassPermissions" });
  // What Claude Code reports back for an inbox message: the framing, then the text.
  const arrives = (text: string) =>
    hook("UserPromptSubmit", {
      prompt: `Another Claude session sent a message:\n${PHONE_PREFIX}\n${text}\n\nThis came from another Claude session.`,
    });
  const held_ = () =>
    seen.filter((e) => e.type === "reply.held").map((e) => ({ ...e }) as never as Record<string, unknown>);
  const states = () => held_().map((e) => e.state);
  const send = async (text: string) => {
    const out = (await rpc("session.send", { sessionId: sid, text }, "phone")) as { result: unknown };
    return SendResult.parse(out.result);
  };
  const pub = () => {
    const s = registry.get(sid);
    return s ? publicSession(s) : null;
  };
  const queue = new ReplyQueue(db, events, registry);
  return { sid, queue, registry, pub, seen, hook, arrives, send, states, held_, rpc, inbox, held };
}

describe("a reply through the inbox", () => {
  test("delivered: the hook with its text follows, nothing is held", async () => {
    const t = await setup();
    await t.hook("Stop");
    setTimeout(() => void t.arrives("Ship it"), 20);
    expect(await t.send("Ship it")).toEqual({ via: "socket" });
    expect(t.inbox).toEqual([`${PHONE_PREFIX}\nShip it`]);
    await Bun.sleep(WAIT * 2);
    expect(t.states()).toEqual([]);
    expect(t.pub()?.heldAtMac).toBeUndefined();
  });

  test("held, then delivered when the hook arrives later", async () => {
    const t = await setup();
    await t.hook("Stop");
    expect(await t.send("Ship it")).toEqual({ via: "socket", heldAtMac: true });
    const upserts = () =>
      t.seen.filter((e) => e.type === "session.upsert") as { session: { heldAtMac?: true } }[];
    expect(upserts().at(-1)?.session.heldAtMac).toBe(true);
    expect(t.states()).toEqual(["waiting"]);
    await t.arrives("Ship it");
    expect(t.states()).toEqual(["waiting", "delivered"]);
    expect(upserts().at(-1)?.session.heldAtMac).toBeUndefined();
    expect(t.registry.get(t.sid)?.status).toBe("working");
  });

  test("held, then expired when the hold's time is up", async () => {
    const t = await setup();
    await t.hook("Stop");
    expect(await t.send("Ship it")).toEqual({ via: "socket", heldAtMac: true });
    await Bun.sleep(EXPIRE + 100);
    expect(t.states()).toEqual(["waiting", "expired"]);
    // A hook after that is no delivery of it.
    await t.arrives("Ship it");
    expect(t.states()).toEqual(["waiting", "expired"]);
  });

  test("a hook with other text doesn't count", async () => {
    const t = await setup();
    await t.hook("Stop");
    setTimeout(() => void t.arrives("Something else"), 20);
    expect(await t.send("Ship it")).toEqual({ via: "socket", heldAtMac: true });
  });

  test("a working session isn't held while its turn runs, only if the turn ends without it", async () => {
    const t = await setup();
    await t.hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    expect(t.registry.get(t.sid)?.status).toBe("working");
    const started = Date.now();
    expect(await t.send("Also the footer")).toEqual({ via: "socket" });
    expect(Date.now() - started).toBeLessThan(WAIT);
    await Bun.sleep(WAIT * 3);
    expect(t.states()).toEqual([]);
    expect(t.pub()?.heldAtMac).toBeUndefined();
    // The turn ends and the message never came: now it is held.
    await t.hook("Stop");
    await Bun.sleep(WAIT * 3);
    expect(t.states()).toEqual(["waiting"]);
    expect(t.pub()?.heldAtMac).toBe(true);
  });

  test("a working session that takes the message at its next step has nothing held", async () => {
    const t = await setup();
    await t.hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    expect(await t.send("Also the footer")).toEqual({ via: "socket" });
    await t.arrives("Also the footer");
    await t.hook("Stop");
    await Bun.sleep(WAIT * 3);
    expect(t.states()).toEqual([]);
  });

  test("a permission prompt in the middle of the turn doesn't end it", async () => {
    const t = await setup();
    await t.hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    expect(await t.send("Also the footer")).toEqual({ via: "socket" });
    void t.hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } });
    await Bun.sleep(20);
    expect(t.registry.get(t.sid)?.status).toBe("waiting");
    await Bun.sleep(WAIT * 3);
    expect(t.states()).toEqual([]);
    expect(t.pub()?.heldAtMac).toBeUndefined();
  });

  test("the person typing a longer message that starts with the same words doesn't deliver it", async () => {
    const t = await setup();
    await t.hook("Stop");
    expect(await t.send("yes")).toEqual({ via: "socket", heldAtMac: true });
    await t.hook("UserPromptSubmit", { prompt: "yes, but first look at the logs" });
    expect(t.states()).toEqual(["waiting"]);
    expect(t.pub()?.heldAtMac).toBe(true);
    await t.arrives("yes");
    expect(t.states()).toEqual(["waiting", "delivered"]);
  });

  test("a longer held message arriving first doesn't take the shorter one's place", async () => {
    const t = await setup();
    await t.hook("Stop");
    expect(await t.send("Fix the tests")).toEqual({ via: "socket", heldAtMac: true });
    expect(await t.send("Fix the tests\nand the lint")).toEqual({ via: "socket", heldAtMac: true });
    await t.arrives("Fix the tests\nand the lint");
    expect(t.states()).toEqual(["waiting", "waiting", "delivered"]);
    expect(t.pub()?.heldAtMac).toBe(true);
    await t.arrives("Fix the tests");
    expect(t.states()).toEqual(["waiting", "waiting", "delivered", "delivered"]);
    expect(t.pub()?.heldAtMac).not.toBe(true);
  });

  test("the events name the send they are about", async () => {
    const t = await setup();
    await t.hook("Stop");
    const send = async (text: string, sendId: string) =>
      SendResult.parse(
        ((await t.rpc("session.send", { sessionId: t.sid, text, sendId }, "phone")) as { result: unknown })
          .result,
      );
    expect(await send("First", "id-1")).toEqual({ via: "socket", heldAtMac: true });
    expect(await send("Second", "id-2")).toEqual({ via: "socket", heldAtMac: true });
    await t.arrives("Second");
    await t.arrives("First");
    expect(t.held_().map((e) => [e.state, e.sendId])).toEqual([
      ["waiting", "id-1"],
      ["waiting", "id-2"],
      ["delivered", "id-2"],
      ["delivered", "id-1"],
    ]);
  });

  test("a queued reply that goes through the inbox is watched too", async () => {
    const t = await setup();
    await t.hook("Stop");
    t.queue.add(t.sid, "Later", Date.now(), "unlock");
    await t.queue.drain(deliverQueued({ preferTyping: false, hasOpenPrompt: () => false, held: t.held }));
    await Bun.sleep(WAIT * 3);
    expect(t.inbox).toEqual([`${PHONE_PREFIX}\nLater`]);
    expect(t.states()).toEqual(["waiting"]);
    expect(t.pub()?.heldAtMac).toBe(true);
    await t.arrives("Later");
    expect(t.states()).toEqual(["waiting", "delivered"]);
  });

  test("a drained held reply's events carry the phone's id", async () => {
    const t = await setup();
    await t.hook("Stop");
    t.queue.add(t.sid, "Later", Date.now(), "unlock", "id-q");
    expect(t.queue.list(t.sid)[0]?.sendId).toBe("id-q");
    await t.queue.drain(deliverQueued({ preferTyping: false, hasOpenPrompt: () => false, held: t.held }));
    await Bun.sleep(WAIT * 3);
    await t.arrives("Later");
    expect(t.held_().map((e) => [e.state, e.sendId])).toEqual([
      ["waiting", "id-q"],
      ["delivered", "id-q"],
    ]);
  });

  test("the turn a sent message starts names the send, however it got there", async () => {
    const t = await setup();
    const started = () =>
      t.seen.filter((e) => e.type === "turn.started").map((e) => (e as { sendId?: string }).sendId);
    await t.hook("Stop");
    await t.rpc("session.send", { sessionId: t.sid, text: "First", sendId: "id-1" }, "phone");
    await t.arrives("First");
    expect(started()).toEqual(["id-1"]);
    await t.hook("Stop");
    t.queue.add(t.sid, "Later", Date.now(), "unlock", "id-q");
    await t.queue.drain(deliverQueued({ preferTyping: false, hasOpenPrompt: () => false, held: t.held }));
    await t.arrives("Later");
    expect(started()).toEqual(["id-1", "id-q"]);
  });

  test("a session the helper runs names the send on its turn too", async () => {
    const t = await setup({ has: () => true, send: async () => {} });
    await t.hook("Stop");
    const res = await t.rpc("session.send", { sessionId: t.sid, text: "Go", sendId: "id-h" }, "phone");
    expect(SendResult.parse((res as { result: unknown }).result)).toEqual({ via: "headless" });
    await t.hook("UserPromptSubmit", { prompt: "Go" });
    expect(
      t.seen.filter((e) => e.type === "turn.started").map((e) => (e as { sendId?: string }).sendId),
    ).toEqual(["id-h"]);
  });

  test("the permission mode stays on the session", async () => {
    const t = await setup();
    expect(t.pub()?.permissionMode).toBe("bypassPermissions");
    await t.hook("PreToolUse", { permission_mode: "plan", tool_name: "Read", tool_input: {} });
    const last = (
      t.seen.filter((e) => e.type === "session.upsert").at(-1) as { session: { permissionMode?: string } }
    ).session;
    expect(last.permissionMode).toBe("plan");
  });
});

describe("the phone's Stop through the inbox", () => {
  test("held: it says nothing stopped, and delivered once the hook arrives", async () => {
    const t = await setup();
    await t.hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    const out = (await t.rpc("session.interrupt", { sessionId: t.sid }, "phone")) as {
      result: { via: string; heldAtMac?: true };
    };
    expect(t.inbox).toEqual([STOP_MESSAGE]);
    expect(out.result).toMatchObject({ via: "message", heldAtMac: true });
    expect(t.held_()).toEqual([expect.objectContaining({ state: "waiting", stop: true })]);
    await t.hook("UserPromptSubmit", { prompt: STOP_MESSAGE });
    expect(t.held_().map((e) => e.state)).toEqual(["waiting", "delivered"]);
  });

  test("a second tap within the repeat window on a held stop is still held", async () => {
    const t = await setup();
    await t.hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    const tap = async () =>
      ((await t.rpc("session.interrupt", { sessionId: t.sid }, "phone")) as { result: { heldAtMac?: true } })
        .result;
    expect((await tap()).heldAtMac).toBe(true);
    expect((await tap()).heldAtMac).toBe(true);
    expect(t.inbox).toEqual([STOP_MESSAGE]);
  });

  test("taken at once: not held", async () => {
    const t = await setup();
    await t.hook("UserPromptSubmit", { prompt: "Rewrite the checkout" });
    const pending = t.rpc("session.interrupt", { sessionId: t.sid }, "phone");
    await Bun.sleep(30);
    await t.hook("UserPromptSubmit", { prompt: STOP_MESSAGE });
    const out = (await pending) as { result: { via: string; heldAtMac?: true } };
    expect(out.result.heldAtMac).toBeUndefined();
    expect(t.held_()).toEqual([]);
  });
});

describe("protocol fixtures (sends.json)", () => {
  const fixtures = JSON.parse(
    readFileSync(join(import.meta.dir, "../../protocol/fixtures/sends.json"), "utf8"),
  );

  test("a held reply, its events, the session and the stop all parse", () => {
    expect(SendResult.parse(fixtures.resultHeld)).toEqual({ via: "socket", heldAtMac: true });
    for (const e of fixtures.heldEvents) RelayEvent.parse(e);
    expect(Session.parse(fixtures.sessionHeld).permissionMode).toBe("bypassPermissions");
    expect(InterruptResult.parse(fixtures.interruptHeld).heldAtMac).toBe(true);
  });

  test("old shapes without the new fields still parse", () => {
    expect(SendResult.parse(fixtures.result).heldAtMac).toBeUndefined();
    expect(SendResult.parse({ via: "socket" })).toEqual({ via: "socket" });
    expect(InterruptResult.parse({ via: "inbox", turnId: null }).heldAtMac).toBeUndefined();
  });
});

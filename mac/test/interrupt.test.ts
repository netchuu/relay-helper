import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterruptResult, type RelayEvent, type Turn } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import { type KeyOps, postToInbox, STOP_MESSAGE, STOP_TEXT, tmuxEscapeArgs } from "../src/daemon/inject.ts";
import { alertFor, turnAlert } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { type HookEnv, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { TurnStopper } from "../src/daemon/stop.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";
import { answerRequest, KEY_BYTES, type RequestContext } from "../src/shell/ptyShell.ts";

// The phone's Stop ends Claude's current turn, like Esc; the session stays open.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Keys {
  pty: { socketPath: string; pid: number }[];
  tmux: { socket: string; pane: string }[];
  app: string[];
  ptyReply: { ok: true } | { ok: false; reason: "bad_request" };
  tmuxFails: boolean;
  routes: ("iterm" | "terminal")[];
  appOk: boolean;
}

function setup(opts: { inboxFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-stop-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  // As in main.ts: a session's "waiting" follows its open prompts.
  const broker: Broker = new Broker(db, events, (id) => {
    const s = registry.get(id);
    if (!s || s.status === "ended") return;
    if (broker.hasOpen(id)) {
      if (s.status !== "waiting") registry.setStatus(id, "waiting");
    } else if (s.status === "waiting") registry.setStatus(id, "working");
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const keys: Keys = {
    pty: [],
    tmux: [],
    app: [],
    ptyReply: { ok: true },
    tmuxFails: false,
    routes: [],
    appOk: true,
  };
  const keyOps: KeyOps = {
    pty: async (socketPath, _token, pid) => {
      keys.pty.push({ socketPath, pid });
      return keys.ptyReply;
    },
    tmux: async (socket, pane) => {
      if (keys.tmuxFails) throw new Error("no tmux");
      keys.tmux.push({ socket, pane });
    },
    routes: () => keys.routes,
    app: async (route) => {
      keys.app.push(route);
      return keys.appOk;
    },
    ttyOf: async () => "/dev/ttys009",
  };
  const inboxSent: string[] = [];
  const config = { previewChars: 600 } as RelayConfig;
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config,
    keys: keyOps,
    inbox: async (_path, _token, text) => {
      if (opts.inboxFails) {
        const { DeliveryError } = await import("../src/daemon/inject.ts");
        throw new DeliveryError("session inbox unreachable");
      }
      inboxSent.push(text);
    },
    timing: { graceMs: 5, markerMs: 600, inboxMs: 300, pollMs: 20, repeatMs: 2000 },
    transcriptPath: () => transcript,
  });
  const presence = { noteLocalActivity: () => {} } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper });
  const rpc = createRpc({ db, events, registry, broker, presence, config, stopper } as unknown as RpcDeps);

  const hook = (event: string, sessionId: string, fields: Record<string, unknown> = {}, env: HookEnv = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: sessionId, cwd: dir, ...fields },
        env,
      } as HookEnvelope,
      new AbortController().signal,
    );
  /** A session that is working on a turn (its UserPromptSubmit came in). */
  const working = async (id: string, env: HookEnv) => {
    await hook("SessionStart", id, {}, env);
    await hook("UserPromptSubmit", id, { prompt: "Rewrite the checkout" }, env);
  };
  const tx = (...entries: Record<string, unknown>[]) =>
    writeFileSync(
      transcript,
      `${entries.map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join("\n")}\n`,
    );
  const turnsDone = () => seen.filter((e) => e.type === "turn.done").map((e) => (e as { turn: Turn }).turn);
  return {
    db,
    events,
    registry,
    broker,
    stopper,
    hooks,
    rpc,
    hook,
    working,
    tx,
    keys,
    inboxSent,
    seen,
    turnsDone,
  };
}

const TMUX: HookEnv = { tmux: "/tmp/tmux-501/default,1,0", tmuxPane: "%3", claudePid: 4242 };
const INBOX: HookEnv = {
  socket: "/tmp/cc-socks/1.sock",
  token: "tok",
  claudePid: 4242,
  termProgram: "vscode",
};
const PTY: HookEnv = { pty: "/tmp/pty.sock", ptyToken: "p", claudePid: 4242, ...TMUX };
const partial = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Starting with the cart page." },
      { type: "tool_use", name: "Edit", input: { file_path: "/src/cart.svelte" } },
    ],
  },
};
const marker = {
  type: "user",
  message: { content: [{ type: "text", text: "[Request interrupted by user]\n" }] },
};

describe("session.interrupt: a prompt is open", () => {
  test("the waiting hook gets deny-and-interrupt, the prompt closes as Stopped, the turn ends stopped", async () => {
    const { working, hook, rpc, registry, keys, seen, turnsDone, tx } = setup();
    await working("s1", INBOX);
    tx(partial);
    const reply = hook("PermissionRequest", "s1", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    expect(registry.get("s1")?.status).toBe("waiting");
    const out = await rpc("session.interrupt", { sessionId: "s1" }, "device:d1");
    expect(out).toEqual({ result: { via: "prompt", turnId: expect.any(String) } });
    const decision = JSON.parse((await reply).stdout).hookSpecificOutput.decision;
    expect(decision).toEqual({
      behavior: "deny",
      message: "The user stopped this from their phone.",
      interrupt: true,
    });
    const closed = seen.find((e) => e.type === "prompt.closed");
    expect(closed).toMatchObject({ resolvedBy: "phone", outcome: "Stopped" });
    const [turn] = turnsDone();
    expect(turn?.stopped).toBe(true);
    expect(turn?.failed).toBe(false);
    expect(turn?.summary).toBe("Starting with the cart page.");
    expect(registry.get("s1")?.status).toBe("idle");
    // No Esc: the hook did it, in every terminal.
    expect(keys.tmux.length + keys.pty.length + keys.app.length).toBe(0);
  });

  test("the session's other open prompts close as superseded, and the Inbox history says Stopped", async () => {
    const { working, broker, rpc, hook } = setup();
    await working("s1", INBOX);
    const first = hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "a" } });
    const second = hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "b" } });
    await rpc("session.interrupt", { sessionId: "s1" }, "device:d1");
    expect(JSON.parse((await first).stdout).hookSpecificOutput.decision.interrupt).toBe(true);
    expect((await second).stdout).toBe("");
    const recent = broker.listRecent(10);
    expect(recent.map((p) => p.outcome).sort()).toEqual(["Closed", "Stopped"]);
    expect(broker.hasOpen("s1")).toBe(false);
  });

  test("a question and a plan are stopped the same way", async () => {
    for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
      const { working, rpc, hook } = setup();
      await working("s1", INBOX);
      const reply = hook("PermissionRequest", "s1", {
        tool_name: tool,
        tool_input: { questions: [], plan: "x" },
      });
      expect((await rpc("session.interrupt", { sessionId: "s1" }, "device:d1")) as unknown).toMatchObject({
        result: { via: "prompt" },
      });
      expect(JSON.parse((await reply).stdout).hookSpecificOutput.decision.behavior).toBe("deny");
    }
  });
});

describe("session.interrupt: Esc in the terminal", () => {
  test("tmux gets Escape, and the turn ends stopped once the transcript has the marker", async () => {
    const { working, rpc, registry, keys, turnsDone, tx, db } = setup();
    await working("s1", TMUX);
    tx(partial);
    const pending = rpc("session.interrupt", { sessionId: "s1" }, "device:d1");
    await Bun.sleep(60);
    tx(partial, marker);
    const out = (await pending) as { result: { via: string; turnId: string } };
    expect(out.result.via).toBe("tmux");
    expect(keys.tmux).toEqual([{ socket: "/tmp/tmux-501/default", pane: "%3" }]);
    const [turn] = turnsDone();
    expect(turn?.id).toBe(out.result.turnId);
    expect(turn?.stopped).toBe(true);
    expect(turn?.stats.toolCalls).toBe(1);
    expect(turn?.stats.filesEdited).toEqual(["/src/cart.svelte"]);
    expect(registry.get("s1")?.status).toBe("idle");
    expect(registry.get("s1")?.lastSummary).toBe("Starting with the cart page.");
    // Stored, so the history after a reconnect says Stopped too.
    const turns = (await rpc("session.turns", { sessionId: "s1" }, "device:d1")) as { result: Turn[] };
    expect(turns.result[0]?.stopped).toBe(true);
    const row = db.query("SELECT stopped FROM turns WHERE id = ?").get(out.result.turnId) as {
      stopped: number;
    };
    expect(row.stopped).toBe(1);
  });

  test("relay shell comes first; one from before key requests (bad_request) falls through to tmux", async () => {
    const a = setup();
    await a.working("s1", PTY);
    a.tx(marker);
    expect(
      ((await a.rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: { via: string } }).result
        .via,
    ).toBe("pty");
    expect(a.keys.tmux).toHaveLength(0);

    const b = setup();
    b.keys.ptyReply = { ok: false, reason: "bad_request" };
    await b.working("s1", PTY);
    b.tx(marker);
    expect(
      ((await b.rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: { via: string } }).result
        .via,
    ).toBe("tmux");
    expect(b.keys.pty).toHaveLength(1);
  });

  test("iTerm2 when it's the only key route", async () => {
    const { working, rpc, keys, tx } = setup();
    keys.routes = ["iterm"];
    await working("s1", { claudePid: 4242, termProgram: "iTerm.app" });
    tx(marker);
    expect(
      ((await rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: { via: string } }).result.via,
    ).toBe("iterm");
    expect(keys.app).toEqual(["iterm"]);
  });

  test("no marker within the wait: turnId null, the session keeps working, nothing is announced", async () => {
    const { working, rpc, registry, turnsDone } = setup();
    await working("s1", TMUX);
    const out = (await rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: unknown };
    expect(out.result).toEqual({ via: "tmux", turnId: null });
    expect(registry.get("s1")?.status).toBe("working");
    expect(turnsDone()).toHaveLength(0);
  });

  test("a message queued at the computer, submitted by the Esc: the old turn is stopped, the new one keeps working", async () => {
    const { working, rpc, hook, registry, turnsDone, tx } = setup();
    await working("s1", TMUX);
    const pending = rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(30);
    tx(partial, marker);
    await hook("UserPromptSubmit", "s1", { prompt: "queued one" }, TMUX);
    tx(partial, marker, { type: "user", message: { content: "queued one" } });
    const out = (await pending) as { result: { turnId: string } };
    const [turn] = turnsDone();
    expect(turn?.id).toBe(out.result.turnId);
    expect(turn?.prompt).toBe("Rewrite the checkout");
    expect(turn?.stopped).toBe(true);
    expect(registry.get("s1")?.status).toBe("working");
  });

  test("a Stop hook after the stop doesn't record the turn a second time", async () => {
    const { working, rpc, hook, turnsDone, tx, registry } = setup();
    await working("s1", TMUX);
    tx(marker);
    await rpc("session.interrupt", { sessionId: "s1" }, "d");
    await hook("Stop", "s1", { last_assistant_message: "late" }, TMUX);
    expect(turnsDone()).toHaveLength(1);
    expect(registry.get("s1")?.status).toBe("idle");
  });

  test("a turn that finished on its own while Relay looked for the marker isn't marked stopped", async () => {
    const { working, rpc, hook, turnsDone } = setup();
    await working("s1", TMUX);
    const pending = rpc("session.interrupt", { sessionId: "s1" }, "d");
    await hook("Stop", "s1", { last_assistant_message: "Done anyway." }, TMUX);
    expect(((await pending) as { result: { turnId: string | null } }).result.turnId).toBeNull();
    expect(turnsDone().map((t) => t.stopped)).toEqual([undefined]);
  });
});

describe("session.interrupt: through the inbox", () => {
  test("no key route: a 'now' stop message; Claude Code starts a turn with it, so the old one ended stopped", async () => {
    const { working, rpc, hook, registry, inboxSent, turnsDone, tx } = setup();
    await working("s1", INBOX);
    tx(partial);
    const pending = rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(30);
    expect(inboxSent).toEqual([STOP_MESSAGE]);
    // What Claude Code 2.1.318 does: the turn is cut off and one with the message starts at once. Its answer
    // to the message comes later and belongs to the new turn, not the stopped one.
    tx(partial, {
      type: "assistant",
      timestamp: new Date(Date.now() + 2000).toISOString(),
      message: { content: [{ type: "text", text: "I've stopped." }] },
    });
    await hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    const out = (await pending) as { result: { via: string; turnId: string } };
    expect(out.result.via).toBe("inbox");
    const [turn] = turnsDone();
    expect(turn?.id).toBe(out.result.turnId);
    expect(turn?.stopped).toBe(true);
    expect(turn?.summary).toBe("Starting with the cart page.");
    // Claude answers the stop message in a turn of its own.
    expect(registry.get("s1")?.status).toBe("working");
    await hook("Stop", "s1", { last_assistant_message: "I've stopped." }, INBOX);
    expect(turnsDone().map((t) => t.stopped ?? false)).toEqual([true, false]);
  });

  test("Claude Code doesn't start a turn with it (held for approval, or queued): via message, nothing stopped", async () => {
    const { working, rpc, registry, turnsDone } = setup();
    await working("s1", INBOX);
    const out = (await rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: unknown };
    expect(out.result).toEqual({ via: "message", turnId: null });
    expect(registry.get("s1")?.status).toBe("working");
    expect(turnsDone()).toHaveLength(0);
  });

  test("a held message delivered later still ends the old turn as stopped", async () => {
    const { working, rpc, hook, turnsDone } = setup();
    await working("s1", INBOX);
    await rpc("session.interrupt", { sessionId: "s1" }, "d");
    await hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    await Bun.sleep(30);
    expect(turnsDone()[0]?.stopped).toBe(true);
  });

  test("an ordinary prompt mentioning nothing of the stop isn't mistaken for it", async () => {
    const { working, rpc, hook, turnsDone } = setup();
    await working("s1", INBOX);
    await rpc("session.interrupt", { sessionId: "s1" }, "d");
    await hook("UserPromptSubmit", "s1", { prompt: "something else" }, INBOX);
    expect(turnsDone()).toHaveLength(0);
  });

  test("tmux tried first but failing falls through to the inbox", async () => {
    const { working, rpc, keys, inboxSent } = setup();
    keys.tmuxFails = true;
    await working("s1", { ...TMUX, ...INBOX });
    expect(
      ((await rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: { via: string } }).result.via,
    ).toBe("message");
    expect(inboxSent).toHaveLength(1);
  });

  test("an unreachable inbox, or no route at all, is unavailable", async () => {
    const a = setup({ inboxFails: true });
    await a.working("s1", INBOX);
    expect(await a.rpc("session.interrupt", { sessionId: "s1" }, "d")).toMatchObject({
      error: { code: "unavailable" },
    });
    const b = setup();
    await b.working("s1", { claudePid: 4242 });
    expect(await b.rpc("session.interrupt", { sessionId: "s1" }, "d")).toMatchObject({
      error: { code: "unavailable" },
    });
  });
});

describe("session.interrupt: errors and races", () => {
  test("unknown or ended → not_found; idle → conflict; an older helper's answer is unknown method", async () => {
    const { rpc, hook, working } = setup();
    expect(await rpc("session.interrupt", { sessionId: "nope" }, "d")).toMatchObject({
      error: { code: "not_found" },
    });
    await hook("SessionStart", "idle1", {}, TMUX);
    expect(await rpc("session.interrupt", { sessionId: "idle1" }, "d")).toMatchObject({
      error: { code: "conflict" },
    });
    await working("gone", TMUX);
    await hook("SessionEnd", "gone", {}, TMUX);
    expect(await rpc("session.interrupt", { sessionId: "gone" }, "d")).toMatchObject({
      error: { code: "not_found" },
    });
    expect(await rpc("session.interrupt", {}, "d")).toMatchObject({ error: { code: "bad_request" } });
  });

  test("two phones at once: one Esc, the same answer for both", async () => {
    const { working, rpc, keys, tx } = setup();
    await working("s1", TMUX);
    tx(marker);
    const [a, b] = await Promise.all([
      rpc("session.interrupt", { sessionId: "s1" }, "device:a"),
      rpc("session.interrupt", { sessionId: "s1" }, "device:b"),
    ]);
    expect(keys.tmux).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test("Stop again right after an Esc that didn't show yet: no second Esc (two open Claude Code's rewind menu)", async () => {
    const { working, rpc, keys } = setup();
    await working("s1", TMUX);
    const first = await rpc("session.interrupt", { sessionId: "s1" }, "d");
    const second = await rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(keys.tmux).toHaveLength(1);
    expect(second).toEqual(first);
  });

  test("Stop after the turn ended: conflict, and no key is pressed", async () => {
    const { working, rpc, hook, keys } = setup();
    await working("s1", TMUX);
    await hook("Stop", "s1", { last_assistant_message: "Done." }, TMUX);
    expect(await rpc("session.interrupt", { sessionId: "s1" }, "d")).toMatchObject({
      error: { code: "conflict" },
    });
    expect(keys.tmux).toHaveLength(0);
  });

  test("audited with the route, never any text; no push for a stopped turn", async () => {
    const { working, rpc, db, tx, turnsDone } = setup();
    await working("s1", TMUX);
    tx(marker);
    await rpc("session.interrupt", { sessionId: "s1" }, "device:d1");
    const row = db.query("SELECT actor, detail FROM audit WHERE action = 'session.interrupt'").get() as {
      actor: string;
      detail: string;
    };
    expect(row.actor).toBe("device:d1");
    expect(JSON.parse(row.detail)).toMatchObject({ sessionId: "s1", via: "tmux" });
    expect(row.detail).not.toContain("Rewrite");
    const event = { seq: 1, ts: 1, type: "turn.done", turn: turnsDone()[0] } as RelayEvent;
    expect(alertFor(event, () => "web-shop")).toBeNull();
  });

  test("the result matches the protocol schema", async () => {
    const { working, rpc, tx } = setup();
    await working("s1", TMUX);
    tx(marker);
    const out = (await rpc("session.interrupt", { sessionId: "s1" }, "d")) as { result: unknown };
    expect(InterruptResult.safeParse(out.result).success).toBe(true);
  });
});

describe("Esc at the computer", () => {
  test("once Claude Code reports the session idle, the open turn with the marker ends stopped", async () => {
    const { working, registry, stopper, tx, turnsDone } = setup();
    await working("s1", TMUX);
    tx(partial, marker);
    // What reconcile does when `claude agents --json` says idle.
    registry.setStatus("s1", "idle", { keepUpdatedAt: true });
    stopper.sweep();
    expect(turnsDone()[0]?.stopped).toBe(true);
    stopper.sweep();
    expect(turnsDone()).toHaveLength(1);
  });

  test("an idle session without the marker keeps its turn open", async () => {
    const { working, registry, stopper, tx, turnsDone } = setup();
    await working("s1", TMUX);
    tx(partial);
    registry.setStatus("s1", "idle", { keepUpdatedAt: true });
    stopper.sweep();
    expect(turnsDone()).toHaveLength(0);
  });
});

describe("failed turns and transcript history", () => {
  test("a failed turn's push says failed; 'stopped' only means you stopped it", () => {
    const turn = {
      id: "t",
      sessionId: "s",
      prompt: null,
      summary: "",
      fullLength: 0,
      truncated: false,
      stats: { durationMs: null, toolCalls: 0, filesEdited: [] },
      failed: true,
      startedAt: null,
      endedAt: 1,
    };
    expect(turnAlert(turn, "web-shop").title).toBe("web-shop failed");
  });

  test("the interrupt marker isn't shown as a message, and the turn before it is stopped", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-tx-"));
    dirs.push(dir);
    const path = join(dir, "s.jsonl");
    const lines = [
      { type: "user", uuid: "u1", timestamp: "2026-11-04T10:00:00Z", message: { content: "count to 400" } },
      {
        type: "assistant",
        timestamp: "2026-11-04T10:00:05Z",
        message: { content: [{ type: "text", text: "one two" }] },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-11-04T10:00:06Z",
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      },
      { type: "user", uuid: "u3", timestamp: "2026-11-04T10:01:00Z", message: { content: "next" } },
      {
        type: "assistant",
        timestamp: "2026-11-04T10:01:02Z",
        message: { content: [{ type: "text", text: "ok" }] },
      },
    ];
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const turns = transcriptTurns("s", path, { limit: 10, previewChars: 600, working: false });
    expect(turns.map((t) => t.prompt)).toEqual(["next", "count to 400"]);
    expect(turns[1]?.stopped).toBe(true);
    expect(turns[1]?.stats.durationMs).toBe(6000);
    expect("stopped" in (turns[0] as Turn)).toBe(false);
  });
});

describe("the key transports", () => {
  const ctx = (over: Partial<RequestContext> = {}) => {
    const written: string[] = [];
    const c: RequestContext = {
      token: "tok",
      shellPid: 1,
      isForeground: async () => true,
      lastInput: () => Date.now(),
      pasteOn: () => true,
      write: (d) => written.push(d),
      sleep: async () => {},
      now: () => Date.now(),
      ...over,
    };
    return { c, written };
  };

  test("relay shell: a key request writes ESC alone, without waiting for you to stop typing", async () => {
    const { c, written } = ctx();
    expect(await answerRequest(JSON.stringify({ token: "tok", pid: 7, key: "escape" }), c)).toEqual({
      ok: true,
    });
    expect(written).toEqual([KEY_BYTES.escape]);
    expect(KEY_BYTES.escape).toBe("\x1b");
  });

  test("relay shell: never into a program that isn't the agent in front; wrong token refused", async () => {
    const { c, written } = ctx({ isForeground: async () => false });
    expect(await answerRequest(JSON.stringify({ token: "tok", pid: 7, key: "escape" }), c)).toEqual({
      ok: false,
      reason: "not_foreground",
    });
    expect(await answerRequest(JSON.stringify({ token: "x", pid: 7, key: "escape" }), c)).toEqual({
      ok: false,
      reason: "auth",
    });
    expect(await answerRequest(JSON.stringify({ token: "tok", pid: 7, key: "f1" }), c)).toEqual({
      ok: false,
      reason: "bad_request",
    });
    expect(written).toEqual([]);
  });

  test("relay shell: typing is unchanged (text, then Enter, after a quiet moment)", async () => {
    let t = 0;
    const { c, written } = ctx({ lastInput: () => 0, now: () => (t += 1000) });
    expect(await answerRequest(JSON.stringify({ token: "tok", pid: 7, text: "hi" }), c)).toEqual({
      ok: true,
    });
    expect(written).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
  });

  test("tmux: Escape and no Enter", () => {
    expect(tmuxEscapeArgs("/tmp/s", "%1")).toEqual([
      "tmux",
      "-S",
      "/tmp/s",
      "send-keys",
      "-t",
      "%1",
      "Escape",
    ]);
  });

  test("the inbox line carries priority now, after the auth line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-inbox-"));
    dirs.push(dir);
    const path = join(dir, "i.sock");
    let got = "";
    const server = createServer((s) => s.on("data", (d) => (got += d.toString())));
    await new Promise<void>((r) => server.listen(path, r));
    try {
      await postToInbox(path, "tok", STOP_MESSAGE, 2000, "now");
      await Bun.sleep(50);
      const [auth, line] = got
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(auth).toEqual({ type: "auth", token: "tok" });
      expect(line).toEqual({
        type: "user",
        priority: "now",
        message: { role: "user", content: STOP_MESSAGE },
      });
      expect(STOP_MESSAGE).toContain(STOP_TEXT);
      expect(STOP_MESSAGE.startsWith("📱 From the user, sent from their phone via Relay:")).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("migration 8", () => {
  test("a version-7 database gains turns.stopped, and old turns aren't stopped", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mig8-"));
    dirs.push(dir);
    const path = join(dir, "relay.db");
    let db = openDb(path);
    db.query(
      "INSERT INTO turns (id, session_id, summary, started_at, ended_at) VALUES ('t1', 's', 'x', 1, 2)",
    ).run();
    db.exec(
      "ALTER TABLE turns DROP COLUMN messages_json; ALTER TABLE turns DROP COLUMN steps_json; ALTER TABLE turns DROP COLUMN stopped; PRAGMA user_version = 7;",
    );
    db.close();
    db = openDb(path);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      SCHEMA_VERSION,
    );
    expect((db.query("SELECT stopped FROM turns WHERE id = 't1'").get() as { stopped: number }).stopped).toBe(
      0,
    );
    db.close();
  });
});

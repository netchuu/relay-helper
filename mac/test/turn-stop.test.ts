import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  InterruptResult,
  type RelayEvent,
  RelayEvent as RelayEventSchema,
  Turn,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import { type KeyOps, PHONE_PREFIX, STOP_MESSAGE } from "../src/daemon/inject.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { type HookEnv, publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { liveStep, resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";
import { TurnStopper } from "../src/daemon/stop.ts";
import { transcriptTurns } from "../src/daemon/transcript.ts";

/**
 * The phone's Stop, case by case: inputs, the order of routes, the session's state, transcript history,
 * concurrency, push and audit, compatibility, and turns that start right after a stop. Fakes stand in for tmux,
 * relay shell, iTerm2 and the inbox; nothing reaches a real terminal.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLiveSteps();
});

const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

interface Opts {
  inbox?: "ok" | "fails" | "real";
  dbPath?: string;
  repeatMs?: number;
  markerMs?: number;
  config?: Partial<RelayConfig>;
}

function setup(opts: Opts = {}) {
  const dir = tmp("relay-turn-stop-");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(opts.dbPath ?? ":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker: Broker = new Broker(db, events, (id) => {
    const s = registry.get(id);
    if (!s || s.status === "ended") return;
    if (broker.hasOpen(id)) {
      if (s.status !== "waiting") registry.setStatus(id, "waiting");
    } else if (s.status === "waiting") registry.setStatus(id, "working");
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const keys = {
    pty: 0,
    tmux: 0,
    app: 0,
    ptyBadRequest: false,
    routes: [] as ("iterm" | "terminal")[],
    tmuxDelayMs: 0,
  };
  const keyOps: KeyOps = {
    pty: async () => {
      keys.pty++;
      return keys.ptyBadRequest ? { ok: false, reason: "bad_request" } : { ok: true };
    },
    tmux: async () => {
      keys.tmux++;
      if (keys.tmuxDelayMs) await Bun.sleep(keys.tmuxDelayMs);
    },
    routes: () => keys.routes,
    app: async () => {
      keys.app++;
      return true;
    },
    ttyOf: async () => "/dev/ttys009",
  };
  const inboxSent: string[] = [];
  const config = { previewChars: 600, preferTyping: true, ...opts.config } as RelayConfig;
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config,
    keys: keyOps,
    steps,
    ...(opts.inbox === "real"
      ? {}
      : {
          inbox: async (_p: string, _t: string | null, text: string) => {
            if (opts.inbox === "fails") {
              const { DeliveryError } = await import("../src/daemon/inject.ts");
              throw new DeliveryError("session inbox unreachable");
            }
            inboxSent.push(text);
          },
        }),
    timing: {
      graceMs: 5,
      markerMs: opts.markerMs ?? 400,
      inboxMs: 250,
      pollMs: 20,
      repeatMs: opts.repeatMs ?? 2000,
    },
    transcriptPath: () => transcript,
  });
  let localActivity = 0;
  const presence = {
    noteLocalActivity: () => {
      localActivity++;
    },
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper, steps });
  const rpc = createRpc({
    db,
    events,
    registry,
    broker,
    presence,
    config,
    stopper,
    steps,
  } as unknown as RpcDeps);
  const hook = (event: string, sessionId: string, fields: Record<string, unknown> = {}, env: HookEnv = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: sessionId, cwd: dir, ...fields },
        env,
      } as HookEnvelope,
      new AbortController().signal,
    );
  const working = async (id: string, env: HookEnv, prompt = "Rewrite the checkout") => {
    await hook("SessionStart", id, {}, env);
    await hook("UserPromptSubmit", id, { prompt }, env);
  };
  /** Writes the transcript; entries without a timestamp get "now". */
  const tx = (...entries: Record<string, unknown>[]) =>
    writeFileSync(
      transcript,
      `${entries.map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join("\n")}\n`,
    );
  const turnsDone = () => seen.filter((e) => e.type === "turn.done").map((e) => (e as { turn: Turn }).turn);
  const openTurn = (id: string) =>
    db.query("SELECT id, started_at FROM turns WHERE session_id = ? AND ended_at IS NULL").get(id) as {
      id: string;
      started_at: number;
    } | null;
  const keyCount = () => keys.pty + keys.tmux + keys.app;
  return {
    db,
    events,
    registry,
    broker,
    stopper,
    rpc,
    hook,
    working,
    tx,
    keys,
    keyCount,
    inboxSent,
    seen,
    turnsDone,
    openTurn,
    transcript,
    localActivity: () => localActivity,
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
const text = (t: string, at?: number) => ({
  type: "assistant",
  ...(at ? { timestamp: new Date(at).toISOString() } : {}),
  message: { content: [{ type: "text", text: t }] },
});
const marker = (at?: number, t = "[Request interrupted by user]\n") => ({
  type: "user",
  ...(at ? { timestamp: new Date(at).toISOString() } : {}),
  message: { content: [{ type: "text", text: t }] },
});
const errOf = (out: unknown) => (out as { error?: { code: string; message: string } }).error;
const resOf = (out: unknown) => (out as { result: InterruptResult }).result;

describe("inputs", () => {
  test("sessionId missing, null, a number or an object is bad_request, and nothing is sent", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    for (const params of [{}, { sessionId: null }, { sessionId: 7 }, { sessionId: { id: "s1" } }, null]) {
      expect(errOf(await s.rpc("session.interrupt", params, "device:d1"))?.code).toBe("bad_request");
    }
    expect(s.keyCount()).toBe(0);
    expect(s.registry.get("s1")?.status).toBe("working");
  });

  test("an empty or whitespace-only ID is not_found", async () => {
    const s = setup();
    for (const sessionId of ["", "   ", "\n\t"])
      expect(errOf(await s.rpc("session.interrupt", { sessionId }, "d"))?.code).toBe("not_found");
  });

  test("an ID that looks like a shell, tmux or AppleScript command is just an unknown session", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    for (const sessionId of ['$(touch /tmp/pwned) " & quit', "%3; send-keys Enter", "s1\nEnter", "s1 "]) {
      expect(errOf(await s.rpc("session.interrupt", { sessionId }, "d"))?.code).toBe("not_found");
    }
    expect(s.keyCount()).toBe(0);
  });

  test("an unknown extra field doesn't break the call", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.tx(marker());
    const out = await s.rpc("session.interrupt", { sessionId: "s1", force: true, text: "hi" }, "d");
    expect(resOf(out).via).toBe("tmux");
  });

  test("an ended session is not_found, even with a turn still open", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    await s.hook("SessionEnd", "s1", {}, TMUX);
    expect(s.registry.get("s1")?.status).toBe("ended");
    expect(errOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"))?.code).toBe("not_found");
    expect(s.keyCount()).toBe(0);
  });
});

describe("route order", () => {
  test("an open prompt wins over relay shell, tmux and the inbox: no key, no inbox message", async () => {
    const s = setup();
    await s.working("s1", { ...PTY, ...INBOX });
    const reply = s.hook(
      "PermissionRequest",
      "s1",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      PTY,
    );
    const out = await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(resOf(out).via).toBe("prompt");
    expect(JSON.parse((await reply).stdout).hookSpecificOutput.decision).toMatchObject({
      behavior: "deny",
      interrupt: true,
    });
    expect(s.keyCount()).toBe(0);
    expect(s.inboxSent).toEqual([]);
  });

  test("the prompt route works for a session with no key route and no inbox at all", async () => {
    const s = setup();
    await s.working("s1", {});
    const reply = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "ls" } });
    const out = await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(resOf(out)).toEqual({ via: "prompt", turnId: expect.any(String) });
    expect(JSON.parse((await reply).stdout).hookSpecificOutput.decision.interrupt).toBe(true);
    expect(s.registry.get("s1")?.status).toBe("idle");
  });

  test("the stored stop answer never goes on the wire: prompt.closed has outcome Stopped and no 'kind: stop'", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    const reply = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "ls" } });
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await reply;
    const closed = s.seen.filter((e) => e.type === "prompt.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ resolvedBy: "phone", outcome: "Stopped" });
    expect(JSON.stringify(s.seen)).not.toContain('"kind":"stop"');
    for (const e of closed) expect(RelayEventSchema.safeParse(e).success).toBe(true);
  });

  test("pty first: a key request, no text, so nothing reaches tmux", async () => {
    const s = setup();
    await s.working("s1", PTY);
    s.tx(marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).via).toBe("pty");
    expect([s.keys.pty, s.keys.tmux]).toEqual([1, 0]);
  });

  test("an old relay shell (bad_request) falls to tmux; tmux missing too falls to iTerm2", async () => {
    const s = setup();
    await s.working("s1", { pty: "/tmp/pty.sock", ptyToken: "p", claudePid: 4242, termProgram: "iTerm.app" });
    s.keys.ptyBadRequest = true;
    s.keys.routes = ["iterm"];
    s.tx(marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).via).toBe("iterm");
    expect([s.keys.pty, s.keys.tmux, s.keys.app]).toEqual([1, 0, 1]);
  });

  test("preferTyping: false still presses Esc rather than using the inbox", async () => {
    const s = setup({ config: { preferTyping: false } });
    await s.working("s1", { ...TMUX, ...INBOX });
    s.tx(marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).via).toBe("tmux");
    expect(s.inboxSent).toEqual([]);
  });

  test("the inbox message asks Claude to stop and wait, word for word", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(s.inboxSent).toEqual([
      "📱 From the user, sent from their phone via Relay:\nStop what you're doing now and wait for my next message.",
    ]);
    expect(STOP_MESSAGE).toBe(s.inboxSent[0] as string);
  });

  test("held → via message: turnId null, no turn.done, the session keeps working, no session.notice", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    const out = await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(resOf(out)).toEqual({ via: "message", turnId: null });
    expect(s.turnsDone()).toEqual([]);
    expect(s.registry.get("s1")?.status).toBe("working");
    expect(s.openTurn("s1")).not.toBeNull();
    expect(s.seen.some((e) => e.type === "session.notice")).toBe(false);
  });

  test("inbox stop: the stop message's own turn isn't counted as you typing at the computer", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    const before = s.localActivity();
    const pending = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(20);
    await s.hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    expect(resOf(await pending).via).toBe("inbox");
    expect(s.localActivity()).toBe(before);
  });

  test("the stop words typed at the computer without a pending stop are an ordinary prompt", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    await s.hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    await Bun.sleep(30);
    expect(s.turnsDone().some((t) => t.stopped)).toBe(false);
  });

  test("no route at all, and the real inbox client on a socket that isn't there: unavailable", async () => {
    const none = setup();
    await none.working("s1", { claudePid: 4242 });
    expect(errOf(await none.rpc("session.interrupt", { sessionId: "s1" }, "d"))?.code).toBe("unavailable");
    const real = setup({ inbox: "real" });
    const dir = tmp("relay-noinbox-");
    await real.working("s2", { socket: join(dir, "gone.sock"), token: "t", claudePid: 4242 });
    expect(errOf(await real.rpc("session.interrupt", { sessionId: "s2" }, "d"))?.code).toBe("unavailable");
    expect(real.registry.get("s2")?.status).toBe("working");
    expect(real.turnsDone()).toEqual([]);
  });
});

describe("state", () => {
  test("a queued message that started right after the last stop: stopping it waits for its own marker", async () => {
    const s = setup();
    await s.working("s1", TMUX, "first");
    s.tx(text("First answer."), marker());
    const first = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(first.turnId).not.toBeNull();
    await s.hook("UserPromptSubmit", "s1", { prompt: "queued second" }, TMUX);
    const second = s.openTurn("s1");
    const old = JSON.parse(readFileSync(s.transcript, "utf8").trim().split("\n")[1] as string).timestamp;
    s.tx(
      text("First answer.", Date.parse(old) - 10),
      marker(Date.parse(old)),
      {
        type: "user",
        timestamp: new Date((second?.started_at ?? 0) + 5).toISOString(),
        message: { content: "queued second" },
      },
      text("Second answer so far.", (second?.started_at ?? 0) + 50),
    );
    await Bun.sleep(2100); // past the 2 s repeat guard
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.turnId).toBeNull();
    expect(s.registry.get("s1")?.status).toBe("working");
  });

  test("a turn started within a second of the previous answer, stopped at its prompt: its summary is its own", async () => {
    // Tapped after the double-tap window: inside it, a stop of the new turn is refused (see "a double tap…").
    const s = setup({ repeatMs: 100 });
    await s.working("s1", TMUX, "first");
    s.tx({ type: "user", message: { content: "first" } }, text("First answer."), marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).not.toBeNull();
    await s.hook("UserPromptSubmit", "s1", { prompt: "second" }, TMUX);
    const second = s.openTurn("s1");
    const lines = readFileSync(s.transcript, "utf8").trim();
    writeFileSync(
      s.transcript,
      `${lines}\n${JSON.stringify({
        type: "user",
        timestamp: new Date((second?.started_at ?? 0) + 5).toISOString(),
        message: { content: "second" },
      })}\n`,
    );
    const reply = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "ls" } });
    await Bun.sleep(120);
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.via).toBe("prompt");
    expect(JSON.parse((await reply).stdout).hookSpecificOutput.decision.interrupt).toBe(true);
    const stopped = s.turnsDone().find((t) => t.id === out.turnId);
    expect(stopped?.prompt).toBe("second");
    expect(stopped?.summary).toBe("");
    expect(stopped?.stopped).toBe(true);
  });

  test("idle → conflict 'nothing to stop', nothing sent and nothing audited", async () => {
    const s = setup();
    await s.working("s1", { ...TMUX, ...INBOX });
    await s.hook("Stop", "s1", { last_assistant_message: "Done." }, TMUX);
    const err = errOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(err?.code).toBe("conflict");
    expect(err?.message).toContain("nothing to stop");
    expect(s.keyCount()).toBe(0);
    expect(s.inboxSent).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.interrupt'").get()).toEqual({
      n: 0,
    });
  });

  test("waiting with no hook left to answer goes to Esc", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.registry.setStatus("s1", "waiting");
    s.tx(marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).via).toBe("tmux");
  });

  test("the 'for tool use' marker, as plain string content, ends the turn as stopped", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.tx(text("Half way."), {
      type: "user",
      message: { role: "user", content: "[Request interrupted by user for tool use]" },
    });
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.turnId).toBe(s.turnsDone()[0]?.id as string);
    expect(s.turnsDone()[0]).toMatchObject({ stopped: true, failed: false, summary: "Half way." });
  });

  test("Claude Code 2.1.322's real marker entry (promptId, interruptedMessageId) ends the turn, and a message after Stop runs as its own turn", async () => {
    const s = setup();
    await s.working("s1", TMUX, "Write a long essay on lighthouses.");
    const base = Date.now();
    s.tx(
      {
        type: "user",
        promptId: "p1",
        message: { role: "user", content: "Write a long essay on lighthouses." },
        timestamp: new Date(base).toISOString(),
      },
      { ...text("# A Light Against the Dark", base + 100), isSidechain: false },
      {
        type: "user",
        isSidechain: false,
        promptId: "p1",
        interruptedMessageId: "msg_1",
        sessionId: "s1",
        userType: "external",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
        timestamp: new Date(base + 200).toISOString(),
      },
    );
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.turnId).toBe(s.turnsDone()[0]?.id as string);
    expect(s.turnsDone()[0]).toMatchObject({
      stopped: true,
      failed: false,
      summary: "# A Light Against the Dark",
    });
    expect(s.registry.get("s1")?.status).toBe("idle");
    // The next message is a new turn that finishes normally.
    await s.hook("UserPromptSubmit", "s1", { prompt: "Say pineapple." }, TMUX);
    expect(s.registry.get("s1")?.status).toBe("working");
    await s.hook("Stop", "s1", { last_assistant_message: "pineapple" }, TMUX);
    expect(s.turnsDone()).toHaveLength(2);
    expect(s.turnsDone()[1]).toMatchObject({ failed: false, summary: "pineapple" });
    expect(s.turnsDone()[1]?.stopped).toBeFalsy();
    expect(s.registry.get("s1")?.status).toBe("idle");
  });

  test("a long partial answer is clipped like any summary and secrets are redacted", async () => {
    const s = setup({ config: { previewChars: 40 } });
    await s.working("s1", TMUX);
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";
    s.tx(text(`Using key ${secret} and ${"word ".repeat(60)}`), marker());
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    const [turn] = s.turnsDone();
    expect(turn?.truncated).toBe(true);
    expect(turn?.summary.length).toBeLessThanOrEqual(41);
    expect(JSON.stringify(s.seen)).not.toContain(secret);
    expect(JSON.stringify(s.db.query("SELECT full_text, summary FROM turns").all())).not.toContain(secret);
  });

  test("a marker from more than a second before the turn started isn't this turn's: turnId null", async () => {
    const s = setup();
    const start = Date.now();
    s.tx(marker(start - 5000));
    await s.working("s1", TMUX);
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out).toEqual({ via: "tmux", turnId: null });
    expect(s.registry.get("s1")?.status).toBe("working");
  });

  test("no marker within the wait: turnId null, status unchanged, the audit row says turnId null", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.tx(text("Working on it."));
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"))).toEqual({
      via: "tmux",
      turnId: null,
    });
    expect(s.turnsDone()).toEqual([]);
    expect(s.registry.get("s1")?.status).toBe("working");
    const row = s.db.query("SELECT detail FROM audit WHERE action = 'session.interrupt'").get() as {
      detail: string;
    };
    expect(JSON.parse(row.detail)).toEqual({ sessionId: "s1", via: "tmux", turnId: null });
  });

  test("a late Stop or StopFailure adds no second turn and no failed push; the next real turn records as usual", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.tx(text("Partial."), marker());
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await s.hook("Stop", "s1", { last_assistant_message: "Partial." }, TMUX);
    await s.hook("StopFailure", "s1", { last_assistant_message: "" }, TMUX);
    expect(s.turnsDone()).toHaveLength(1);
    expect(s.db.query("SELECT COUNT(*) AS n FROM turns WHERE session_id = 's1'").get()).toEqual({ n: 1 });
    expect(s.db.query("SELECT COUNT(*) AS n FROM turns WHERE failed = 1").get()).toEqual({ n: 0 });
    await s.hook("UserPromptSubmit", "s1", { prompt: "carry on" }, TMUX);
    await s.hook("Stop", "s1", { last_assistant_message: "All done." }, TMUX);
    const done = s.turnsDone();
    expect(done).toHaveLength(2);
    expect(done[1]).toMatchObject({ prompt: "carry on", summary: "All done.", failed: false });
    expect("stopped" in (done[1] as Turn)).toBe(false);
  });

  test("Esc at the computer: one sweep ends it as stopped, a second sweep announces nothing more", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.tx(text("Partial."), marker());
    s.registry.setStatus("s1", "idle"); // what reconcile does once claude agents says idle
    s.stopper.sweep();
    s.stopper.sweep();
    const done = s.turnsDone();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ stopped: true, summary: "Partial." });
    expect(s.keyCount()).toBe(0);
    expect(s.db.query("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.interrupt'").get()).toEqual({
      n: 0,
    });
  });

  test("Esc at the computer: a sweep ignores a marker from an earlier turn", async () => {
    const s = setup();
    s.tx(marker(Date.now() - 60_000));
    await s.working("s1", TMUX);
    s.registry.setStatus("s1", "idle");
    s.stopper.sweep();
    expect(s.turnsDone()).toEqual([]);
    expect(s.openTurn("s1")).not.toBeNull();
  });

  test("after a restart the stopped turn still says stopped in session.turns", async () => {
    const dir = tmp("relay-stop-restart-");
    const dbPath = join(dir, "relay.db");
    const a = setup({ dbPath });
    await a.working("s1", TMUX);
    a.tx(text("Partial."), marker());
    const { turnId } = resOf(await a.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    a.db.close();
    const b = setup({ dbPath });
    const turns = (await b.rpc("session.turns", { sessionId: "s1", limit: 10 }, "d")) as { result: Turn[] };
    expect(turns.result.find((t) => t.id === turnId)).toMatchObject({ stopped: true, failed: false });
    expect(b.registry.get("s1")?.status).toBe("idle");
    // A stop after the restart (nothing in flight, no repeat guard in memory) is a plain conflict.
    expect(errOf(await b.rpc("session.interrupt", { sessionId: "s1" }, "d"))?.code).toBe("conflict");
  });

  test("Turn.stopped is only ever sent as true: absent on normal and failed turns, in events and session.turns", async () => {
    const s = setup();
    await s.working("s1", TMUX, "one");
    await s.hook("Stop", "s1", { last_assistant_message: "ok" }, TMUX);
    await s.working("s1", TMUX, "two");
    await s.hook("StopFailure", "s1", { last_assistant_message: "API error" }, TMUX);
    await s.hook("UserPromptSubmit", "s1", { prompt: "three" }, TMUX);
    s.tx(text("Partial."), marker());
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    const turns = ((await s.rpc("session.turns", { sessionId: "s1", limit: 10 }, "d")) as { result: Turn[] })
      .result;
    for (const list of [s.turnsDone(), turns]) {
      expect(list).toHaveLength(3);
      for (const t of list) {
        if (t.prompt === "three") expect(t).toMatchObject({ stopped: true, failed: false });
        else expect("stopped" in t).toBe(false);
        expect(Turn.safeParse(t).success).toBe(true);
      }
    }
    expect(JSON.stringify(s.seen)).not.toContain('"stopped":false');
  });

  test("a stopped turn clears its live step and keeps its steps; no 'Thinking' arrives after the stop", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    await s.hook(
      "PreToolUse",
      "s1",
      { tool_name: "Bash", tool_use_id: "tu1", tool_input: { command: "npm test" } },
      TMUX,
    );
    expect(liveStep("s1")).not.toBeNull();
    s.tx(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] },
      },
      marker(),
    );
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(liveStep("s1")).toBeNull();
    const session = s.registry.get("s1");
    expect(session ? (publicSession(session).step ?? null) : null).toBeNull();
    const [turn] = s.turnsDone();
    expect(turn?.steps?.length ?? 0).toBeGreaterThan(0);
    const stepsAfter = s.seen.length;
    await Bun.sleep(80); // past the tracker's 30 ms "Thinking" delay
    expect(s.seen.slice(stepsAfter).filter((e) => e.type === "turn.step")).toEqual([]);
  });
});

describe("transcript history", () => {
  const history = (lines: Record<string, unknown>[]) => {
    const path = join(tmp("relay-turn-stop-tx-"), "s.jsonl");
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return transcriptTurns("s", path, { limit: 20, previewChars: 600, working: false });
  };
  const at = (sec: number) => `2026-11-04T10:00:${String(sec).padStart(2, "0")}Z`;

  test("no form of the marker shows as a message, wherever it is", () => {
    const turns = history([
      { type: "user", timestamp: at(0), message: { content: "[Request interrupted by user]" } },
      { type: "user", timestamp: at(1), message: { content: "first" } },
      { type: "assistant", timestamp: at(2), message: { content: [{ type: "text", text: "a" }] } },
      {
        type: "user",
        timestamp: at(3),
        message: { content: "  [Request interrupted by user for tool use]\n" },
      },
      {
        type: "user",
        timestamp: at(4),
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      },
      { type: "user", timestamp: at(10), message: { content: "second" } },
      {
        type: "user",
        timestamp: at(11),
        message: { content: [{ type: "text", text: "[Request interrupted by user]\n" }] },
      },
    ]);
    const prompts = turns.map((t) => t.prompt ?? "");
    expect(prompts.some((p) => p.includes("[Request interrupted"))).toBe(false);
    expect(turns.map((t) => [t.prompt, t.stopped ?? false])).toEqual([
      ["second", true],
      ["first", true],
    ]);
  });

  test("a turn that wasn't interrupted has no stopped field", () => {
    const turns = history([
      { type: "user", timestamp: at(1), message: { content: "hello" } },
      { type: "assistant", timestamp: at(2), message: { content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(turns).toHaveLength(1);
    expect("stopped" in (turns[0] as Turn)).toBe(false);
  });
});

describe("concurrency", () => {
  test("two phones at once through tmux: one Esc, the same answer, one audit row", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.keys.tmuxDelayMs = 30;
    const a = s.rpc("session.interrupt", { sessionId: "s1" }, "device:a");
    const b = s.rpc("session.interrupt", { sessionId: "s1" }, "device:b");
    await Bun.sleep(50);
    s.tx(marker());
    const [ra, rb] = await Promise.all([a, b]);
    expect(resOf(ra)).toEqual(resOf(rb));
    expect(resOf(ra).turnId).not.toBeNull();
    expect(s.keys.tmux).toBe(1);
    expect(s.turnsDone()).toHaveLength(1);
    expect(s.db.query("SELECT COUNT(*) AS n FROM audit WHERE action = 'session.interrupt'").get()).toEqual({
      n: 1,
    });
  });

  test("two phones at once on an open prompt: the hook is answered once, the same answer for both", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    const reply = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "ls" } });
    const [ra, rb] = await Promise.all([
      s.rpc("session.interrupt", { sessionId: "s1" }, "device:a"),
      s.rpc("session.interrupt", { sessionId: "s1" }, "device:b"),
    ]);
    expect(resOf(ra)).toEqual(resOf(rb));
    expect(resOf(ra).via).toBe("prompt");
    await reply;
    expect(s.seen.filter((e) => e.type === "prompt.closed")).toHaveLength(1);
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("two phones at once through the inbox: one stop message", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    const [ra, rb] = await Promise.all([
      s.rpc("session.interrupt", { sessionId: "s1" }, "device:a"),
      s.rpc("session.interrupt", { sessionId: "s1" }, "device:b"),
    ]);
    expect(resOf(ra)).toEqual(resOf(rb));
    expect(s.inboxSent).toHaveLength(1);
  });

  test("a double tap after an Esc that didn't show: no second Esc within the guard, one after it", async () => {
    const s = setup({ repeatMs: 300, markerMs: 60 });
    await s.working("s1", TMUX);
    const first = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    const again = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(again).toEqual(first);
    expect(s.keys.tmux).toBe(1);
    await Bun.sleep(320);
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(s.keys.tmux).toBe(2);
  });

  test("the turn.done event is out before the reply, with the reply's turnId", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    s.tx(marker());
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    const done = s.turnsDone();
    expect(done).toHaveLength(1);
    expect(done[0]?.id).toBe(out.turnId as string);
    const upsert = s.seen.filter((e) => e.type === "session.upsert").at(-1) as {
      session: { status: string };
    };
    expect(upsert.session.status).toBe("idle");
  });
});

describe("push, audit and privacy", () => {
  test("nothing a stop emits makes a push", async () => {
    const s = setup();
    await s.working("s1", INBOX);
    const reply = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "ls" } });
    const from = s.seen.length;
    await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await reply;
    const emitted = s.seen.slice(from);
    expect(emitted.length).toBeGreaterThan(0);
    for (const e of emitted) expect(alertFor(e, () => "web-shop")).toBeNull();
  });

  test("a failed turn from a real StopFailure hook pushes '<name> failed'", async () => {
    const s = setup();
    await s.working("s1", TMUX);
    await s.hook("StopFailure", "s1", { last_assistant_message: "API Error: 500" }, TMUX);
    const done = s.seen.find((e) => e.type === "turn.done") as RelayEvent;
    expect(alertFor(done, () => "web-shop")?.title).toBe("web-shop failed");
  });

  test("the audit table holds the route and IDs and none of the text", async () => {
    const s = setup();
    await s.working("s1", INBOX, "Rewrite the checkout with the secret plan");
    s.tx(text("Claude's partial words."));
    const reply = s.hook("PermissionRequest", "s1", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    await s.rpc("session.interrupt", { sessionId: "s1" }, "device:d1");
    await reply;
    await s.working("s2", INBOX, "Another prompt");
    const pending = s.rpc("session.interrupt", { sessionId: "s2" }, "device:d1");
    await Bun.sleep(20);
    await s.hook("UserPromptSubmit", "s2", { prompt: STOP_MESSAGE }, INBOX);
    await pending;
    const rows = s.db.query("SELECT action, detail FROM audit").all() as { action: string; detail: string }[];
    const stops = rows.filter((r) => r.action === "session.interrupt").map((r) => JSON.parse(r.detail));
    expect(stops.map((d) => Object.keys(d).sort())).toEqual([
      ["sessionId", "turnId", "via"],
      ["sessionId", "turnId", "via"],
    ]);
    expect(stops.map((d) => d.via)).toEqual(["prompt", "inbox"]);
    const all = JSON.stringify(rows);
    for (const words of [
      "secret plan",
      "partial words",
      "rm -rf",
      "Stop what you",
      "stopped this from",
      "Another prompt",
    ])
      expect(all).not.toContain(words);
  });
});

describe("compatibility", () => {
  const fixtures = resolve(import.meta.dir, "../../protocol/fixtures");

  test("frames.json: the interrupt reply and the stopped turn.done parse, and no fixture sends stopped: false", () => {
    const frames = JSON.parse(readFileSync(join(fixtures, "frames.json"), "utf8")) as Record<
      string,
      unknown
    >[];
    const reply = frames.find((f) => f.type === "rpc" && f.id === 6) as { result: unknown };
    expect(InterruptResult.parse(reply.result)).toEqual({ via: "tmux", turnId: "t_stop" });
    const stopped = frames
      .filter((f) => f.type === "event")
      .map((f) => f.event as { type: string; turn?: Turn })
      .find((e) => e.type === "turn.done" && e.turn?.id === "t_stop");
    expect(stopped?.turn).toMatchObject({ stopped: true, failed: false });
    for (const name of ["frames.json", "events.json", "sync.json", "turns.json"])
      expect(readFileSync(join(fixtures, name), "utf8")).not.toMatch(/"stopped":\s*false/);
  });

  test("the database has turns.stopped NOT NULL DEFAULT 0, whatever the schema version is now", () => {
    const db = openDb(":memory:");
    const col = (
      db.query("PRAGMA table_info(turns)").all() as { name: string; notnull: number; dflt_value: string }[]
    ).find((c) => c.name === "stopped");
    expect(col).toMatchObject({ notnull: 1, dflt_value: "0" });
    expect(
      (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBeGreaterThanOrEqual(8);
  });
});
describe("turns that start right after a stop", () => {
  /** Turn A stopped through tmux with its marker; turn B (prompt `second`) starts at once, before its entry is written. */
  const queuedAfterStop = async (firstPrompt: string, second: string) => {
    const s = setup({ repeatMs: 100, markerMs: 300 });
    await s.working("s1", TMUX, firstPrompt);
    s.tx({ type: "user", message: { content: firstPrompt } }, text("First answer."), marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).not.toBeNull();
    await s.hook("UserPromptSubmit", "s1", { prompt: second }, TMUX);
    await Bun.sleep(120); // past the repeat guard
    return s;
  };

  test("a queued turn whose prompt entry isn't written yet doesn't take the previous turn's marker", async () => {
    const s = await queuedAfterStop("first", "queued second");
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.turnId).toBeNull();
    expect(s.registry.get("s1")?.status).toBe("working");
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("the inbox stop's own turn, stopped again after the double-tap window: its own text, and the first turn isn't announced twice", async () => {
    // Inside the 2 s window a second tap is a double tap and gets conflict (the next test file block covers it).
    const s = setup({ repeatMs: 100 });
    await s.working("s1", INBOX, "Rewrite the checkout");
    const t0 = Date.now();
    s.tx(
      { type: "user", message: { content: "Rewrite the checkout" } },
      text("Starting with the cart.", t0 + 5),
    );
    const first = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(20);
    await s.hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    expect(resOf(await first).via).toBe("inbox");
    const c = Date.now();
    const lines = readFileSync(s.transcript, "utf8").trim();
    writeFileSync(
      s.transcript,
      `${lines}\n${[
        { type: "user", timestamp: new Date(c).toISOString(), message: { content: STOP_MESSAGE } },
        text("I've stopped. What next?", c + 10),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    await Bun.sleep(120); // past the double-tap window
    const second = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(30);
    await s.hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    const out = resOf(await second);
    expect(out.via).toBe("inbox");
    const done = s.turnsDone();
    expect(done.map((t) => t.summary)).toEqual(["Starting with the cart.", "I've stopped. What next?"]);
    expect(done.every((t) => t.stopped)).toBe(true);
  });

  test("the same prompt twice ('continue'), the second's entry not written yet: still not the previous turn's", async () => {
    const s = await queuedAfterStop("continue", "continue");
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.turnId).toBeNull();
    expect(s.registry.get("s1")?.status).toBe("working");
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("the queued turn's entry and marker arrive during the wait: it ends stopped with its own text", async () => {
    const s = await queuedAfterStop("continue", "continue");
    const pending = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(60);
    const lines = readFileSync(s.transcript, "utf8").trim();
    const now = Date.now();
    writeFileSync(
      s.transcript,
      `${lines}\n${[
        { type: "user", timestamp: new Date(now).toISOString(), message: { content: "continue" } },
        text("Second answer so far.", now + 10),
        marker(now + 20),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    const out = resOf(await pending);
    const stopped = s.turnsDone().find((t) => t.id === out.turnId);
    expect(stopped).toMatchObject({ stopped: true, summary: "Second answer so far." });
  });

  test("two messages from the phone in a row (both start with the phone's line): the second isn't anchored on the first", async () => {
    const first = `${PHONE_PREFIX}\nfix the cart`;
    const second = `${PHONE_PREFIX}\nand the tests`;
    const s = await queuedAfterStop(first, second);
    const out = resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"));
    expect(out.turnId).toBeNull();
    expect(s.registry.get("s1")?.status).toBe("working");
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("the same phone message twice: the second's own entry and marker, once written, stop it with its own text", async () => {
    const msg = `${PHONE_PREFIX}\ncontinue`;
    const s = await queuedAfterStop(msg, msg);
    const pending = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(60);
    const lines = readFileSync(s.transcript, "utf8").trim();
    const now = Date.now();
    writeFileSync(
      s.transcript,
      `${lines}\n${[
        {
          type: "user",
          isMeta: true,
          timestamp: new Date(now).toISOString(),
          message: { content: `Another Claude session sent a message:\n${msg}` },
        },
        text("Continuing with the tests.", now + 10),
        marker(now + 20),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    const out = resOf(await pending);
    expect(s.turnsDone().find((t) => t.id === out.turnId)).toMatchObject({
      stopped: true,
      summary: "Continuing with the tests.",
    });
  });

  test("a double tap whose first Esc submitted a queued message: the stopped turn ended, so conflict and no second Esc", async () => {
    const s = setup();
    await s.working("s1", TMUX, "first");
    s.tx(text("First answer."), marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).not.toBeNull();
    await s.hook("UserPromptSubmit", "s1", { prompt: "queued second" }, TMUX);
    const again = await s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    expect(errOf(again)?.code).toBe("conflict");
    expect(s.keys.tmux).toBe(1);
  });

  test("a double tap after a prompt-route stop: conflict, nothing answered, no key", async () => {
    const s = setup();
    await s.working("s1", TMUX, "first");
    const reply = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).via).toBe("prompt");
    await reply;
    await s.hook("UserPromptSubmit", "s1", { prompt: "next" }, TMUX);
    const next = s.hook("PermissionRequest", "s1", { tool_name: "Bash", tool_input: { command: "pwd" } });
    expect(errOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"))?.code).toBe("conflict");
    expect(s.keys.tmux).toBe(0);
    expect(s.broker.hasOpen("s1")).toBe(true);
    s.broker.settleFromSessionEvent("s1", { hookEventName: "SessionEnd" });
    expect((await next).stdout).toBe("");
  });
});

describe("prompts that look alike, and the edge of the double-tap window", () => {
  /** Turn A (`firstPrompt`) stopped through tmux with its marker; turn B (`second`) starts at once. */
  const queued = async (firstPrompt: string, second: string) => {
    const s = setup({ repeatMs: 100, markerMs: 300 });
    await s.working("s1", TMUX, firstPrompt);
    s.tx({ type: "user", message: { content: firstPrompt } }, text("First answer."), marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).not.toBeNull();
    await Bun.sleep(5);
    await s.hook("UserPromptSubmit", "s1", { prompt: second }, TMUX);
    await Bun.sleep(120); // past the double-tap window
    return s;
  };
  /** Appends B's own prompt entry (as `entryText`), its text and its marker while the stop waits. */
  const stopWithOwnEntry = async (s: Awaited<ReturnType<typeof queued>>, entryText: string) => {
    const pending = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(60);
    const lines = readFileSync(s.transcript, "utf8").trim();
    const now = Date.now();
    writeFileSync(
      s.transcript,
      `${lines}\n${[
        { type: "user", timestamp: new Date(now).toISOString(), message: { content: entryText } },
        text("Second answer so far.", now + 10),
        marker(now + 20),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
    return resOf(await pending);
  };

  test("a prompt that is a prefix of the previous one, its entry not written yet: not the previous turn's", async () => {
    const s = await queued("continue with the tests", "continue");
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).toBeNull();
    expect(s.registry.get("s1")?.status).toBe("working");
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("a prompt that is a prefix of the previous one: once its entry and marker are written, its own text", async () => {
    const s = await queued("continue with the tests", "continue");
    const out = await stopWithOwnEntry(s, "continue");
    expect(s.turnsDone().find((t) => t.id === out.turnId)).toMatchObject({
      prompt: "continue",
      stopped: true,
      summary: "Second answer so far.",
    });
    expect(s.turnsDone()).toHaveLength(2);
  });

  test("a prompt that extends the previous one: its own text", async () => {
    const s = await queued("continue", "continue with the tests");
    const out = await stopWithOwnEntry(s, "continue with the tests");
    expect(s.turnsDone().find((t) => t.id === out.turnId)).toMatchObject({
      summary: "Second answer so far.",
    });
  });

  test("a phone message whose text is Claude Code's peer header: not the previous turn's, then its own text", async () => {
    const header = "Another Claude session sent a message:";
    const msg = `${PHONE_PREFIX}\n${header}`;
    const s = await queued(`${PHONE_PREFIX}\nfix the cart`, msg);
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).toBeNull();
    expect(s.turnsDone()).toHaveLength(1);
    await Bun.sleep(120);
    const out = await stopWithOwnEntry(s, `${header}\n${msg}`);
    expect(s.turnsDone().find((t) => t.id === out.turnId)).toMatchObject({
      stopped: true,
      summary: "Second answer so far.",
    });
  });

  test("a phone message that is only the peer header, typed: not the previous turn's", async () => {
    const s = await queued("first", "Another Claude session sent a message:");
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).toBeNull();
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("a double tap after an inbox stop: the stop message's own turn isn't stopped, one inbox message", async () => {
    const s = setup();
    await s.working("s1", INBOX, "Rewrite the checkout");
    const first = s.rpc("session.interrupt", { sessionId: "s1" }, "d");
    await Bun.sleep(20);
    await s.hook("UserPromptSubmit", "s1", { prompt: STOP_MESSAGE }, INBOX);
    expect(resOf(await first).via).toBe("inbox");
    expect(s.registry.get("s1")?.status).toBe("working");
    expect(errOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d"))?.code).toBe("conflict");
    expect(s.inboxSent).toHaveLength(1);
    expect(s.turnsDone()).toHaveLength(1);
  });

  test("a tap 1 ms inside the 2 s window after the first stop is conflict; 1 ms after it, a new stop", async () => {
    const s = setup({ markerMs: 200 });
    await s.working("s1", TMUX, "first");
    s.tx({ type: "user", message: { content: "first" } }, text("First answer."), marker());
    expect(resOf(await s.rpc("session.interrupt", { sessionId: "s1" }, "d")).turnId).not.toBeNull();
    await Bun.sleep(5);
    await s.hook("UserPromptSubmit", "s1", { prompt: "queued second" }, TMUX);
    const at = (s.stopper as unknown as { lastEsc: Map<string, { at: number }> }).lastEsc.get("s1")?.at ?? 0;
    // Only the guard's own check reads the clock at the moved time; it runs before interrupt() returns.
    const tapAt = (ms: number) => {
      setSystemTime(new Date(at + ms));
      try {
        return { result: s.stopper.interrupt("s1", "d"), error: null as Error | null };
      } catch (err) {
        return { result: null, error: err as Error };
      } finally {
        setSystemTime();
      }
    };
    const inside = tapAt(1999);
    expect(inside.error?.message).toContain("nothing to stop");
    expect(s.keys.tmux).toBe(1);
    const after = tapAt(2001);
    expect(after.error).toBeNull();
    expect((await after.result)?.via).toBe("tmux");
    expect(s.keys.tmux).toBe(2);
  });
});

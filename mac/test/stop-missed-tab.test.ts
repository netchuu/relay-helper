import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import { clearDraftKept, deliver, type KeyOps, notePutBack, type TypeOps } from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { StopError, TurnStopper } from "../src/daemon/stop.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RULE = "─".repeat(100);
const screenOf = (prompt: string) => ["⏺ …", RULE, `❯ ${prompt}`, RULE, "  ⏵⏵ bypass"].join("\n");

const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };

/** A working iTerm2 session whose own tab is gone (`known` are the tabs that exist) and a viewer tab. */
async function setup(known: string[], shown: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "relay-missed-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events, () => {});
  const config = { previewChars: 600 } as RelayConfig;
  const pressed: string[] = [];
  const keys: KeyOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: async () => "/dev/ttys010",
    viewerTtyOf: async () => "/dev/ttys014",
    inFront: async () => true,
    peek: async (_r, tty) =>
      known.includes(tty) ? { front: true, screen: shown === null ? "⏺ working…" : screenOf(shown) } : null,
    app: async (_r, tty) => {
      if (!known.includes(tty)) return false;
      pressed.push(tty);
      return true;
    },
  };
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config,
    keys,
    timing: { graceMs: 5, markerMs: 100, inboxMs: 50, pollMs: 10, repeatMs: 2000 },
    transcriptPath: () => transcript,
  });
  const presence = { noteLocalActivity: () => {}, get: () => ({ present: false }) } as never;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: "s1", cwd: dir, ...fields },
        env: ITERM,
      } as HookEnvelope,
      new AbortController().signal,
    );
  await hook("SessionStart");
  await hook("UserPromptSubmit", { prompt: "Check the database and fix entries" });
  return { stopper, pressed, registry };
}

test("Stop: Esc that lands in no tab of the session is an error, not a stop", async () => {
  // Only the viewer tab exists, and it never shows an interrupt marker.
  const { stopper, pressed, registry } = await setup(["/dev/ttys099"]);
  const err = await stopper.interrupt("s1", "d").catch((e) => e);
  expect(err).toBeInstanceOf(StopError);
  expect((err as StopError).code).toBe("unavailable");
  expect(pressed).toEqual([]);
  expect(registry.get("s1")?.status).toBe("working");
});

test("Stop: a miss on the first tab, the next tab takes Esc, the prompt is back: the turn ends as stopped", async () => {
  const { stopper, pressed, registry } = await setup(["/dev/ttys014"], "Check the database and fix entries");
  const result = await stopper.interrupt("s1", "d");
  expect(result.via).toBe("iterm");
  expect(pressed).toEqual(["/dev/ttys014"]);
  expect(registry.get("s1")?.status).toBe("idle");
  clearDraftKept("s1");
});

test("Stop: no marker and no prompt back on the tab: the turn keeps working", async () => {
  const { stopper, registry } = await setup(["/dev/ttys014"]);
  const result = await stopper.interrupt("s1", "d");
  expect(result.turnId).toBeNull();
  expect(registry.get("s1")?.status).toBe("working");
});

test("Stop, then a send with no marker in the transcript: only the second text is typed", async () => {
  const { stopper, registry } = await setup(["/dev/ttys014"], "Check the database and fix entries");
  await stopper.interrupt("s1", "d");
  const { ops, log } = tab("Check the database and fix entries");
  await deliver(registry.get("s1") as SessionRecord, "Now it works.", send, ops);
  expect(log).toEqual(["clear", "type:Now it works."]);
  clearDraftKept("s1");
});

/** A plain-text tab: Claude Code put the stopped prompt back, and the screen can't tell it from a suggestion. */
function tab(initial: string) {
  const log: string[] = [];
  let prompt = initial;
  const ops: TypeOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: async () => "/dev/ttys004",
    peek: async () => ({ front: false, screen: screenOf(prompt) }),
    inFront: async () => true,
    noKeySincePrompt: () => true,
    sleep: async () => {},
    stash: async () => {
      log.push("stash");
      prompt = "";
      return true;
    },
    clear: async () => {
      log.push("clear");
      prompt = "";
      return true;
    },
    type: async (_r, _t, text) => {
      log.push(`type:${prompt}${text}`);
      return true;
    },
  };
  return { ops, log };
}

const session = { id: "p1", pid: 4242, terminal: "iTerm.app" } as unknown as SessionRecord;
const send = { idleSeconds: null, userTypingNow: false, preferTyping: true } as const;

test("a prompt Claude Code put back after Stop is set aside, not typed into", async () => {
  const { ops, log } = tab("It works now. Can you check the database?");
  notePutBack("p1", "It works now. Can you check the database?");
  await deliver(session, "Now it works.", send, ops);
  expect(log).toEqual(["clear", "type:Now it works."]);
  clearDraftKept("p1");
});

test("after the put-back prompt is cleared, the next message finds an empty box", async () => {
  const { ops, log } = tab("It works now.");
  notePutBack("p3", "It works now.");
  await deliver({ ...session, id: "p3" } as SessionRecord, "One.", send, ops);
  await deliver({ ...session, id: "p3" } as SessionRecord, "Two.", send, ops);
  expect(log).toEqual(["clear", "type:One.", "type:Two."]);
  clearDraftKept("p3");
});

test("a draft the person typed is stashed, not cleared", async () => {
  const { ops, log } = tab("my own draft");
  ops.noKeySincePrompt = () => false;
  await deliver({ ...session, id: "p4" } as SessionRecord, "Hi.", send, ops);
  expect(log).toEqual(["stash", "type:Hi."]);
  clearDraftKept("p4");
});

test("the put-back prompt sent again as it is: no second copy typed", async () => {
  const { ops, log } = tab("It works now.");
  let entered = 0;
  ops.enter = async () => {
    entered++;
    return true;
  };
  notePutBack("p2", "It works now.");
  await deliver({ ...session, id: "p2" } as SessionRecord, "It works now.", send, ops);
  expect({ log, entered }).toEqual({ log: [], entered: 1 });
  clearDraftKept("p2");
});

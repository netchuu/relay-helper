import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import { clearDraftKept, deliver, type KeyOps, type TypeOps } from "../src/daemon/inject.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { TurnStopper } from "../src/daemon/stop.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearDraftKept("s1");
});

const RULE = "─".repeat(100);
const screenOf = (prompt: string) => ["⏺ …", RULE, `❯ ${prompt}`, RULE, "  ⏵⏵ bypass"].join("\n");
const PROMPT = "Check the database and fix entries";
const send = { idleSeconds: null, userTypingNow: false, preferTyping: true } as const;
const TMUX: HookEnv = { tmux: "/tmp/tmux.sock,1,0", tmuxPane: "%1", claudePid: 4242 };

/** A working session in tmux; the pane shows `shown` after Esc (an empty transcript: no interrupt marker). */
async function setup(shown: string) {
  const dir = mkdtempSync(join(tmpdir(), "relay-putback-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events, () => {});
  const config = { previewChars: 600 } as RelayConfig;
  const keys: KeyOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmux: async () => {},
    tmuxScreen: async () => screenOf(shown),
    tmuxPaneTty: async () => "/dev/ttys010",
    routes: () => [],
    ttyOf: async () => "/dev/ttys010",
    inFront: async () => true,
    app: async () => false,
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
        env: TMUX,
      } as HookEnvelope,
      new AbortController().signal,
    );
  await hook("SessionStart");
  await hook("UserPromptSubmit", { prompt: PROMPT });
  return { stopper, registry };
}

test("Stop in tmux right after sending: the prompt is back, so the turn is stopped", async () => {
  const { stopper, registry } = await setup(PROMPT);
  const result = await stopper.interrupt("s1", "d");
  expect(result.via).toBe("tmux");
  expect(registry.get("s1")?.status).toBe("idle");
});

test("Stop in tmux with no prompt back and no marker: the turn keeps working", async () => {
  const { stopper, registry } = await setup("");
  await stopper.interrupt("s1", "d");
  expect(registry.get("s1")?.status).toBe("working");
});

test("after Stop in tmux, the put-back prompt is cleared with Ctrl+C, not stashed", async () => {
  const { stopper, registry } = await setup(PROMPT);
  await stopper.interrupt("s1", "d");
  const log: string[] = [];
  let prompt = PROMPT;
  const ops: TypeOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmuxScreen: async () => screenOf(prompt),
    tmux: async (_s, _p, text) => void log.push(`type:${prompt}${text}`),
    tmuxPaneTty: async () => "/dev/ttys010",
    tmuxStash: async () => {
      log.push("stash");
      prompt = "";
    },
    tmuxClear: async () => {
      log.push("clear");
      prompt = "";
    },
    routes: () => [],
    ttyOf: async () => "/dev/ttys010",
    peek: async () => null,
    type: async () => false,
    inFront: async () => true,
    sleep: async () => {},
  };
  await deliver(registry.get("s1") as SessionRecord, "Now it works.", send, ops);
  expect(log).toEqual(["clear", "type:Now it works."]);
});

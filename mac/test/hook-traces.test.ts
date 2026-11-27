import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler, notePhoneTyped } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

// Shapes as Claude Code 2.1.332 writes them when a UserPromptSubmit hook blocks a prompt or exits with an error.

const dirs: string[] = [];
afterEach(() => {
  resetLiveSteps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let setups = 0;

function setup() {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = {
    noteLocalActivity() {},
    get: () => ({ mode: "auto", away: false }),
  } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  hooks.commandGraceMs = 0;
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const dir = mkdtempSync(join(tmpdir(), "relay-hook-traces-"));
  dirs.push(dir);
  const transcript = join(dir, "session.jsonl");
  const lines: string[] = [];
  const id = ++setups;
  const sid = `s-traces-${id}`;
  let n = 0;
  const write = (entry: Record<string, unknown>) => {
    n += 1;
    lines.push(
      JSON.stringify({ uuid: `u${id}-${n}`, timestamp: new Date(1_000_000 + n).toISOString(), ...entry }),
    );
    writeFileSync(transcript, `${lines.join("\n")}\n`);
  };
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: {
          hook_event_name: event,
          session_id: sid,
          cwd: "/tmp/hook-traces",
          transcript_path: transcript,
          ...fields,
        },
        env: {},
      },
      new AbortController().signal,
    );
  return {
    sid,
    scan: () => hooks.scanCommands(sid, transcript),
    scanPending: () => {
      for (const id of hooks.pendingSlashSessions()) hooks.scanCommands(id, id === sid ? transcript : null);
    },
    hook,
    hooks,
    seen,
    registry,
    block: (reason: string, prompt: string) =>
      write({
        type: "system",
        subtype: "informational",
        level: "warning",
        content: `UserPromptSubmit operation blocked by hook:\n${reason}\n\nOriginal prompt: ${prompt}`,
        promptSubmitEnding: { ending: { kind: "blocked_by_hook", reason }, promptKept: false },
      }),
    hookError: (event: string, stderr: string, command = "/usr/local/bin/lint.sh") =>
      write({
        type: "attachment",
        attachment: { type: "hook_non_blocking_error", hookEvent: event, stderr, exitCode: 1, command },
      }),
    outcomes: () => seen.flatMap((e) => (e.type === "reply.outcome" ? [e] : [])),
    notices: () => seen.flatMap((e) => (e.type === "session.notice" ? [e] : [])),
  };
}

describe("hook blocks and errors", () => {
  test("a blocked phone message gets the outcome blocked with the hook's reason", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped(t.sid, "my password is hunter2", false, "send-1");
    t.block("no secrets in prompts", "my password is hunter2");
    t.scan();

    expect(t.outcomes()).toMatchObject([
      {
        sessionId: t.sid,
        sendId: "send-1",
        outcome: "blocked",
        text: "A hook on your computer blocked this message: no secrets in prompts",
      },
    ]);
    expect(t.seen.some((e) => e.type === "turn.started")).toBe(false);
    t.scan();
    expect(t.outcomes()).toHaveLength(1);
  });

  test("a block after the helper's own hook began the turn ends that turn", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped(t.sid, "deploy it", false, "send-2");
    await t.hook("UserPromptSubmit", { prompt: "deploy it" });
    t.block("not on Fridays", "deploy it");
    t.scan();

    expect(t.outcomes()).toMatchObject([{ sendId: "send-2", outcome: "blocked" }]);
    const done = t.seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : []));
    expect(done).toMatchObject([{ summary: "A hook on your computer blocked this message: not on Fridays" }]);
    expect(t.registry.get(t.sid)?.status).toBe("idle");
  });

  test("a block with no reason still says a hook blocked it", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped(t.sid, "hello", false, "send-3");
    t.block("", "hello");
    t.scan();
    expect(t.outcomes()[0]?.text).toBe("A hook on your computer blocked this message.");
  });

  test("a hook error line becomes an error notice", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.scan();
    t.hookError("PreToolUse", "Failed with non-blocking status code: lint crashed");
    t.scan();
    expect(t.notices()).toMatchObject([{ level: "error", text: "PreToolUse hook error: lint crashed" }]);
  });

  test("the helper's own hook failing is not reported", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.scan();
    t.hookError("Stop", "Failed with non-blocking status code: x", "/Users/a/.relay/bin/relay-hook");
    t.scan();
    expect(t.notices()).toEqual([]);
  });

  test("the block is found through the session watch list after the helper's hook dropped the phone's entry", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped(t.sid, "deploy it", false, "send-4");
    await t.hook("UserPromptSubmit", { prompt: "deploy it" });
    t.block("not on Fridays", "deploy it");
    t.scanPending();
    expect(t.outcomes()).toMatchObject([{ sendId: "send-4", outcome: "blocked" }]);
  });

  test("a finished turn leaves the watch list", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped(t.sid, "hello there", false, "send-5");
    await t.hook("UserPromptSubmit", { prompt: "hello there" });
    expect(t.hooks.pendingSlashSessions()).toContain(t.sid);
    await t.hook("Stop", { last_assistant_message: "done" });
    expect(t.hooks.pendingSlashSessions()).not.toContain(t.sid);
  });

  test("another person's hook with relay-hook in its name is reported", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.scan();
    t.hookError("Stop", "Failed with non-blocking status code: x", "/Users/a/bin/slack-relay-hook.sh");
    t.scan();
    expect(t.notices()).toHaveLength(1);
  });

  test("the same hook error is reported once per turn", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.scan();
    for (let i = 0; i < 3; i++) t.hookError("PostToolUse", "Failed with non-blocking status code: lint");
    t.scan();
    expect(t.notices()).toHaveLength(1);
    await t.hook("UserPromptSubmit", { prompt: "next" });
    t.hookError("PostToolUse", "Failed with non-blocking status code: lint");
    t.scan();
    expect(t.notices()).toHaveLength(2);
  });
});

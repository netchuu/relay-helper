import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { turnFromTranscript, turnStatsFromTranscript } from "../src/daemon/render.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLiveSteps();
});
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "relay-null-line-"));
  dirs.push(dir);
  return dir;
}
function lines(middle: string) {
  const now = new Date().toISOString();
  return `${[
    JSON.stringify({ type: "user", timestamp: now, message: { role: "user", content: "hi" } }),
    middle,
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: now,
      message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
    }),
  ].join("\n")}\n`;
}

for (const middle of ["null", "42", "[]", '"x"', "true"]) {
  test(`turnFromTranscript skips a ${middle} line`, () => {
    const path = join(tmpDir(), "t.jsonl");
    writeFileSync(path, lines(middle));
    const turn = turnFromTranscript(path, Date.now() - 1000, null);
    expect(turn?.messages.map((m) => m.id)).toEqual(["a1"]);
  });
  test(`turnStatsFromTranscript skips a ${middle} line`, () => {
    const path = join(tmpDir(), "t.jsonl");
    writeFileSync(path, lines(middle));
    expect(turnStatsFromTranscript(path, Date.now() - 1000).toolCalls).toBe(0);
  });
}

test("Stop ends the turn when the transcript holds a null line", async () => {
  const dir = tmpDir();
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker: Broker = new Broker(db, events, () => {});
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const config = { previewChars: 600, preferTyping: true } as RelayConfig;
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = {
    noteLocalActivity: () => {},
    get: () => ({ mode: "auto", present: true, idleSeconds: 0, locked: false }),
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: {
          hook_event_name: event,
          session_id: "s1",
          cwd: dir,
          transcript_path: transcript,
          ...fields,
        },
        env: {},
      } as HookEnvelope,
      new AbortController().signal,
    );
  await hook("SessionStart");
  await hook("UserPromptSubmit", { prompt: "hi" });
  writeFileSync(transcript, lines("null"));
  await hook("Stop", { last_assistant_message: "yo" });
  const row = db.query("SELECT ended_at FROM turns").get() as { ended_at: number | null };
  expect(seen.filter((e) => e.type === "turn.done").length).toBe(1);
  expect(row.ended_at).not.toBeNull();
});

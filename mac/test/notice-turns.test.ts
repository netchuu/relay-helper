import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Turn } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

// A turn Claude Code starts by itself (a background task's notice, no prompt from you) has only its own steps, and
// a long history is read a page at a time.

const CWD = "/tmp/relay-notice";
const dirs: string[] = [];
afterEach(() => {
  resetLiveSteps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const done: Turn[] = [];
  events.subscribe((e) => {
    if (e.type === "turn.done") done.push(e.turn);
  });
  const signal = new AbortController().signal;
  const dir = mkdtempSync(join(tmpdir(), "relay-notice-"));
  dirs.push(dir);
  const transcript = join(dir, "session.jsonl");
  const lines: string[] = [];
  let n = 0;
  const write = (entry: Record<string, unknown>) => {
    n += 1;
    lines.push(
      JSON.stringify({ uuid: `u${n}`, timestamp: new Date(Date.now() + n).toISOString(), ...entry }),
    );
    writeFileSync(transcript, `${lines.join("\n")}\n`);
  };
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: {
          hook_event_name: event,
          session_id: "s1",
          cwd: CWD,
          transcript_path: transcript,
          ...fields,
        },
        env: {},
      },
      signal,
    );
  const call = async <T>(method: string, params: object): Promise<T> => {
    const res = await rpc(method as never, params as never, "device:x");
    if (!("result" in res)) throw new Error(JSON.stringify(res));
    return res.result as T;
  };
  return {
    hook,
    call,
    done,
    prompt: (text: string) => write({ type: "user", message: { role: "user", content: text } }),
    notice: () =>
      write({
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>",
        },
      }),
    read: (id: string, file: string) => {
      write({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id, name: "Read", input: { file_path: `${CWD}/${file}` } }],
        },
      });
      write({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      });
    },
    says: (text: string) => write({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  };
}

describe("a turn started by a notice", () => {
  test("has no steps of the turn before it, however many notices follow", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("tidy the module");
    await t.hook("UserPromptSubmit", { prompt: "tidy the module" });
    t.read("toolu_1", "a.ts");
    t.read("toolu_2", "b.ts");
    t.says("Tidied both files.");
    await t.hook("Stop", { last_assistant_message: "Tidied both files." });
    expect(t.done[0]?.steps?.map((s) => s.label)).toEqual(["Read a.ts", "Read b.ts"]);

    for (const text of ["The tester is still running.", "Still waiting."]) {
      t.notice();
      t.says(text);
      await t.hook("Stop", { last_assistant_message: text });
    }
    expect(t.done).toHaveLength(3);
    for (const turn of t.done.slice(1)) {
      expect(turn.steps).toBeUndefined();
      expect(turn.stats.toolCalls).toBe(0);
      expect(turn.prompt).toBeNull();
    }
    expect(t.done[2]?.summary).toBe("Still waiting.");
  });

  test("keeps the steps it ran itself", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("go");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.read("toolu_1", "a.ts");
    t.says("Started it.");
    await t.hook("Stop", { last_assistant_message: "Started it." });
    t.notice();
    t.read("toolu_2", "report.md");
    t.says("The task finished; I read its report.");
    await t.hook("Stop", { last_assistant_message: "The task finished; I read its report." });
    expect(t.done[1]?.steps?.map((s) => s.label)).toEqual(["Read report.md"]);
  });

  test("a notice in the middle of your turn doesn't cut that turn's steps", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("go");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.read("toolu_1", "a.ts");
    t.notice();
    t.read("toolu_2", "b.ts");
    t.says("Done.");
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(t.done[0]?.steps?.map((s) => s.label)).toEqual(["Read a.ts", "Read b.ts"]);
  });
});

describe("session.turns, a page at a time", () => {
  test("`before` gives the turns that ended earlier, newest first, until none are left", async () => {
    const t = setup();
    await t.hook("SessionStart");
    for (let i = 1; i <= 5; i++) {
      await t.hook("UserPromptSubmit", { prompt: `step ${i}`, transcript_path: "/nonexistent.jsonl" });
      await t.hook("Stop", { last_assistant_message: `answer ${i}`, transcript_path: "/nonexistent.jsonl" });
      await Bun.sleep(3);
    }
    const first = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 2 });
    expect(first.map((x) => x.summary)).toEqual(["answer 5", "answer 4"]);
    const second = await t.call<Turn[]>("session.turns", {
      sessionId: "s1",
      limit: 2,
      before: Math.min(...first.map((x) => x.endedAt)),
    });
    expect(second.map((x) => x.summary)).toEqual(["answer 3", "answer 2"]);
    const third = await t.call<Turn[]>("session.turns", {
      sessionId: "s1",
      limit: 2,
      before: Math.min(...second.map((x) => x.endedAt)),
    });
    expect(third.map((x) => x.summary)).toEqual(["answer 1"]);
    const none = await t.call<Turn[]>("session.turns", {
      sessionId: "s1",
      limit: 2,
      before: third[0]?.endedAt,
    });
    expect(none).toEqual([]);
  });

  test("without `before` it answers as it always did", async () => {
    const t = setup();
    await t.hook("SessionStart");
    await t.hook("UserPromptSubmit", { prompt: "one", transcript_path: "/nonexistent.jsonl" });
    await t.hook("Stop", { last_assistant_message: "answer", transcript_path: "/nonexistent.jsonl" });
    const turns = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 5 });
    expect(turns.map((x) => x.summary)).toEqual(["answer"]);
  });
});

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
import { withoutRecordedCopies } from "../src/daemon/transcript.ts";

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
    status: () => registry.get("s1")?.status,
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
    /** The notice's own hook, as Claude Code fires it when the notice starts a turn. */
    noticeHook: () =>
      hook("UserPromptSubmit", {
        prompt:
          "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>",
      }),
    /** Claude Code's bookkeeping entries at the end of a turn. */
    closes: () => {
      write({ type: "system", subtype: "stop_hook_summary" });
      write({ type: "system", subtype: "turn_duration" });
    },
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
    /** A message Claude Code hands to the running turn: no prompt entry, a queued command attached there. */
    takenIn: (text: string) =>
      write({ type: "attachment", attachment: { type: "queued_command", prompt: text } }),
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

  test("with the notice's own hook (as Claude Code fires it) it still has only its own steps", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("go");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.read("toolu_1", "a.ts");
    t.read("toolu_2", "b.ts");
    t.says("Started both.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "Started both." });

    t.notice();
    await t.noticeHook();
    t.says("First.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "First." });
    expect(t.done[1]?.steps).toBeUndefined();
    expect(t.done[1]?.summary).toBe("First.");

    t.notice();
    await t.noticeHook();
    t.read("toolu_3", "r.md");
    t.says("Second.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "Second." });
    expect(t.done[2]?.steps?.map((s) => s.label)).toEqual(["Read r.md"]);
  });

  test("another notice taken in while it runs doesn't cut it", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("go");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.read("toolu_1", "a.ts");
    t.says("Started it.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "Started it." });

    t.notice();
    await t.noticeHook();
    t.read("toolu_2", "r1.md");
    // A second task finishes meanwhile: its notice joins the running turn.
    t.notice();
    await t.noticeHook();
    t.read("toolu_3", "r2.md");
    t.says("Both reports read.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "Both reports read." });
    expect(t.done[1]?.steps?.map((s) => s.label)).toEqual(["Read r1.md", "Read r2.md"]);
  });

  test("without any hook, two notices in one turn keep the steps between them", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("go");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.read("toolu_1", "a.ts");
    t.says("Started it.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "Started it." });

    t.notice();
    t.read("toolu_2", "r1.md");
    t.notice();
    t.read("toolu_3", "r2.md");
    t.says("Both reports read.");
    t.closes();
    await t.hook("Stop", { last_assistant_message: "Both reports read." });
    expect(t.done[1]?.steps?.map((s) => s.label)).toEqual(["Read r1.md", "Read r2.md"]);
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

describe("a message sent while Claude is still answering", () => {
  test("the answer under way stays with its own prompt, and the new message's turn stays open", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("first question");
    await t.hook("UserPromptSubmit", { prompt: "first question" });
    t.read("toolu_1", "a.ts");
    // Sent now: its hook comes at once, but Claude Code starts on it only when the answer is done.
    await t.hook("UserPromptSubmit", { prompt: "second question, sent meanwhile" });
    t.says("Answer to the first.");
    t.prompt("second question, sent meanwhile");
    await t.hook("Stop", { last_assistant_message: "Answer to the first." });
    expect(t.done).toHaveLength(1);
    expect(t.done[0]).toMatchObject({ prompt: "first question", summary: "Answer to the first." });
    expect(t.status()).toBe("working");

    t.says("Answer to the second.");
    await t.hook("Stop", { last_assistant_message: "Answer to the second." });
    expect(t.done).toHaveLength(2);
    expect(t.done[1]).toMatchObject({
      prompt: "second question, sent meanwhile",
      summary: "Answer to the second.",
    });
    expect(t.status()).toBe("idle");
  });

  test("messages taken in mid-turn share its answer; one still queued gets the next", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("run the flows");
    await t.hook("UserPromptSubmit", { prompt: "run the flows" });
    t.read("toolu_1", "a.ts");
    // Two short messages Claude Code hands to the running turn (queued commands attached to it in the transcript).
    await t.hook("UserPromptSubmit", { prompt: "ok, continue" });
    await t.hook("UserPromptSubmit", { prompt: "." });
    t.takenIn("ok, continue");
    t.takenIn(".");
    // And one that waits in the queue until the answer is done.
    await t.hook("UserPromptSubmit", { prompt: "what about these photos" });
    t.says("Continuing: the flows are running.");
    t.prompt("what about these photos");
    await t.hook("Stop", { last_assistant_message: "Continuing: the flows are running." });
    expect(t.done.map((x) => [x.prompt, x.summary])).toEqual([[".", "Continuing: the flows are running."]]);
    expect(t.status()).toBe("working");

    t.says("The photos show a bug.");
    await t.hook("Stop", { last_assistant_message: "The photos show a bug." });
    expect(t.done[1]).toMatchObject({ prompt: "what about these photos", summary: "The photos show a bug." });
  });

  test("three sent in a row: each answer goes to the prompt Claude Code was on", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("question A");
    await t.hook("UserPromptSubmit", { prompt: "question A" });
    t.read("toolu_1", "a.ts");
    for (const q of ["question B", "question C", "question D"])
      await t.hook("UserPromptSubmit", { prompt: q });
    // Claude Code takes them from its queue one at a time: only B's entry is there when A's answer ends.
    t.says("Answer A.");
    t.prompt("question B");
    await t.hook("Stop", { last_assistant_message: "Answer A." });
    t.says("Answer B.");
    t.prompt("question C");
    await t.hook("Stop", { last_assistant_message: "Answer B." });
    t.says("Answer C.");
    t.prompt("question D");
    await t.hook("Stop", { last_assistant_message: "Answer C." });
    expect(t.status()).toBe("working");
    t.says("Answer D.");
    await t.hook("Stop", { last_assistant_message: "Answer D." });
    expect(t.done.map((x) => [x.prompt, x.summary])).toEqual([
      ["question A", "Answer A."],
      ["question B", "Answer B."],
      ["question C", "Answer C."],
      ["question D", "Answer D."],
    ]);
    expect(t.status()).toBe("idle");
  });

  test('the same words sent again a moment later ("ok", then "ok") wait their turn', async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("ok");
    await t.hook("UserPromptSubmit", { prompt: "ok" });
    t.read("toolu_1", "a.ts");
    await t.hook("UserPromptSubmit", { prompt: "ok" });
    t.says("First ok done.");
    t.prompt("ok");
    await t.hook("Stop", { last_assistant_message: "First ok done." });
    expect(t.done).toHaveLength(1);
    expect(t.status()).toBe("working");
    t.says("Second ok done.");
    await t.hook("Stop", { last_assistant_message: "Second ok done." });
    expect(t.done.map((x) => x.summary)).toEqual(["First ok done.", "Second ok done."]);
    expect(t.done[0]?.id).not.toBe(t.done[1]?.id);
  });

  test("a short message with a file: the transcript's entry carries the path, the hook's prompt may not", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("first");
    await t.hook("UserPromptSubmit", { prompt: "first" });
    t.read("toolu_1", "a.ts");
    await t.hook("UserPromptSubmit", { prompt: "look [Image #1]" });
    t.says("First done.");
    t.prompt("look\n/Users/me/shot one.png");
    await t.hook("Stop", { last_assistant_message: "First done." });
    expect(t.done.map((x) => [x.prompt, x.summary])).toEqual([["first", "First done."]]);
    expect(t.status()).toBe("working");
  });

  test("a prompt that stands before its answer keeps it, as always", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.prompt("first");
    await t.hook("UserPromptSubmit", { prompt: "first" });
    t.says("One.");
    await t.hook("Stop", { last_assistant_message: "One." });
    t.prompt("second");
    await t.hook("UserPromptSubmit", { prompt: "second" });
    t.says("Two.");
    await t.hook("Stop", { last_assistant_message: "Two." });
    expect(t.done.map((x) => [x.prompt, x.summary])).toEqual([
      ["first", "One."],
      ["second", "Two."],
    ]);
    expect(t.status()).toBe("idle");
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
    // As the phone asks: before the time its oldest turn started.
    const start = (turns: Turn[]) => Math.min(...turns.map((x) => x.startedAt ?? x.endedAt));
    const first = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 2 });
    expect(first.map((x) => x.summary)).toEqual(["answer 5", "answer 4"]);
    const second = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 2, before: start(first) });
    expect(second.map((x) => x.summary)).toEqual(["answer 3", "answer 2"]);
    const third = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 2, before: start(second) });
    expect(third.map((x) => x.summary)).toEqual(["answer 1"]);
    const none = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 2, before: start(third) });
    expect(none).toEqual([]);
  });

  test("a turn the next prompt closed (it ends the moment that one starts) isn't skipped", async () => {
    const t = setup();
    await t.hook("SessionStart");
    await t.hook("UserPromptSubmit", { prompt: "first, cut short", transcript_path: "/nonexistent.jsonl" });
    await Bun.sleep(3);
    await t.hook("UserPromptSubmit", { prompt: "second", transcript_path: "/nonexistent.jsonl" });
    await t.hook("Stop", { last_assistant_message: "answer", transcript_path: "/nonexistent.jsonl" });
    const newest = await t.call<Turn[]>("session.turns", { sessionId: "s1", limit: 1 });
    expect(newest.map((x) => x.prompt)).toEqual(["second"]);
    const earlier = await t.call<Turn[]>("session.turns", {
      sessionId: "s1",
      limit: 5,
      before: newest[0]?.startedAt ?? 0,
    });
    expect(earlier.map((x) => x.prompt)).toEqual(["first, cut short"]);
  });

  test("a transcript copy of a turn recorded without its start is left out", () => {
    const copy = (summary: string, endedAt: number) => ({ summary, endedAt }) as Turn;
    const recorded = [{ summary: "Still waiting.", ended_at: 100_000 }];
    const kept = withoutRecordedCopies(
      [copy("Still waiting.", 99_600), copy("Still waiting.", 20_000), copy("Something else.", 99_700)],
      recorded,
    );
    // The same answer ending just before the record is the record's copy; the same words a minute before aren't.
    expect(kept.map((x) => [x.summary, x.endedAt])).toEqual([
      ["Still waiting.", 20_000],
      ["Something else.", 99_700],
    ]);
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

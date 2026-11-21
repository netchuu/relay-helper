import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayEvent, TURN_STEP_OUTPUT_LINES } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { TimelineReader } from "../src/daemon/timeline.ts";
import { interruptedTurn, transcriptTurns } from "../src/daemon/transcript.ts";

// A slash command run on the Mac or sent from the phone is a step with its name, arguments and output.

const iso = (at: number) => new Date(at).toISOString();
const echo = (id: string, at: number, name: string, args = "") => ({
  type: "user",
  uuid: id,
  timestamp: iso(at),
  message: {
    content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
  },
});
const printed = (id: string, at: number, text: string, tag = "stdout") => ({
  type: "user",
  uuid: id,
  timestamp: iso(at),
  message: { content: `<local-command-${tag}>${text}</local-command-${tag}>` },
});
const read = (...entries: object[]) => {
  const reader = new TimelineReader("/Users/me/app");
  for (const e of entries) reader.add(e as Parameters<TimelineReader["add"]>[0]);
  return reader.actions;
};

describe("slash command steps", () => {
  test("the echo gives the name and arguments", () => {
    const [step, ...rest] = read(echo("c1", 1000, "zorp", "two words"));
    expect(rest).toEqual([]);
    expect(step).toMatchObject({ kind: "run", tool: "Command", detail: "/zorp two words", at: 1000 });
    expect(step?.label).toContain("/zorp two words");
    expect(step?.output).toBeUndefined();
  });

  test("the output after it is the step's output, redacted", () => {
    const [step] = read(
      echo("c1", 1000, "zorp"),
      printed("o1", 1100, "all done\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    );
    expect(step?.detail).toBe("/zorp");
    expect(step?.output).toContain("all done");
    expect(step?.output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(step?.outputCut).toBeUndefined();
  });

  test("long output keeps its end and says it was cut; control codes go", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join("\n");
    const [step] = read(echo("c1", 1000, "zorp"), printed("o1", 1100, lines));
    const shown = step?.output?.split("\n") ?? [];
    expect(shown.length).toBeLessThanOrEqual(TURN_STEP_OUTPUT_LINES);
    expect(shown.at(-1)).toBe("line 49");
    expect(step?.output).not.toContain("\x1b");
    expect(step?.outputCut).toBe(true);
  });

  test("a command that printed nothing has no output", () => {
    const [step] = read(echo("c1", 1000, "zorp"), printed("o1", 1100, "  \n"));
    expect(step?.output).toBeUndefined();
    expect(step?.outputCut).toBeUndefined();
  });

  test("an error stream counts as output", () => {
    const [step] = read(echo("c1", 1000, "zorp"), printed("o1", 1100, "zorp failed", "stderr"));
    expect(step?.output).toBe("zorp failed");
  });

  test("reminders, notifications and other sessions' messages stay hidden", () => {
    const user = (text: string) => ({
      type: "user",
      uuid: "x",
      timestamp: iso(1),
      message: { content: text },
    });
    expect(
      read(
        user("<system-reminder>be brief</system-reminder>"),
        user("<task-notification>done</task-notification>"),
        user("<cross-session-message>hi</cross-session-message>"),
        user("<local-command-stdout>orphan</local-command-stdout>"),
        { ...echo("c2", 2, "zorp"), isMeta: true },
      ),
    ).toEqual([]);
  });
});

describe("a command between two prompts", () => {
  const prompt = (id: string, at: number, text: string) => ({
    type: "user",
    uuid: id,
    timestamp: iso(at),
    message: { content: text },
  });
  const answer = (id: string, at: number, text: string) => ({
    type: "assistant",
    uuid: id,
    timestamp: iso(at),
    message: { content: [{ type: "text", text }] },
  });
  const caveat = (at: number) => ({
    type: "user",
    uuid: "cv",
    isMeta: true,
    timestamp: iso(at),
    message: { content: "<local-command-caveat>Caveat</local-command-caveat>" },
  });
  const transcript = [
    prompt("p1", 1000, "first"),
    answer("a1", 2000, "ok1"),
    caveat(3000),
    echo("c1", 3001, "zorp"),
    printed("o1", 3002, "hello"),
    prompt("p2", 4000, "second"),
    answer("a2", 5000, "ok2"),
  ];
  const dirs: string[] = [];
  afterEach(() => {
    resetLiveMessages();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = (lines: object[]) => {
    const dir = mkdtempSync(join(tmpdir(), "relay-slash-"));
    dirs.push(dir);
    const path = join(dir, "t.jsonl");
    writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    return path;
  };

  test("history gives it to the turn after it", () => {
    const path = file(transcript);
    const turns = transcriptTurns("s", path, {
      limit: 10,
      previewChars: 100,
      working: false,
      cwd: "/Users/me/app",
    });
    const byPrompt = (p: string) => turns.find((t) => t.prompt === p);
    expect(byPrompt("first")?.steps ?? []).toEqual([]);
    expect(byPrompt("second")?.steps).toHaveLength(1);
    expect(byPrompt("second")?.steps?.[0]).toMatchObject({ detail: "/zorp", output: "hello" });
  });

  test("a finished turn read by its prompt gives it to the turn after it", () => {
    const path = file(transcript);
    const turn = (text: string, since: number, until: number) =>
      interruptedTurn(path, since, until, "/Users/me/app", text)?.steps;
    expect(turn("first", 1000, 3500)).toEqual([]);
    expect(turn("second", 4000, 6000)).toMatchObject([{ detail: "/zorp", output: "hello" }]);
  });

  test("live, a command written before the turn started is its first step", () => {
    const path = file(transcript.slice(0, 6));
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const tracker = new MessageTracker(events, { pollMs: 0 });
    tracker.turnStarted("s", "t2", path, 4000, "/Users/me/app", true);
    tracker.poll("s");
    const steps = seen.flatMap((e) => (e.type === "turn.action" ? [e.step] : []));
    expect(new Set(steps.map((x) => x.id)).size).toBe(1);
    expect(steps.at(-1)).toMatchObject({ detail: "/zorp", output: "hello" });
    tracker.clear("s");
  });
  const opts = { limit: 10, previewChars: 100, working: false, cwd: "/Users/me/app" };

  test("a command after the last prompt stays on that turn", () => {
    const path = file(transcript.slice(0, 5));
    const first = transcriptTurns("s", path, opts).find((t) => t.prompt === "first");
    expect(first?.steps).toMatchObject([{ detail: "/zorp", output: "hello" }]);
    expect(
      interruptedTurn(path, 1000, Number.POSITIVE_INFINITY, "/Users/me/app", "first")?.steps,
    ).toMatchObject([{ detail: "/zorp" }]);
  });

  describe("a command that makes its own answer", () => {
    const own = [
      prompt("p1", 1000, "first"),
      answer("a1", 2000, "ok1"),
      echo("c1", 3001, "rev"),
      { ...prompt("m1", 3002, "Review the change"), isMeta: true },
      answer("a2", 3500, "review says fine"),
      prompt("p2", 4000, "second"),
      answer("a3", 5000, "ok2"),
    ];

    test("history and the prompt reader put step and answer on the same turn", () => {
      const path = file(own);
      const turns = transcriptTurns("s", path, opts);
      const byPrompt = (p: string) => turns.find((t) => t.prompt === p);
      expect(byPrompt("first")?.steps).toMatchObject([{ detail: "/rev" }]);
      expect(byPrompt("first")?.summary).toBe("review says fine");
      expect(byPrompt("second")?.steps ?? []).toEqual([]);
      expect(interruptedTurn(path, 1000, 3900, "/Users/me/app", "first")?.steps).toMatchObject([
        { detail: "/rev" },
      ]);
      expect(interruptedTurn(path, 4000, 6000, "/Users/me/app", "second")?.steps ?? []).toEqual([]);
    });
  });

  test("live without a resume, a command written before the turn started is its first step", () => {
    const path = file(transcript.slice(0, 5));
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const tracker = new MessageTracker(events, { pollMs: 0 });
    tracker.turnStarted("s", "t2", path, 4000, "/Users/me/app");
    appendFileSync(path, [transcript[5], transcript[6]].map((l) => `${JSON.stringify(l)}\n`).join(""));
    tracker.poll("s");
    const steps = seen.flatMap((e) => (e.type === "turn.action" ? [e.step] : []));
    expect(steps.map((x) => x.detail)).toContain("/zorp");
    tracker.clear("s");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Turn } from "../../protocol/index.ts";
import { notifiedTaskId } from "../src/daemon/background.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { interruptedTurn, isSystemMessage, transcriptTurns } from "../src/daemon/transcript.ts";
import { FIXTURE_CWD, FIXTURE_START, sanitizeEntry } from "./record/sanitize.ts";

// Real Claude Code transcripts (mac/test/fixtures/transcripts/, recorded by `bun run record:transcripts`), read the
// way the helper reads them, checking what the phone gets. The hand-written transcripts in the other tests can only
// hold what we thought of; these hold what Claude Code writes.

const DIR = join(import.meta.dir, "fixtures", "transcripts");
const path = (name: string) => join(DIR, `${name}.jsonl`);
const turnsOf = (name: string): Turn[] =>
  transcriptTurns(`rec-${name}`, path(name), {
    limit: 10,
    previewChars: 600,
    working: false,
    cwd: FIXTURE_CWD,
  }).reverse();

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the recordings", () => {
  test("every scenario is recorded, and nothing of the recording machine is in them", () => {
    const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as Record<
      string,
      { claudeVersion: string }
    >;
    expect(Object.keys(index).sort()).toEqual(
      ["background", "failed-tool", "image", "plain", "stop", "subagent"].sort(),
    );
    const all: string[] = [];
    const jsonl: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else {
          const text = readFileSync(join(d, e.name), "utf8");
          all.push(text);
          if (e.name.endsWith(".jsonl")) jsonl.push(text);
        }
      }
    };
    walk(DIR);
    const text = all.join("\n");
    expect(text).not.toMatch(/\/Users\/(?!me\b)/);
    expect(text).not.toMatch(/\/var\/folders|\/private\/|claude-\d+/);
    expect(text).not.toMatch(/@(?!example\.com)[\w-]+\.\w+/);
    // Only what the helper reads: no system prompts, memory or request bodies.
    expect(text).not.toContain("api-request");
    expect(text).not.toContain('"type":"attachment"');
    for (const line of jsonl.join("\n").split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as { type?: string; timestamp?: string };
      if (e.type !== undefined) expect(["user", "assistant", "system"]).toContain(e.type);
      if (e.timestamp) expect(Date.parse(e.timestamp)).toBeGreaterThanOrEqual(FIXTURE_START);
    }
  });
});

describe("a plain prompt", () => {
  test("is one finished turn with Claude's answer and no steps", () => {
    const [turn, ...more] = turnsOf("plain");
    expect(more).toEqual([]);
    expect(turn?.prompt).toBe("Say hello in exactly five words.");
    expect(turn?.summary).toMatch(/^Hello\b/i);
    expect(turn?.failed).toBe(false);
    expect(turn?.stopped).toBeUndefined();
    expect(turn?.steps).toBeUndefined();
    expect(turn?.stats.toolCalls).toBe(0);
    expect(turn?.stats.durationMs).toBeGreaterThan(0);
  });
});

describe("a prompt with an image", () => {
  test("keeps Claude Code's [Image #1] token as the prompt, and the picture stays out of the turn", () => {
    const [turn] = turnsOf("image");
    expect(turn?.prompt).toBe("[Image #1] what colour is this? one word");
    expect(JSON.stringify(turn)).not.toContain("iVBOR");
    expect(turn?.summary.toLowerCase()).toContain("red");
  });

  test("the entry Claude Code adds with the image's path is not a second prompt", () => {
    expect(turnsOf("image")).toHaveLength(1);
  });
});

describe("Stop mid-answer, then a new prompt", () => {
  test("two turns: the first stopped with what Claude had written, the second a normal one", () => {
    const [first, second, ...more] = turnsOf("stop");
    expect(more).toEqual([]);
    expect(first?.stopped).toBe(true);
    expect(first?.prompt).toStartWith("Write a 1500 word story");
    expect(first?.summary.length).toBeGreaterThan(20);
    // The marker is Claude Code's note, never a prompt of its own.
    expect(JSON.stringify([first, second])).not.toContain("Request interrupted");
    expect(second?.prompt).toBe("Say OK.");
    expect(second?.stopped).toBeUndefined();
    expect(second?.summary).toBe("OK.");
  });

  test("reading the first turn live says it was interrupted; the second says it wasn't", () => {
    const [first, second] = turnsOf("stop");
    const a = interruptedTurn(
      path("stop"),
      (first?.startedAt as number) - 1,
      (second?.startedAt as number) - 1,
      FIXTURE_CWD,
      first?.prompt,
    );
    expect(a?.interrupted).toBe(true);
    expect(a?.text.length).toBeGreaterThan(20);
    const b = interruptedTurn(
      path("stop"),
      (second?.startedAt as number) - 1,
      undefined,
      FIXTURE_CWD,
      second?.prompt,
    );
    expect(b?.interrupted).toBe(false);
    expect(b?.text).toBe("OK.");
  });
});

describe("a sub-agent", () => {
  test("is an agent step with its own steps read from the agent's transcript", () => {
    const [turn] = turnsOf("subagent");
    const agent = turn?.steps?.find((s) => s.kind === "agent");
    expect(agent?.tool).toBe("Agent");
    expect(agent?.title).toBe("Count .txt files in folder");
    expect(agent?.label).toStartWith("Ran an agent");
    expect(agent?.running).toBeUndefined();
    expect(agent?.stepCount).toBeGreaterThan(0);
    expect(agent?.children?.length).toBeGreaterThan(0);
    // The agent's own tool calls are inside its row, not rows of the turn.
    expect(turn?.steps?.filter((s) => s.kind !== "agent")).toEqual([]);
    expect(turn?.stats.toolCalls).toBe(1);
  });
});

describe("a background shell", () => {
  test("the turn lists the Bash call with the command it ran", () => {
    const [turn] = turnsOf("background");
    const bash = turn?.steps?.find((s) => s.tool === "Bash");
    expect(bash?.detail).toBe("sleep 12; echo finished");
    expect(bash?.failed).toBeUndefined();
  });

  test("its end arrives as a system message that names the task, not as something you typed", () => {
    const entries = readFileSync(path("background"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; message: { content: unknown } });
    const notices = entries.filter(
      (e) =>
        e.type === "user" &&
        typeof e.message.content === "string" &&
        e.message.content.includes("<task-notification>"),
    );
    expect(notices).toHaveLength(1);
    const text = notices[0]?.message.content as string;
    expect(isSystemMessage(text)).toBe(true);
    expect(notifiedTaskId(text)).toMatch(/^[a-z0-9]+$/);
    // The shell's own tool_result names the same task.
    const started = readFileSync(path("background"), "utf8");
    expect(started).toContain(
      `<tool-use-id>${(/<tool-use-id>([^<]+)</.exec(text) as RegExpExecArray)[1]}</tool-use-id>`,
    );
  });

  test("the turn Claude Code starts when the shell ends has its own answer", () => {
    const [turn] = turnsOf("background");
    const at = turn?.startedAt as number;
    const system = interruptedTurn(path("background"), at, undefined, FIXTURE_CWD, "");
    expect(system?.interrupted).toBe(false);
    expect(system?.text.length).toBeGreaterThan(0);
    // The notification was written after the first answer, so the answer it caused is not the first one.
    expect(system?.messages.length).toBeGreaterThan(0);
  });
});

describe("a failed tool", () => {
  test("is a failed step, and the answer still comes", () => {
    const [turn] = turnsOf("failed-tool");
    const read = turn?.steps?.find((s) => s.tool === "Read");
    expect(read?.failed).toBe(true);
    expect(read?.detail).toBe("missing-file.txt");
    expect(turn?.steps?.filter((s) => s.failed).length).toBeGreaterThanOrEqual(1);
    expect(turn?.summary.toLowerCase()).toContain("missing-file.txt");
    expect(turn?.failed).toBe(false);
  });
});

describe("live, as the transcript grows line by line", () => {
  /** Replays a recording into a file one line at a time, the way Claude Code writes it, and returns what the phone is sent. */
  function replay(name: string): RelayEvent[] {
    const dir = mkdtempSync(join(tmpdir(), "relay-recorded-"));
    dirs.push(dir);
    const file = join(dir, `${name}.jsonl`);
    writeFileSync(file, "");
    const events = new EventLog(openDb(":memory:"));
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const tracker = new MessageTracker(events, { pollMs: 0 });
    tracker.turnStarted("s1", "t1", file, FIXTURE_START - 1, FIXTURE_CWD);
    for (const line of readFileSync(path(name), "utf8").split("\n").filter(Boolean)) {
      appendFileSync(file, `${line}\n`);
      tracker.poll("s1");
    }
    return seen;
  }
  const actions = (seen: RelayEvent[]) => seen.flatMap((e) => (e.type === "turn.action" ? [e.step] : []));
  const messages = (seen: RelayEvent[]) =>
    seen.flatMap((e) => (e.type === "turn.message" ? [e.message] : []));

  test("a failed tool is sent as a step, then again as failed", () => {
    const steps = actions(replay("failed-tool")).filter((s) => s.tool === "Read");
    expect(steps.map((s) => s.failed)).toEqual([undefined, true]);
    expect(steps[0]?.id).toBe(steps[1]?.id as string);
  });

  test("a sub-agent's row is sent, and its steps arrive with it", () => {
    const steps = actions(replay("subagent")).filter((s) => s.kind === "agent");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.at(-1)?.title).toBe("Count .txt files in folder");
  });

  test("a stopped answer's text is sent before the interrupt, and the marker is not a message", () => {
    const sent = messages(replay("stop"));
    expect(sent[0]?.text).toStartWith("# The Keeper of Halden Rock");
    expect(JSON.stringify(sent)).not.toContain("Request interrupted");
  });

  test("the answer's text is sent as messages in order, with nothing from the image", () => {
    const sent = messages(replay("image"));
    expect(JSON.stringify(sent)).not.toContain("iVBOR");
    expect(JSON.stringify(sent)).not.toContain("[Image #1]");
  });
});

describe("redaction of a new recording", () => {
  const ctx = {
    cwds: ["/private/var/folders/x/T/relay-record-abc"],
    home: "/Users/jane",
    user: "jane",
    sessionId: "real-id",
    fixedSessionId: "rec-x",
    firstAt: Date.parse("2026-01-01T00:00:00Z"),
  };
  const entry = (content: unknown, extra: object = {}) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "user", content },
      ...extra,
    });

  test("paths, secrets, e-mail addresses and the clock", () => {
    const out = JSON.parse(
      sanitizeEntry(
        entry(
          "in /private/var/folders/x/T/relay-record-abc/a.ts and /Users/jane/.zshrc, token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123, jane@corp.io",
          {
            sessionId: "real-id",
          },
        ),
        ctx,
      ) as string,
    );
    expect(out.message.content).toBe(
      "in /Users/me/Projects/scratch/a.ts and /Users/me/.zshrc, token [redacted:github-token], me@example.com",
    );
    expect(out.sessionId).toBe("rec-x");
    expect(out.timestamp).toBe("2026-11-09T10:00:05.000Z");
  });

  test("only the entries and fields the helper reads are kept", () => {
    expect(
      sanitizeEntry(JSON.stringify({ type: "attachment", attachment: { type: "instructions" } }), ctx),
    ).toBeNull();
    expect(sanitizeEntry(JSON.stringify({ type: "api-request", params: {} }), ctx)).toBeNull();
    expect(sanitizeEntry(JSON.stringify({ type: "system", subtype: "informational" }), ctx)).toBeNull();
    expect(sanitizeEntry("not json", ctx)).toBeNull();
    const kept = JSON.parse(
      sanitizeEntry(
        entry("hi", { userType: "external", entrypoint: "cli", requestId: "req_1" }),
        ctx,
      ) as string,
    );
    expect(Object.keys(kept).sort()).toEqual(["message", "sessionId", "timestamp", "type"]);
  });

  test("a thinking block's signature is dropped", () => {
    const out = sanitizeEntry(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { content: [{ type: "thinking", thinking: "", signature: "AAAA" }] },
      }),
      ctx,
    );
    expect(out).not.toContain("signature");
  });
});

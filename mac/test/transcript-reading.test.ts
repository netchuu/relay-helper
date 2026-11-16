import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Turn } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { answerOwner, interruptedTurn, transcriptTurns } from "../src/daemon/transcript.ts";
import { FIXTURE_CWD, FIXTURE_START, sanitizeEntry, sanitizeTranscript } from "./record/sanitize.ts";
import { waitFor } from "./support/wait.ts";

// Edge cases for reading recorded Claude Code transcripts and for sanitizing a new recording: odd and damaged files,
// the same file read twice or while it grows, fields the helper doesn't know, and what must never survive into a
// committed recording.

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "relay-transcript-edge-"));
  dirs.push(d);
  return d;
};

const T0 = "2026-11-09T10:00:00.000Z";
const at = (s: number) => new Date(FIXTURE_START + s * 1000).toISOString();
const user = (s: number, content: unknown, extra: object = {}) =>
  JSON.stringify({
    type: "user",
    timestamp: at(s),
    sessionId: "s",
    message: { role: "user", content },
    ...extra,
  });
const assistant = (s: number, content: unknown, extra: object = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(s),
    uuid: `a${s}`,
    sessionId: "s",
    message: { role: "assistant", content },
    ...extra,
  });
const text = (t: string) => [{ type: "text", text: t }];

function turnsOf(body: string, opts: Partial<Parameters<typeof transcriptTurns>[2]> = {}): Turn[] {
  const file = join(scratch(), "t.jsonl");
  writeFileSync(file, body);
  return transcriptTurns("s", file, {
    limit: 10,
    previewChars: 600,
    working: false,
    cwd: FIXTURE_CWD,
    ...opts,
  }).reverse();
}
const lines = (...l: string[]) => `${l.join("\n")}\n`;
const simple = lines(user(0, "hi"), assistant(1, text("hello")));

describe("a transcript that is missing, empty or damaged", () => {
  test("a file that is not there gives no turns and no error", () => {
    expect(
      transcriptTurns("s", join(scratch(), "missing.jsonl"), {
        limit: 5,
        previewChars: 100,
        working: false,
      }),
    ).toEqual([]);
    expect(interruptedTurn(join(scratch(), "missing.jsonl"), 0)).toBeNull();
  });

  test("an empty file, whitespace only, and lines that are not JSON give no turns", () => {
    expect(turnsOf("")).toEqual([]);
    expect(turnsOf("\n\n   \n")).toEqual([]);
    expect(turnsOf("not json\n{bad\n[1,2\n")).toEqual([]);
    expect(interruptedTurn(join(scratch(), "x"), 0)).toBeNull();
  });

  test("garbage lines between real entries are skipped", () => {
    const [turn, ...more] = turnsOf(lines("{oops", user(0, "hi"), "", "42", assistant(1, text("hello"))));
    expect(more).toEqual([]);
    expect(turn?.prompt).toBe("hi");
    expect(turn?.summary).toBe("hello");
  });

  test("a last line cut off mid-write is ignored and the turn before it is intact", () => {
    const [turn, ...more] = turnsOf(`${simple}{"type":"user","timestamp":"${at(2)}","mess`);
    expect(more).toEqual([]);
    expect(turn?.prompt).toBe("hi");
    expect(turn?.summary).toBe("hello");
  });

  test("Windows line endings read the same as Unix ones", () => {
    const crlf = turnsOf(simple.replaceAll("\n", "\r\n"));
    expect(crlf).toEqual(turnsOf(simple));
    expect(crlf).toHaveLength(1);
  });

  test("a prompt with no answer yet is not a finished turn, and a working session never shows its last", () => {
    expect(turnsOf(lines(user(0, "hi")))).toEqual([]);
    expect(turnsOf(simple, { working: true })).toEqual([]);
    expect(
      turnsOf(lines(user(0, "one"), assistant(1, text("a")), user(2, "two"), assistant(3, text("b"))), {
        working: true,
      }).map((t) => t.prompt),
    ).toEqual(["one"]);
  });

  test("entries with null or missing content do not throw", () => {
    expect(() =>
      turnsOf(
        lines(
          user(0, null),
          JSON.stringify({ type: "user", timestamp: at(1) }),
          assistant(2, null),
          JSON.stringify({ type: "assistant", message: null }),
          user(3, "hi"),
          assistant(4, text("hello")),
        ),
      ),
    ).not.toThrow();
    expect(
      turnsOf(lines(user(0, null), user(3, "hi"), assistant(4, text("hello")))).map((t) => t.prompt),
    ).toEqual(["hi"]);
  });
});

describe("inputs at the limits", () => {
  test("a prompt of whitespace only is not a turn of its own", () => {
    const turns = turnsOf(lines(user(0, "   \n\t"), assistant(1, text("hello"))));
    expect(turns.map((t) => (t.prompt ?? "").trim()).filter(Boolean)).toEqual([]);
  });

  test("a prompt and an answer longer than the preview are cut, not dropped", () => {
    const [turn] = turnsOf(lines(user(0, "x".repeat(5000)), assistant(1, text("y".repeat(5000)))), {
      previewChars: 200,
    });
    expect(turn).toBeDefined();
    expect(turn?.summary.length).toBeLessThanOrEqual(400);
    expect(turn?.summary.startsWith("y")).toBe(true);
  });

  test("tabs, line breaks, right-to-left text, emoji and combining marks come through unchanged", () => {
    const prompt = "a\tb\nc مرحبا 👨‍👩‍👧 é ‮txt";
    const [turn] = turnsOf(lines(user(0, prompt), assistant(1, text("ok"))));
    expect(turn?.prompt?.normalize("NFC")).toContain("مرحبا 👨‍👩‍👧");
    expect(turn?.prompt).toContain("a\tb\nc");
  });

  test("limit 1 gives the newest turn, and before pages back to the older one", () => {
    const body = lines(user(0, "one"), assistant(1, text("a")), user(2, "two"), assistant(3, text("b")));
    const file = join(scratch(), "t.jsonl");
    writeFileSync(file, body);
    const opts = { previewChars: 100, working: false, cwd: FIXTURE_CWD };
    const newest = transcriptTurns("s", file, { ...opts, limit: 1 });
    expect(newest.map((t) => t.prompt)).toEqual(["two"]);
    const older = transcriptTurns("s", file, {
      ...opts,
      limit: 1,
      before: newest[0]?.startedAt ?? undefined,
    });
    expect(older.map((t) => t.prompt)).toEqual(["one"]);
  });

  test("two Stop markers in a row mark the turn stopped once, not two turns", () => {
    const marker = (s: number, t = "[Request interrupted by user]") => user(s, text(t));
    const turns = turnsOf(lines(user(0, "hi"), assistant(1, text("par")), marker(2), marker(3)));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.stopped).toBe(true);
    expect(JSON.stringify(turns)).not.toContain("Request interrupted");
  });

  test("the marker for an interrupted tool call also marks the turn stopped and is not shown", () => {
    const turns = turnsOf(
      lines(
        user(0, "hi"),
        assistant(1, text("par")),
        user(2, text("[Request interrupted by user for tool use]")),
      ),
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.stopped).toBe(true);
    expect(JSON.stringify(turns)).not.toContain("Request interrupted");
  });

  test("a prompt that merely quotes the marker is still a prompt", () => {
    const turns = turnsOf(
      lines(user(0, "what does [Request interrupted by user] mean?"), assistant(1, text("a note"))),
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.stopped).toBeUndefined();
    expect(turns[0]?.prompt).toContain("what does");
  });
});

describe("state: the same transcript read again, and a transcript that grows", () => {
  test("reading a file twice gives the same turns", () => {
    const file = join(FIXTURES, "stop.jsonl");
    const read = () =>
      transcriptTurns("rec-stop", file, { limit: 10, previewChars: 600, working: false, cwd: FIXTURE_CWD });
    expect(read()).toEqual(read());
  });

  test("reading a recording after it was copied elsewhere gives the same turns", () => {
    const copy = join(scratch(), "copy.jsonl");
    writeFileSync(copy, readFileSync(join(FIXTURES, "failed-tool.jsonl")));
    const opts = { limit: 10, previewChars: 600, working: false, cwd: FIXTURE_CWD };
    expect(transcriptTurns("rec-failed-tool", copy, opts)).toEqual(
      transcriptTurns("rec-failed-tool", join(FIXTURES, "failed-tool.jsonl"), opts),
    );
  });

  test("a turn becomes finished when its answer is appended, and nothing earlier changes", () => {
    const file = join(scratch(), "t.jsonl");
    writeFileSync(file, lines(user(0, "one"), assistant(1, text("a")), user(2, "two")));
    const opts = { limit: 10, previewChars: 100, working: false, cwd: FIXTURE_CWD };
    expect(transcriptTurns("s", file, opts).map((t) => t.prompt)).toEqual(["one"]);
    appendFileSync(file, `${assistant(3, text("b"))}\n`);
    expect(
      transcriptTurns("s", file, opts)
        .reverse()
        .map((t) => [t.prompt, t.summary]),
    ).toEqual([
      ["one", "a"],
      ["two", "b"],
    ]);
  });
});

describe("live reading of a growing transcript", () => {
  function tracker() {
    const file = join(scratch(), "live.jsonl");
    writeFileSync(file, "");
    const events = new EventLog(openDb(":memory:"));
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const t = new MessageTracker(events, { pollMs: 0 });
    t.turnStarted("s1", "t1", file, FIXTURE_START - 1, FIXTURE_CWD);
    return { file, t, seen };
  }
  const sent = (seen: RelayEvent[]) =>
    seen.flatMap((e) => (e.type === "turn.message" ? [e.message.text] : []));

  test("polling again with nothing new sends nothing twice", async () => {
    const { file, t, seen } = tracker();
    appendFileSync(file, `${user(0, "hi")}\n${assistant(1, text("hello"))}\n`);
    t.poll("s1");
    await waitFor(() => sent(seen).length > 0, 2000, "the first message");
    const before = seen.length;
    t.poll("s1");
    t.poll("s1");
    expect(seen).toHaveLength(before);
    expect(sent(seen)).toEqual(["hello"]);
  });

  test("the same entry written twice (same id) is sent once", () => {
    const { file, t, seen } = tracker();
    const answer = assistant(1, text("hello"));
    appendFileSync(file, lines(user(0, "hi"), answer, answer));
    t.poll("s1");
    expect(sent(seen)).toEqual(["hello"]);
  });

  test("a transcript replaced by a shorter one is read again from its start", () => {
    const { file, t, seen } = tracker();
    appendFileSync(file, lines(user(0, "hi"), assistant(1, text("a long first answer, long enough"))));
    t.poll("s1");
    writeFileSync(file, lines(user(2, "again"), assistant(3, text("b"))));
    t.poll("s1");
    expect(sent(seen)).toEqual(["a long first answer, long enough", "b"]);
  });

  test("a line written in two halves is sent once, when it is whole", () => {
    const { file, t, seen } = tracker();
    appendFileSync(file, `${user(0, "hi")}\n`);
    const answer = assistant(1, text("hello there"));
    appendFileSync(file, answer.slice(0, 30));
    t.poll("s1");
    expect(sent(seen)).toEqual([]);
    appendFileSync(file, `${answer.slice(30)}\n`);
    t.poll("s1");
    expect(sent(seen)).toEqual(["hello there"]);
  });

  test("a transcript that is not there yet, then appears, is read from its start", () => {
    const dir = scratch();
    const file = join(dir, "later.jsonl");
    const events = new EventLog(openDb(":memory:"));
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const t = new MessageTracker(events, { pollMs: 0 });
    t.turnStarted("s1", "t1", file, FIXTURE_START - 1, FIXTURE_CWD);
    expect(() => t.poll("s1")).not.toThrow();
    writeFileSync(file, `${user(0, "hi")}\n${assistant(1, text("late"))}\n`);
    t.poll("s1");
    expect(sent(seen)).toEqual(["late"]);
  });

  test("entries and blocks of a kind the helper doesn't know are skipped without losing the text", () => {
    const { file, t, seen } = tracker();
    appendFileSync(
      file,
      lines(
        user(0, "hi", { futureField: { a: 1 } }),
        JSON.stringify({ type: "brand-new-entry", x: 1 }),
        assistant(1, [{ type: "future_block", z: 1 }, ...text("still here")]),
      ),
    );
    t.poll("s1");
    expect(sent(seen)).toEqual(["still here"]);
  });

  test("a turn that started after the entries on file ignores the older ones", () => {
    const dir = scratch();
    const file = join(dir, "old.jsonl");
    writeFileSync(file, lines(user(0, "old"), assistant(1, text("old answer"))));
    const events = new EventLog(openDb(":memory:"));
    const seen: RelayEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const t = new MessageTracker(events, { pollMs: 0 });
    t.turnStarted("s1", "t1", file, FIXTURE_START + 10_000, FIXTURE_CWD);
    appendFileSync(file, lines(user(20, "new"), assistant(21, text("new answer"))));
    t.poll("s1");
    expect(sent(seen)).toEqual(["new answer"]);
  });
});

describe("sanitizing a new recording: inputs", () => {
  const ctx = {
    cwds: ["/private/var/folders/x/T/relay-record-abc", "/var/folders/x/T/relay-record-abc"],
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
  const out = (line: string) => JSON.parse(sanitizeEntry(line, ctx) as string);

  test("blank lines, whitespace, other JSON values and entries without a type are dropped", () => {
    for (const l of ["", "   ", "\t", "42", "[]", '"str"', "true", "{}", '{"type":7}', '{"type":null}'])
      expect(sanitizeEntry(l, ctx)).toBeNull();
  });

  test("empty content, null content and a missing message are kept as they are", () => {
    expect(out(entry("")).message.content).toBe("");
    expect(out(entry(null)).message.content).toBeNull();
    expect(out(JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z" })).message).toBeUndefined();
  });

  test("a timestamp before the first one stays before the start, and one that is not a date is left alone", () => {
    expect(out(entry("hi", { timestamp: "2025-12-31T23:59:58.000Z" })).timestamp).toBe(
      new Date(FIXTURE_START - 2000).toISOString(),
    );
    expect(out(entry("hi", { timestamp: "not a date" })).timestamp).toBe("not a date");
    expect("timestamp" in out(JSON.stringify({ type: "user", message: { content: "x" } }))).toBe(false);
  });

  test("both spellings of the scratch folder, with and without /private, become the fixed one", () => {
    const o = out(
      entry("a /private/var/folders/x/T/relay-record-abc/f and /var/folders/x/T/relay-record-abc/g"),
    );
    expect(o.message.content).toBe("a /Users/me/Projects/scratch/f and /Users/me/Projects/scratch/g");
  });

  test("the folder name Claude Code derives from the scratch folder, in dashes, is replaced too", () => {
    const o = out(entry("~/.claude/projects/-private-var-folders-x-T-relay-record-abc/s.jsonl"));
    expect(o.message.content).toBe("~/.claude/projects/-Users-me-Projects-scratch/s.jsonl");
  });

  test("the home folder goes even when the user name is not the folder's name", () => {
    const other = { ...ctx, user: "zed" };
    const o = JSON.parse(sanitizeEntry(entry("cat /Users/jane/notes.txt"), other) as string);
    expect(o.message.content).toBe("cat /Users/me/notes.txt");
  });

  test("the home folder goes only as a whole folder, never as the start of another one", () => {
    expect(out(entry("/Users/janet/y")).message.content).toBe("/Users/janet/y");
    expect(out(entry("/Users/jane/y and /Users/jane")).message.content).toBe("/Users/me/y and /Users/me");
  });

  test("the user name goes only when it is a whole word, and a one or two letter name is left alone", () => {
    expect(out(entry("jane janet ajane /Users/jane/x")).message.content).toBe("me janet ajane /Users/me/x");
    const short = { ...ctx, user: "jo", home: "" };
    expect(JSON.parse(sanitizeEntry(entry("jo and jon"), short) as string).message.content).toBe(
      "jo and jon",
    );
  });

  test("an address in any case and with a plus tag becomes the example address", () => {
    expect(out(entry("Jane.Doe+tag@Corp.IO, a@b.co")).message.content).toBe("me@example.com, me@example.com");
  });

  test("right-to-left text, emoji and line separators survive sanitizing", () => {
    const s = "مرحبا 👨‍👩‍👧 é   line\tbreak\n";
    expect(out(entry(s)).message.content).toBe(s);
  });

  test("a real session id anywhere in the entry becomes the fixed one", () => {
    const o = out(entry("see real-id", { sessionId: "real-id", uuid: "u1" }));
    expect(o.sessionId).toBe("rec-x");
    expect(o.message.content).toBe("see rec-x");
  });

  test("only the two bookkeeping system entries are kept", () => {
    const sys = (subtype?: string) => JSON.stringify({ type: "system", subtype, durationMs: 5 });
    expect(out(sys("turn_duration")).durationMs).toBe(5);
    expect(out(sys("stop_hook_summary")).type).toBe("system");
    expect(sanitizeEntry(sys("compact_boundary"), ctx)).toBeNull();
    expect(sanitizeEntry(sys(undefined), ctx)).toBeNull();
  });

  test("a recording is one entry per line, ends with a newline, and has no blank line when all are dropped", () => {
    const body = sanitizeTranscript(`${entry("a")}\n\n{"type":"attachment"}\n${entry("b")}`, ctx);
    expect(body.split("\n")).toHaveLength(3);
    expect(body.endsWith("\n")).toBe(true);
    expect(sanitizeTranscript('{"type":"attachment"}\n', ctx)).toBe("\n");
  });
});

describe("sanitizing a new recording: state and privacy", () => {
  const ctx = {
    cwds: ["/tmp/relay-record-abc"],
    home: "/Users/jane",
    user: "jane",
    sessionId: "real-id",
    fixedSessionId: "rec-x",
    firstAt: Date.parse("2026-01-01T00:00:00Z"),
  };
  const raw = (message: unknown) =>
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message });
  const flat = (message: unknown) => sanitizeEntry(raw(message), ctx) as string;

  test("sanitizing twice gives the same entry", () => {
    const line = raw({
      content: [{ type: "text", text: "in /tmp/relay-record-abc by jane@corp.io" }],
    });
    const once = sanitizeEntry(line, ctx) as string;
    const again = sanitizeEntry(once, { ...ctx, sessionId: "rec-x", firstAt: FIXTURE_START }) as string;
    expect(again).toBe(once);
  });

  test("every committed recording is unchanged by sanitizing it again", () => {
    const again = {
      ...ctx,
      cwds: [],
      home: "/Users/me",
      user: "me",
      sessionId: "rec",
      firstAt: FIXTURE_START,
    };
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) files.push(p);
      }
    };
    walk(FIXTURES);
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
        const id = (JSON.parse(line) as { sessionId?: string }).sessionId ?? "";
        expect(sanitizeEntry(line, { ...again, sessionId: id, fixedSessionId: id })).toBe(line);
      }
    }
  });

  test("a secret inside a tool call's input, a tool result and nested content is redacted", () => {
    const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";
    const o = flat({
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: `curl -H "Authorization: token ${key}"`, nested: { a: [key] } },
        },
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `export TOKEN=${key}` }] },
      ],
    });
    expect(o).not.toContain(key);
    expect(o).toContain("[redacted:github-token]");
  });

  test("a secret in a thinking block is redacted and the signature goes", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const o = flat({ content: [{ type: "thinking", thinking: `use ${key}`, signature: "AAAA" }] });
    expect(o).not.toContain(key);
    expect(o).not.toContain("signature");
  });

  test("fields the helper doesn't read are dropped from the entry and its message", () => {
    const o = JSON.parse(
      sanitizeEntry(
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          userType: "external",
          requestId: "req_9",
          slug: "some-name",
          toolUseResult: { stdout: "secret output" },
          message: { content: "x", usage: { input_tokens: 1 }, container: { id: "c" } },
        }),
        ctx,
      ) as string,
    );
    expect(Object.keys(o).sort()).toEqual(["message", "sessionId", "timestamp", "type"]);
    expect(Object.keys(o.message)).toEqual(["content"]);
  });

  test("text that looks like a command or markup is kept as plain text", () => {
    const s = "$(rm -rf ~) `id` <script>alert(1)</script> ]]> {{x}} \\u0000";
    const o = JSON.parse(flat({ content: s }));
    expect(o.message.content).toBe(s);
  });

  test("the home folder is replaced inside a longer path and in the folder name Claude Code derives from it", () => {
    const o = flat({ content: "/Users/jane/.claude/projects/-Users-jane-Code/x.jsonl" });
    expect(o).not.toContain("jane");
    expect(o).toContain("/Users/me/.claude/projects/-Users-me-Code/x.jsonl");
  });
});

describe("the recorded index", () => {
  test("each scenario names its Claude Code version and date, and has a transcript beside it", () => {
    const index = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as Record<
      string,
      { about: string; claudeVersion: string; recordedAt: string }
    >;
    for (const [name, e] of Object.entries(index)) {
      expect(e.about.length).toBeGreaterThan(0);
      expect(e.claudeVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8").length).toBeGreaterThan(0);
    }
    expect(T0).toBe(new Date(FIXTURE_START).toISOString());
  });
});

describe("lines that parse but are not entries", () => {
  const junk = ["null", "42", "[]", '"s"', "true"];
  const real = [user(0, "one"), assistant(1, text("a")), user(2, "two"), assistant(3, text("b"))];
  const file = (body: string) => {
    const path = join(scratch(), "t.jsonl");
    writeFileSync(path, body);
    return path;
  };

  test("answerOwner gives the same owner with such a line between entries", () => {
    const turns = [
      { id: "t1", prompt: "one", startedAt: FIXTURE_START },
      { id: "t2", prompt: "two", startedAt: FIXTURE_START + 2000 },
    ];
    const clean = answerOwner(file(lines(...real)), "a", turns);
    expect(clean).toBe("t1");
    for (const j of junk)
      expect(
        answerOwner(file(lines(real[0] as string, j, real[1] as string, j, ...real.slice(2))), "a", turns),
      ).toBe(clean);
  });

  test("interruptedTurn ignores such a line", () => {
    const since = FIXTURE_START + 2000;
    const clean = interruptedTurn(file(lines(...real)), since, undefined, null, "two");
    for (const j of junk)
      expect(
        interruptedTurn(file(lines(real[0] as string, j, ...real.slice(1))), since, undefined, null, "two"),
      ).toEqual(clean);
  });

  test("null, numbers, arrays, strings and booleans are skipped like bad lines", () => {
    for (const odd of ["null", "42", "[]", '"s"', "true"]) {
      const file = join(scratch(), "s.jsonl");
      writeFileSync(
        file,
        [user(0, "hi"), odd, assistant(1, [{ type: "text", text: "yo" }])].join("\n") + "\n",
      );
      expect(transcriptTurns("s", file, { limit: 5, previewChars: 100, working: false })).toHaveLength(1);
    }
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type RelayEvent, TURN_STEP_OUTPUT_LINES, type Turn, TurnStep } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages } from "../src/daemon/messages.ts";
import { alertFor, apnsPayload, fcmMessage, fitAlert } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { turnFromTranscript } from "../src/daemon/render.ts";
import { createRpc, type RpcDeps, type RpcOpts } from "../src/daemon/rpc.ts";
import { SAVED_OUTPUT_TAIL_BYTES, savedOutputEnd } from "../src/daemon/savedOutput.ts";
import { StepTracker } from "../src/daemon/steps.ts";
import { TimelineReader } from "../src/daemon/timeline.ts";
import { formatEvent } from "../src/tailFormat.ts";

// A very long output: the transcript holds only its start and names the file Claude Code saved all of it in.
// The step carries the end of that file, read without loading it, and only from the session's own folder.

const CWD = "/Users/me/Projects/my-app";
const MARKER = "MARKER_SAVED_TEXT";
const START = "START_OF_THE_OUTPUT";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyzTAILMARK99";
const ESC = "\x1b";
const PHONE: RpcOpts = { overRelay: true, pieces: true };

const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A session's transcript `t.jsonl` and its folder of saved outputs, as Claude Code lays them out. */
function session() {
  const dir = mkdtempSync(join(tmpdir(), "relay-saved-output-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const results = join(dir, "t", "tool-results");
  mkdirSync(results, { recursive: true });
  const save = (name: string, content: string | Uint8Array) => {
    writeFileSync(join(results, name), content);
    return join(results, name);
  };
  return { dir, transcript, results, save };
}

const iso = (at: number) => new Date(at).toISOString();
const bash = (id: string, at: number, command = "bun test") => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
/** A command whose output Claude Code cut: the result's text is a wrapper, `stdout` the output's start. */
const saved = (id: string, at: number, file: unknown, more: object = {}) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: iso(at),
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        is_error: false,
        content: `<persisted-output>\nOutput too large (48KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${START}\n...\n</persisted-output>`,
      },
    ],
  },
  toolUseResult: {
    stdout: `${START}\nline 2`,
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    persistedOutputPath: file,
    persistedOutputSize: 48_000,
    ...more,
  },
});
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const long = (end = MARKER) => `${START}\n${numbered(4000).join("\n")}\n${end}\n`;

/** What a reader makes of one command whose result names `file`. */
async function read(transcript: string, file: unknown, id = "b", more: object = {}) {
  const reader = new TimelineReader(CWD, 0, { transcriptPath: transcript });
  reader.add(bash(id, 1000));
  const first = reader.add(saved(id, 2000, file, more));
  const changed = await reader.readSavedOutputs();
  return { step: reader.actions[0] as TurnStep, first, changed };
}

describe("the end of the file", () => {
  test("is what the step carries, always as a cut output, and never the start", async () => {
    const s = session();
    const { step, first, changed } = await read(s.transcript, s.save("abc123def.txt", long()));
    expect(first).toEqual([]);
    expect(changed).toEqual([step]);
    expect(step.output?.split("\n")).toEqual([
      ...numbered(4000).slice(-(TURN_STEP_OUTPUT_LINES - 1)),
      MARKER,
    ]);
    expect(step.outputCut).toBe(true);
    expect(step.output).not.toContain(START);
    expect(TurnStep.safeParse(step).success).toBe(true);
  });

  test("a file shorter than the cap is still a cut output: the phone shows that lines came before", async () => {
    const s = session();
    const { step } = await read(s.transcript, s.save("abc123def.txt", "one\ntwo\r\nthree\n"));
    expect(step).toMatchObject({ output: "one\ntwo\nthree", outputCut: true });
  });

  test("only the last 64 KiB are read, from the start of a line", async () => {
    const s = session();
    const lines = Array.from({ length: 9000 }, (_, i) => `entry ${String(i).padStart(6, "0")} ok`);
    const file = s.save("abc123def.txt", `${lines.join("\n")}\n`);
    const end = (await savedOutputEnd(s.transcript, file)) as string;
    expect(Buffer.byteLength(end)).toBeLessThanOrEqual(SAVED_OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(end)).toBeGreaterThan(SAVED_OUTPUT_TAIL_BYTES - 40);
    expect(end.startsWith("entry 00")).toBe(true);
    expect(end.endsWith("entry 008999 ok\n")).toBe(true);
  });

  test("a 500 MB file is read in milliseconds", async () => {
    const s = session();
    const file = join(s.results, "abc123def.txt");
    const size = 500 * 1024 * 1024;
    const tail = `\n${numbered(30).join("\n")}\n${MARKER}\n`;
    const fd = openSync(file, "w");
    // Sparse: only the end is written.
    ftruncateSync(fd, size);
    writeSync(fd, tail, size - tail.length);
    closeSync(fd);
    const started = performance.now();
    const { step } = await read(s.transcript, file);
    expect(performance.now() - started).toBeLessThan(500);
    expect(step.output?.endsWith(`line 30\n${MARKER}`)).toBe(true);
    expect(step.output?.split("\n")).toHaveLength(TURN_STEP_OUTPUT_LINES);
  });

  test("content that looks binary leaves only what can be shown", async () => {
    const s = session();
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i % 97 === 0 ? 10 : (i * 37) % 256));
    const { step } = await read(s.transcript, s.save("abc123def.txt", bytes));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must be gone
    expect(step.output ?? "").not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(TurnStep.safeParse(step).success).toBe(true);
    const nulls = await read(s.transcript, s.save("nulls0000.txt", new Uint8Array(100_000)), "n");
    expect(nulls.step.output).toBeUndefined();
  });
});

describe("secrets", () => {
  test("a secret in the end of the file is redacted", async () => {
    const s = session();
    const file = s.save(
      "abc123def.txt",
      long(`GITHUB_TOKEN=${TOKEN}\nAuthorization: Bearer abc123def456ghi789`),
    );
    const { step } = await read(s.transcript, file);
    expect(step.output).toContain("[redacted:");
    expect(step.output).not.toContain("TAILMARK");
    expect(step.output).not.toContain("abc123def456ghi789");
  });

  test("a secret that starts before the part read leaves nothing of itself", async () => {
    const s = session();
    // After the token only colour codes, which cleaning removes: the token's line would be among the last ones.
    const after = `\n${`${ESC}[0m`.repeat(15_000)}\ndone\n`;
    for (const inside of [8, 20, TOKEN.length - 1]) {
      const end = `${TOKEN.slice(-inside)}${after}`;
      const head = `${"x".repeat(SAVED_OUTPUT_TAIL_BYTES)}\nGITHUB_TOKEN=${TOKEN.slice(0, -inside)}`;
      const file = s.save("abc123def.txt", `${head}${end.padEnd(SAVED_OUTPUT_TAIL_BYTES, "\n")}`);
      const { step } = await read(s.transcript, file, `half-${inside}`);
      expect([inside, step.output?.trim()]).toEqual([inside, "done"]);
    }
  });

  test("a private key that starts before the part read leaves nothing of itself", async () => {
    const s = session();
    const mark = (word: string) => `-----${word} PRIVATE KEY-----`;
    const key = `${mark("BEGIN")}\n${"KEYBODY".repeat(9)}\n`;
    const body = `${`${"KEYBODY".repeat(9)}\n`.repeat(12)}KEYTAIL\n${mark("END")}\n`;
    const end = `${body}${`${ESC}[0m`.repeat(15_000)}\nok\n`.padEnd(SAVED_OUTPUT_TAIL_BYTES - 5, "\n");
    const file = s.save("abc123def.txt", `${"x\n".repeat(40_000)}${key}${end}`);
    const { step } = await read(s.transcript, file);
    expect(step.output?.trim()).toBe("ok");
  });

  test("one line longer than the part read sends nothing: its start, and a secret's, was not seen", async () => {
    const s = session();
    const file = s.save("abc123def.txt", `{"apiKey":"${"k".repeat(200_000)}","done":true}`);
    expect(await savedOutputEnd(s.transcript, file)).toBeNull();
    expect((await read(s.transcript, file)).step.output).toBeUndefined();
  });
});

describe("which files are read", () => {
  const nothing = async (transcript: string, file: unknown, id: string) => {
    const { step, changed } = await read(transcript, file, id);
    expect([id, step.output, step.outputCut, changed]).toEqual([id, undefined, undefined, []]);
  };

  test("only a file in the session's own folder of saved outputs", async () => {
    const s = session();
    const other = session();
    const inside = s.save("abc123def.txt", long());
    const outside = join(s.dir, "secret.txt");
    writeFileSync(outside, long());
    mkdirSync(join(s.dir, "u", "tool-results"), { recursive: true });
    writeFileSync(join(s.dir, "u", "tool-results", "abc123def.txt"), long());
    mkdirSync(join(s.results, "deeper"));
    writeFileSync(join(s.results, "deeper", "abc123def.txt"), long());
    s.save("abc123def.log", long());

    await nothing(s.transcript, outside, "outside");
    await nothing(s.transcript, other.save("abc123def.txt", long()), "another-folder");
    await nothing(s.transcript, join(s.dir, "u", "tool-results", "abc123def.txt"), "another-session");
    await nothing(s.transcript, join(s.results, "deeper", "abc123def.txt"), "deeper");
    await nothing(s.transcript, join(s.results, "abc123def.log"), "not-text");
    await nothing(s.transcript, relative(process.cwd(), inside), "relative");
    await nothing(s.transcript, "abc123def.txt", "bare-name");
    await nothing(s.transcript, `${s.results}/deeper/../abc123def.txt`, "dots");
    await nothing(s.transcript, `${s.results}/../tool-results/abc123def.txt`, "dots-back-inside");
    await nothing(s.transcript, `${s.results}/../../secret.txt`, "dots-out");
    await nothing(s.transcript, "/etc/hosts", "system-file");
    await nothing(s.transcript, "", "empty-path");
    for (const [i, value] of [null, 7, true, {}, [inside]].entries())
      await nothing(s.transcript, value, `type-${i}`);
    expect((await read(s.transcript, inside, "inside")).step.output).toContain(MARKER);
  });

  test("a symlink is followed first: one that leaves the folder sends nothing", async () => {
    const s = session();
    const outside = join(s.dir, "secret.txt");
    writeFileSync(outside, long());
    symlinkSync(outside, join(s.results, "link00000.txt"));
    symlinkSync("/etc/hosts", join(s.results, "hosts0000.txt"));
    symlinkSync("/dev/zero", join(s.results, "zero00000.txt"));
    symlinkSync(join(s.results, "gone.txt"), join(s.results, "dangling0.txt"));
    for (const name of ["link00000.txt", "hosts0000.txt", "zero00000.txt", "dangling0.txt"])
      expect([name, await savedOutputEnd(s.transcript, join(s.results, name))]).toEqual([name, null]);

    // The folder itself, or the session's, as a link to somewhere else.
    const linked = session();
    rmSync(linked.results, { recursive: true });
    const elsewhere = join(linked.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "abc123def.txt"), long());
    symlinkSync(elsewhere, linked.results);
    expect(await savedOutputEnd(linked.transcript, join(linked.results, "abc123def.txt"))).toBeNull();
    rmSync(join(linked.dir, "t"), { recursive: true });
    mkdirSync(join(elsewhere, "tool-results"));
    writeFileSync(join(elsewhere, "tool-results", "abc123def.txt"), long());
    symlinkSync(elsewhere, join(linked.dir, "t"));
    expect(await savedOutputEnd(linked.transcript, join(linked.results, "abc123def.txt"))).toBeNull();

    // A link that stays in the folder names a file that may be read.
    s.save("abc123def.txt", long());
    symlinkSync(join(s.results, "abc123def.txt"), join(s.results, "same00000.txt"));
    expect(await savedOutputEnd(s.transcript, join(s.results, "same00000.txt"))).toContain(MARKER);
  });

  test("the transcript's folder may itself be reached through a link", async () => {
    const s = session();
    s.save("abc123def.txt", long());
    const alias = join(s.dir, "alias");
    symlinkSync(s.dir, alias);
    const end = await savedOutputEnd(
      join(alias, "t.jsonl"),
      join(alias, "t", "tool-results", "abc123def.txt"),
    );
    expect(end).toContain(MARKER);
  });

  test("a folder, a socket or a pipe with a file's name sends nothing, and doesn't hold the helper", async () => {
    const s = session();
    mkdirSync(join(s.results, "folder000.txt"));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(s.results, "s.txt"), resolve));
    // Where the tool to make one is missing, the socket stands for every file that isn't a regular one.
    const pipe = Bun.which("mkfifo") !== null;
    if (pipe) execFileSync("mkfifo", [join(s.results, "pipe00000.txt")]);
    try {
      expect(lstatSync(join(s.results, "s.txt")).isSocket()).toBe(true);
      const started = performance.now();
      expect(await savedOutputEnd(s.transcript, join(s.results, "folder000.txt"))).toBeNull();
      expect(await savedOutputEnd(s.transcript, join(s.results, "s.txt"))).toBeNull();
      if (pipe) expect(await savedOutputEnd(s.transcript, join(s.results, "pipe00000.txt"))).toBeNull();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      server.close();
    }
  });

  test("a result that isn't an ended command's own is never looked up", async () => {
    const s = session();
    const file = s.save("abc123def.txt", long());
    const reader = new TimelineReader(CWD, 0, { transcriptPath: s.transcript });
    const use = (id: string, name: string, input: object) => ({
      type: "assistant",
      uuid: `a-${id}`,
      timestamp: iso(1000),
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
    reader.add(use("r", "Read", { file_path: "/x/notes.md" }));
    reader.add(saved("r", 1100, file));
    reader.add(bash("bg", 1200));
    reader.add(saved("bg", 1300, file, { backgroundTaskId: "task1" }));
    reader.add(bash("img", 1400));
    reader.add(saved("img", 1500, file, { isImage: true }));
    reader.add(bash("err", 1600));
    const failed = saved("err", 1700, file);
    (failed.message.content[0] as { is_error: boolean }).is_error = true;
    reader.add(failed);
    reader.add(bash("two", 1800));
    const two = saved("two", 1900, file);
    two.message.content.push({ ...two.message.content[0], tool_use_id: "other" } as never);
    reader.add(two);
    expect(reader.hasUnreadOutputs).toBe(false);
    expect(await reader.readSavedOutputs()).toEqual([]);
    expect(JSON.stringify(reader.actions)).not.toContain(MARKER);

    const agent = new TimelineReader(CWD, 0, { transcriptPath: s.transcript, sidechain: true });
    agent.add(bash("sub", 1000));
    agent.add(saved("sub", 1100, file));
    expect(agent.hasUnreadOutputs).toBe(false);
    const noTranscript = new TimelineReader(CWD, 0);
    noTranscript.add(bash("b", 1000));
    noTranscript.add(saved("b", 1100, file));
    expect(noTranscript.hasUnreadOutputs).toBe(false);
  });
});

describe("a file that can't be read", () => {
  test("missing, empty or unreadable: the step has no output and nothing is logged", async () => {
    const written: string[] = [];
    const record = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const spies = [
      spyOn(process.stderr, "write").mockImplementation(record),
      spyOn(process.stdout, "write").mockImplementation(record),
    ];
    try {
      const s = session();
      expect(
        (await read(s.transcript, join(s.results, "gone00000.txt"), "gone")).step.output,
      ).toBeUndefined();
      expect((await read(s.transcript, s.save("empty0000.txt", ""), "empty")).step.output).toBeUndefined();
      expect(
        (await read(s.transcript, s.save("blank0000.txt", " \n\n\t\n"), "blank")).step.output,
      ).toBeUndefined();
      const locked = s.save("locked000.txt", long());
      chmodSync(locked, 0o000);
      const { step } = await read(s.transcript, locked, "locked");
      // An administrator reads any file.
      if (process.getuid?.() !== 0) expect(step.output).toBeUndefined();
      rmSync(join(s.dir, "t"), { recursive: true });
      expect(
        (await read(s.transcript, join(s.results, "abc123def.txt"), "no-folder")).step.output,
      ).toBeUndefined();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join("")).toBe("");
  });

  test("a file cut short or deleted while it is read ends the read without an error", async () => {
    const s = session();
    const file = s.save("abc123def.txt", long());
    const reads = Array.from({ length: 12 }, () => savedOutputEnd(s.transcript, file));
    truncateSync(file, 7);
    const later = Array.from({ length: 12 }, () => savedOutputEnd(s.transcript, file));
    rmSync(file);
    const last = Array.from({ length: 12 }, () => savedOutputEnd(s.transcript, file));
    for (const end of await Promise.all([...reads, ...later, ...last]))
      expect(end === null || typeof end === "string").toBe(true);
    expect(await savedOutputEnd(s.transcript, file)).toBeNull();
  });
});

function setup() {
  const s = session();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: 0 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: {
          hook_event_name: event,
          session_id: "s1",
          cwd: CWD,
          transcript_path: s.transcript,
          ...fields,
        },
        env: {},
      },
      new AbortController().signal,
    );
  const append = (...lines: object[]) =>
    appendFileSync(s.transcript, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const actions = () => seen.flatMap((e) => (e.type === "turn.action" ? [e] : []));
  const done = () =>
    seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>;
  const liveActions = async () => {
    const live = await rpc("session.live", { sessionId: "s1" }, "device:x", PHONE);
    return ("result" in live ? (live.result as { actions?: TurnStep[] } | null)?.actions : undefined) ?? [];
  };
  const storedTurn = async () => {
    const res = await rpc("session.turns", { sessionId: "s1", limit: 5 }, "device:x", PHONE);
    return "result" in res ? (res.result as Turn[])[0] : undefined;
  };
  const tool = { tool_use_id: "b", tool_name: "Bash", tool_input: { command: "bun test" } };
  /** A turn whose one command printed more than a transcript holds; the live read has finished. */
  const ran = async (content = long()) => {
    const file = s.save("abc123def.txt", content);
    await hook("UserPromptSubmit", { prompt: "Test it" });
    const at = Date.now();
    append(bash("b", at + 100));
    await hook("PreToolUse", tool);
    append(saved("b", at + 200, file));
    await hook("PostToolUse", tool);
    await messages.outputsRead("s1");
    return file;
  };
  return { ...s, hook, append, actions, done, liveActions, storedTurn, seen, messages, ran, tool };
}

const outputOf = (s: TurnStep | undefined) => ({ output: s?.output, outputCut: s?.outputCut });

describe("live and finished", () => {
  test("the step is sent again with the same id once the file is read, and every copy agrees", async () => {
    const t = setup();
    await t.ran();
    const sent = t.actions().filter((e) => e.step.id === "b");
    expect(sent.map((e) => e.step.output === undefined)).toEqual([true, false]);
    const live = outputOf(sent[1]?.step);
    expect(live.output?.endsWith(`line 4000\n${MARKER}`)).toBe(true);
    expect(live.outputCut).toBe(true);
    expect(outputOf((await t.liveActions()).find((x) => x.id === "b"))).toEqual(live);
    await t.hook("Stop", { last_assistant_message: "The tests pass." });
    expect(t.actions().filter((e) => e.step.id === "b")).toHaveLength(2);
    expect(outputOf(t.done().turn.steps?.find((x) => x.id === "b"))).toEqual(live);
    expect(outputOf((await t.storedTurn())?.steps?.find((x) => x.id === "b"))).toEqual(live);
  });

  test("a file deleted or rewritten after the live read: the finished turn keeps what was sent live", async () => {
    for (const change of ["deleted", "rewritten"]) {
      const t = setup();
      const file = await t.ran();
      const live = outputOf((await t.liveActions()).find((x) => x.id === "b"));
      if (change === "deleted") rmSync(file);
      else writeFileSync(file, "something else\n");
      await t.hook("Stop", { last_assistant_message: "The tests pass." });
      expect(live.output).toContain(MARKER);
      expect([change, outputOf(t.done().turn.steps?.find((x) => x.id === "b"))]).toEqual([change, live]);
      expect(outputOf((await t.storedTurn())?.steps?.find((x) => x.id === "b"))).toEqual(live);
    }
  });

  test("a file that was missing while the turn ran stays without output in the finished turn", async () => {
    const u = setup();
    await u.hook("UserPromptSubmit", { prompt: "Test it" });
    const at = Date.now();
    u.append(bash("b", at + 100), saved("b", at + 200, join(u.results, "abc123def.txt")));
    await u.hook("PostToolUse", u.tool);
    await u.messages.outputsRead("s1");
    u.save("abc123def.txt", long());
    await u.hook("Stop", { last_assistant_message: "Done." });
    expect(u.actions().filter((e) => e.step.id === "b")).toHaveLength(1);
    expect(outputOf(u.done().turn.steps?.find((x) => x.id === "b"))).toEqual(outputOf(undefined));
  });

  test("the turn ends before the result was seen live: it is read before the turn is announced", async () => {
    const t = setup();
    const file = t.save("abc123def.txt", long());
    await t.hook("UserPromptSubmit", { prompt: "Test it" });
    const at = Date.now();
    t.append(bash("b", at + 100));
    await t.hook("PreToolUse", t.tool);
    t.append(saved("b", at + 200, file));
    await t.hook("Stop", { last_assistant_message: "The tests pass." });
    const finished = outputOf(t.done().turn.steps?.find((x) => x.id === "b"));
    expect(finished.output?.endsWith(MARKER)).toBe(true);
    expect(finished.outputCut).toBe(true);
    const sent = t.actions().filter((e) => e.step.id === "b");
    expect(outputOf(sent.at(-1)?.step)).toEqual(finished);
    expect(t.seen.indexOf(sent.at(-1) as RelayEvent)).toBeLessThan(t.seen.indexOf(t.done()));
  });

  test("a turn built from the transcript alone, never followed while it ran, has no output for it", async () => {
    const s = session();
    const file = s.save("abc123def.txt", long());
    const at = Date.now();
    appendFileSync(
      s.transcript,
      [
        { type: "user", uuid: "p", timestamp: iso(at), message: { content: "Test it" } },
        bash("b", at + 100),
        saved("b", at + 200, file),
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join(""),
    );
    const built = turnFromTranscript(s.transcript, at, CWD);
    expect(built?.steps.map((x) => [x.id, x.output])).toEqual([["b", undefined]]);
  });
});

describe("where the saved output never goes", () => {
  async function flow() {
    const t = setup();
    await t.ran();
    await t.liveActions();
    await t.hook("Stop", { last_assistant_message: "The tests pass." });
    return t;
  }

  test("the flow under test does send the marker to the phone", async () => {
    const t = await flow();
    expect(t.actions().filter((e) => e.step.output?.includes(MARKER))).toHaveLength(1);
    expect(t.done().turn.steps?.filter((x) => x.output?.includes(MARKER))).toHaveLength(1);
  });

  test("no push notification carries it, plain or as the text the phone's extension opens", async () => {
    const t = await flow();
    const sent = t.seen.map((e) => alertFor(e, () => "my-app")).filter((a) => a !== null);
    expect(sent.map((a) => a.category)).toContain("DONE");
    for (const alert of sent) {
      const sealed = fitAlert(alert);
      const payloads = [
        alert,
        { title: sealed.title, body: sealed.body, data: sealed.data },
        apnsPayload(alert),
        fcmMessage(alert),
      ];
      expect(JSON.stringify(payloads)).not.toContain(MARKER);
    }
  });

  test("`relay tail` prints the step's line without any of it, or of the file's path", async () => {
    const t = await flow();
    const printed = t.seen.map(formatEvent).join("\n");
    expect(printed).toContain("Ran bun test");
    expect(printed).not.toContain(MARKER);
    expect(printed).not.toContain("tool-results");
  });

  test("no log line carries it", async () => {
    const written: string[] = [];
    const record = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const spies = [
      spyOn(process.stderr, "write").mockImplementation(record),
      spyOn(process.stdout, "write").mockImplementation(record),
    ];
    try {
      const t = await flow();
      expect(JSON.stringify(t.seen)).toContain(MARKER);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join("")).not.toContain(MARKER);
  });

  test("the file's path is not sent to the phone", async () => {
    const t = await flow();
    expect(JSON.stringify(t.seen)).not.toContain("tool-results");
    expect(JSON.stringify(t.seen)).not.toContain(START);
  });
});

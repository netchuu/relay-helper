import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Turn } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler, notePhoneTyped, phoneTypeDelivered } from "../src/daemon/hooks.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

// A slash command Claude Code runs itself (no model, no prompt hook) answers the phone as a turn of its own.

const CWD = "/tmp/relay-command-turns";
const dirs: string[] = [];
afterEach(() => {
  resetLiveSteps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let setups = 0;

function setup(before: (write: (entry: Record<string, unknown>) => void) => void = () => {}, root?: string) {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  let localActivity = 0;
  const presence = {
    noteLocalActivity() {
      localActivity++;
    },
    get: () => ({ mode: "auto", away: false }),
  } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  hooks.commandGraceMs = 0;
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const dir = root ?? mkdtempSync(join(tmpdir(), "relay-command-turns-"));
  if (!root) dirs.push(dir);
  const transcript = join(dir, "session.jsonl");
  const lines: string[] = [];
  const id = ++setups;
  let n = 0;
  const write = (entry: Record<string, unknown>) => {
    n += 1;
    lines.push(
      JSON.stringify({ uuid: `u${id}-${n}`, timestamp: new Date(1_000_000 + n).toISOString(), ...entry }),
    );
    writeFileSync(transcript, `${lines.join("\n")}\n`);
  };
  before(write);
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
      new AbortController().signal,
    );
  return {
    hook,
    hooks,
    registry,
    transcript,
    seen,
    localActivity: () => localActivity,
    started: () => seen.flatMap((e) => (e.type === "turn.started" ? [e] : [])),
    done: () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : [])),
    turns: async () => {
      const res = await rpc("session.turns" as never, { sessionId: "s1", limit: 10 } as never, "device:x");
      if (!("result" in res)) throw new Error(JSON.stringify(res));
      return res.result as Turn[];
    },
    echo: (name: string, args = "") =>
      write({
        type: "user",
        message: {
          content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
        },
      }),
    printed: (text: string) =>
      write({ type: "user", message: { content: `<local-command-stdout>${text}</local-command-stdout>` } }),
    systemEcho: (name: string) =>
      write({
        type: "system",
        subtype: "local_command",
        content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>`,
      }),
    systemPrinted: (text: string) =>
      write({
        type: "system",
        subtype: "local_command",
        content: `<local-command-stdout>${text}</local-command-stdout>`,
      }),
    promptEcho: (name: string) =>
      write({
        type: "user",
        message: {
          content: `<command-message>${name} is running…</command-message>\n<command-name>/${name}</command-name>`,
        },
      }),
    prompt: (text: string) => write({ type: "user", message: { role: "user", content: text } }),
    says: (text: string) => write({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  };
}

describe("local slash commands", () => {
  test("an echo and its output make a started and a done turn for the phone's send", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/context", false, "send-1");
    t.echo("context");
    t.printed("Context: 41k of 200k tokens used (20%)");
    await t.hook("Notification");

    expect(t.started()).toMatchObject([{ prompt: "/context", sendId: "send-1" }]);
    const [turn] = t.done();
    expect(turn).toMatchObject({
      prompt: "/context",
      summary: "Context: 41k of 200k tokens used (20%)",
      command: { name: "context" },
      failed: false,
    });
    expect(t.done()).toHaveLength(1);
    expect(t.started()[0]?.turnId).toBe(turn?.id);
  });

  test("Claude Code's system local_command entries make the turn too", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/context", false, "send-sys");
    t.systemEcho("context");
    t.systemPrinted("Context: 10k of 200k tokens used");
    await t.hook("Notification");
    expect(t.started()).toMatchObject([{ prompt: "/context", sendId: "send-sys" }]);
    expect(t.done()[0]).toMatchObject({
      summary: "Context: 10k of 200k tokens used",
      command: { name: "context" },
    });
  });

  test("a command noted after the session's cursor was lost is still found", async () => {
    const t = setup();
    await t.hook("SessionStart");
    (t.hooks as unknown as { localCommands: { forget(id: string): void } }).localCommands.forget("s1");
    notePhoneTyped("s1", "/context", false, "send-3");
    t.echo("context");
    t.printed("Context: 5k");
    await t.hook("Notification");
    expect(t.started()).toMatchObject([{ prompt: "/context", sendId: "send-3" }]);
  });

  test("a hook's symlinked transcript path and the real one share a cursor", async () => {
    const t = setup();
    await t.hook("SessionStart");
    const link = `${t.transcript}.link`;
    symlinkSync(t.transcript, link);
    await t.hook("Notification", { transcript_path: link });
    notePhoneTyped("s1", "/context", false, "send-4");
    t.echo("context");
    t.printed("Context: 7k");
    await t.hook("Notification", { transcript_path: t.transcript });
    expect(t.started()).toMatchObject([{ sendId: "send-4" }]);
  });

  test("a command that printed nothing says it ran, with its arguments", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/color blue", false, "send-2");
    t.echo("color", "blue");
    await t.hook("Notification");
    expect(t.started()[0]?.sendId).toBe("send-2");
    expect(t.done()[0]).toMatchObject({
      summary: "Ran /color blue",
      command: { name: "color", args: "blue" },
    });
  });

  test("a command typed at the Mac shows too, with no sendId", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.echo("context");
    t.printed("Context: 10k of 200k tokens used (5%)");
    await t.hook("Notification");
    expect(t.started()).toHaveLength(1);
    expect(t.started()[0]?.sendId).toBeUndefined();
    expect(t.done()[0]?.command).toEqual({ name: "context" });
    expect(t.localActivity()).toBe(1);
  });

  test("the pair is not split when the output is written after the first look", async () => {
    const t = setup();
    t.hooks.commandGraceMs = 60_000;
    await t.hook("SessionStart");
    t.echo("context");
    await t.hook("Notification");
    expect(t.done()).toHaveLength(0);
    t.printed("Context: 1k");
    await t.hook("Notification");
    expect(t.done().map((x) => x.summary)).toEqual(["Context: 1k"]);
  });

  test("the output keeps its last lines and is redacted", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.echo("context");
    t.printed(
      `${Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n")}\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
    );
    await t.hook("Notification");
    const summary = t.done()[0]?.summary ?? "";
    expect(summary.split("\n").length).toBeLessThanOrEqual(20);
    expect(summary).toContain("row 39");
    expect(summary).not.toContain("row 0\n");
    expect(summary).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("no done push for it", () => {
    const turn = { sessionId: "s1", summary: "Context: 1k", command: { name: "context" } } as unknown as Turn;
    expect(alertFor({ type: "turn.done", turn } as RelayEvent, () => "chat")).toBeNull();
    const model = { sessionId: "s1", summary: "Done." } as unknown as Turn;
    expect(alertFor({ type: "turn.done", turn: model } as RelayEvent, () => "chat")).not.toBeNull();
  });

  test("the arguments are redacted in the event and the history", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.echo("rename", "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    await t.hook("Notification");
    const [done] = t.done();
    expect(done?.prompt).toBe("/rename [redacted:github-token]");
    expect(done?.command?.args).toBe("[redacted:github-token]");
    const [stored] = await t.turns();
    expect(stored?.command?.args).toBe("[redacted:github-token]");
    expect(JSON.stringify([done, stored])).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("a phone send is found by the scan alone, with no hook after it", async () => {
    const home = mkdtempSync(join(tmpdir(), "relay-command-home-"));
    dirs.push(home);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const projects = join(home, ".claude", "projects", "p");
      mkdirSync(projects, { recursive: true });
      const t = setup(undefined, projects);
      await t.hook("SessionStart");
      notePhoneTyped("s1", "/color blue", false, "send-scan");
      t.echo("color", "blue");
      expect(t.hooks.pendingSlashSessions()).toContain("s1");
      t.hooks.scanCommands("s1");
      expect(t.started()).toMatchObject([{ prompt: "/color blue", sendId: "send-scan" }]);
      expect(t.hooks.pendingSlashSessions()).not.toContain("s1");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  test("the command is kept in the history", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.echo("color", "blue");
    await t.hook("Notification");
    const [turn] = await t.turns();
    expect(turn).toMatchObject({
      prompt: "/color blue",
      summary: "Ran /color blue",
      command: { name: "color", args: "blue" },
    });
  });

  test("a command already in the transcript when the helper looks first is not replayed", async () => {
    const t = setup((write) => {
      write({
        type: "user",
        message: { content: "<command-name>/context</command-name>\n<command-args></command-args>" },
      });
      write({ type: "user", message: { content: "<local-command-stdout>old</local-command-stdout>" } });
    });
    await t.hook("SessionStart");
    await t.hook("Notification");
    expect(t.started()).toHaveLength(0);
  });

  test("inside a running turn it stays a step of that turn", async () => {
    const t = setup();
    await t.hook("SessionStart");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.prompt("go");
    t.echo("context");
    t.printed("Context: 1k");
    await t.hook("Notification");
    t.says("Done.");
    await t.hook("Stop", { last_assistant_message: "Done." });
    expect(t.started()).toHaveLength(1);
    expect(t.done()).toHaveLength(1);
    expect(t.done()[0]?.command).toBeUndefined();
    expect(t.done()[0]?.steps?.map((s) => s.detail)).toEqual(["/context"]);
  });

  test("a prompt command's echo, which starts with its message, is not a local command", async () => {
    const t = setup();
    t.hooks.commandGraceMs = 60_000;
    await t.hook("SessionStart");
    t.promptEcho("review");
    await t.hook("UserPromptSubmit", { prompt: "/review" });
    t.says("Looks fine.");
    await t.hook("Stop", { last_assistant_message: "Looks fine." });
    expect(t.started()).toHaveLength(1);
    expect(t.done().map((x) => [x.summary, x.command])).toEqual([["Looks fine.", undefined]]);
  });

  test("a silent command still held when the next prompt arrives is a turn before it", async () => {
    const t = setup();
    t.hooks.commandGraceMs = 60_000;
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/color blue", false, "send-c");
    t.echo("color", "blue");
    t.hooks.scanCommands("s1");
    expect(t.started()).toHaveLength(0);
    t.prompt("hello");
    await t.hook("UserPromptSubmit", { prompt: "hello" });
    t.says("Hi.");
    await t.hook("Stop", { last_assistant_message: "Hi." });
    expect(t.started().map((x) => [x.prompt, x.sendId])).toEqual([
      ["/color blue", "send-c"],
      ["hello", undefined],
    ]);
    expect(t.done().map((x) => x.command?.name)).toEqual(["color", undefined]);
  });

  test("a silent command read inside a turn that ends before its grace is not shown again", async () => {
    const t = setup();
    t.hooks.commandGraceMs = 30;
    await t.hook("SessionStart");
    await t.hook("UserPromptSubmit", { prompt: "go" });
    t.prompt("go");
    t.echo("color", "red");
    await t.hook("Notification");
    t.says("Done.");
    await t.hook("Stop", { last_assistant_message: "Done." });
    await Bun.sleep(60);
    await t.hook("Notification");
    expect(t.started()).toHaveLength(1);
    expect(t.done()).toHaveLength(1);
    expect(t.done()[0]?.steps?.map((s) => s.detail)).toEqual(["/color red"]);
  });

  test("`/compact` and the commands that end a chat are not command turns", async () => {
    const t = setup();
    await t.hook("SessionStart");
    for (const name of ["compact", "exit", "clear"]) {
      t.echo(name);
      t.printed("Bye");
    }
    await t.hook("Notification");
    expect(t.started()).toHaveLength(0);
  });

  test("a phone /exit gets its command turn before the session ends", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/exit", true, "send-x");
    await t.hook("SessionEnd", { reason: "prompt_input_exit" });
    phoneTypeDelivered("s1", "/exit");
    expect(t.started()).toMatchObject([{ prompt: "/exit", sendId: "send-x" }]);
    expect(t.done()).toMatchObject([{ summary: "Claude Code was quit.", command: { name: "exit" } }]);
    const kinds = t.seen.map((e) => e.type);
    expect(kinds.indexOf("turn.done")).toBeLessThan(kinds.lastIndexOf("session.upsert"));
    expect(t.seen.filter((e) => e.type === "reply.outcome")).toHaveLength(0);
  });

  test("a phone /clear gets its command turn on the old session", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/clear", true, "send-c");
    await t.hook("SessionEnd", { reason: "clear" });
    phoneTypeDelivered("s1", "/clear");
    expect(t.started()).toMatchObject([{ sessionId: "s1", sendId: "send-c" }]);
    expect(t.done()).toMatchObject([
      { summary: "Cleared. The conversation continues in a new chat.", command: { name: "clear" } },
    ]);
  });

  test("a message pending behind /exit is lost", async () => {
    const t = setup();
    await t.hook("SessionStart");
    notePhoneTyped("s1", "/exit", false, "send-x");
    notePhoneTyped("s1", "hello", false, "send-h", true);
    await t.hook("SessionEnd", { reason: "prompt_input_exit" });
    expect(t.seen.filter((e) => e.type === "reply.outcome")).toMatchObject([
      { sessionId: "s1", sendId: "send-h", outcome: "lost" },
    ]);
    expect(t.started()).toHaveLength(1);
  });

  test("an exit nobody sent from the phone makes no command turn", async () => {
    const t = setup();
    await t.hook("SessionStart");
    await t.hook("SessionEnd", { reason: "prompt_input_exit" });
    expect(t.started()).toHaveLength(0);
  });

  test("a model turn after a command does not show it a second time", async () => {
    const t = setup();
    await t.hook("SessionStart");
    t.echo("context");
    t.printed("Context: 1k");
    await t.hook("Notification");
    t.prompt("hello");
    await t.hook("UserPromptSubmit", { prompt: "hello" });
    t.says("Hi.");
    await t.hook("Stop", { last_assistant_message: "Hi." });
    const model = t.done().find((x) => !x.command);
    expect(model?.steps).toBeUndefined();
  });
});

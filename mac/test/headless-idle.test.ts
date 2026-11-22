import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { BackgroundTracker, resetBackground } from "../src/daemon/background.ts";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeadlessSessions } from "../src/daemon/headless.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { waitFor } from "./support/wait.ts";

// A chat the helper continues is stopped after an hour with nothing going on, and stays in the phone's list.

const root = mkdtempSync(join(tmpdir(), "relay-headless-idle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => resetBackground());
const ID = "5c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";
const HOUR = 60 * 60_000;

/** Stands in for `claude -p --resume`: names each message, then prints the lines of a file `emit` when there is one. */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const here = import.meta.dir;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "x" });
let buf = "";
for await (const chunk of process.stdin) {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    appendFileSync(here + "/stdin.log", line + "\\n");
    const m = JSON.parse(line);
    if (m.type === "user") {
      out({ type: "user", uuid: m.uuid, message: m.message });
      if (existsSync(here + "/emit")) for (const l of readFileSync(here + "/emit", "utf8").split("\\n")) if (l) process.stdout.write(l + "\\n");
    }
  }
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

let db: DB;
let events: EventLog;
let registry: Registry;
let headless: HeadlessSessions;
let rpc: ReturnType<typeof createRpc>;
let hooks: HookHandler;
let tracker: BackgroundTracker;
let tools: string;
let work: string;
let clock: number;
let seen: RelayEvent[];
let prompts: number;
let sendBusy: boolean;

const call = (method: string, params: unknown = {}) => rpc(method, params, "device:test");
const stdinCount = () => {
  try {
    return readFileSync(join(tools, "stdin.log"), "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
};
const emit = (...lines: object[]) =>
  writeFileSync(join(tools, "emit"), lines.map((l) => JSON.stringify(l)).join("\n"));
const toolUse = (name: string, input: object = {}) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "tu1", name, input }] },
});

beforeEach(() => {
  clock = 1_000_000;
  prompts = 0;
  sendBusy = false;
  db = openDb(":memory:");
  events = new EventLog(db);
  registry = new Registry(db, events);
  const broker = new Broker(db, events);
  tools = mkdtempSync(join(root, "bin-"));
  work = realpathSync(mkdtempSync(join(root, "work-")));
  const claudeBin = fakeClaude(tools);
  headless = new HeadlessSessions({
    registry,
    claudeBin,
    openPrompt: () => {
      prompts += 1;
      return new Promise(() => {});
    },
    now: () => clock,
    checkMs: 60_000,
    turns: {
      openId: (id) =>
        db
          .query<{ id: string }, [string]>(
            "SELECT id FROM turns WHERE session_id = ? AND ended_at IS NULL LIMIT 1",
          )
          .get(id)?.id ?? null,
      fail: () => {},
    },
    notice: (sessionId, text) => events.emit({ type: "session.notice", sessionId, level: "error", text }),
  });
  headless.busy = () => sendBusy;
  registry.ownedByHelper = (id) => headless.has(id);
  tracker = new BackgroundTracker(events, { throttleMs: 0 });
  const presence = {
    noteLocalActivity() {},
    get: () => ({ present: false, mode: "auto" }),
  } as unknown as PresenceMonitor;
  hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence,
    config: { previewChars: 600 } as RelayConfig,
    background: tracker,
  });
  rpc = createRpc({
    db,
    events,
    registry,
    broker,
    presence,
    claudeBin,
    headless,
    hasTranscript: () => true,
    config: { preferTyping: false },
  } as unknown as RpcDeps);
  seen = [];
  events.subscribe((e) => seen.push(e));
});

afterEach(() => headless.stopAll());

async function resumed() {
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, pid, started_at, updated_at, ended_at) VALUES (?, ?, 'proj', 'ended', NULL, 1000, 2000, 2000)",
  ).run(ID, work);
  await call("session.resume", { sessionId: ID, text: "carry on" });
  await waitFor(() => stdinCount() === 1);
  registry.setStatus(ID, "idle");
}

const listed = async () => ((await call("sessions.list", {})) as { result: { id: string }[] }).result;

test("an hour without a message stops the process and the chat stays listed as having no terminal", async () => {
  await resumed();
  clock += HOUR - 1;
  expect(headless.stopIdle()).toEqual([]);
  expect(headless.has(ID)).toBe(true);
  clock += 1;
  expect(headless.stopIdle()).toEqual([ID]);
  expect(headless.has(ID)).toBe(false);

  const row = registry.get(ID);
  expect(row).toMatchObject({ status: "idle", idleStopped: true, canReceive: true, pid: null });
  const rows = await listed();
  expect(rows.map((s) => s.id)).toContain(ID);
  expect(rows.find((s) => s.id === ID)).toMatchObject({ idleStopped: true, status: "idle" });
  const sync = (await call("sync", { sinceSeq: 0 })) as {
    result: { snapshot: { sessions: { id: string; idleStopped?: true }[] } };
  };
  expect(sync.result.snapshot.sessions.find((s) => s.id === ID)?.idleStopped).toBe(true);

  await Bun.sleep(100);
  expect(seen.filter((e) => e.type === "session.notice")).toEqual([]);
});

test("a message restarts a stopped chat, which then runs in the helper again", async () => {
  await resumed();
  clock += HOUR;
  headless.stopIdle();

  const refused = (await call("session.send", { sessionId: ID, text: "still there?" })) as {
    error?: { code: string; canResume?: true };
  };
  expect(refused.error).toMatchObject({ code: "not_found", canResume: true });
  const commands = (await call("session.commands", { sessionId: ID })) as { result: { route?: string } };
  expect(commands.result.route).toBe("resume");

  await call("session.resume", { sessionId: ID, text: "still there?" });
  await waitFor(() => stdinCount() === 2);
  expect(headless.has(ID)).toBe(true);
  expect(registry.get(ID)).toMatchObject({ runsInHelper: true });
  expect(registry.get(ID)?.idleStopped).toBeUndefined();
});

test("a message or output from the process restarts the hour", async () => {
  await resumed();
  clock += HOUR - 1000;
  await call("session.send", { sessionId: ID, text: "one more" });
  await waitFor(() => stdinCount() === 2);
  clock += HOUR - 1000;
  expect(headless.stopIdle()).toEqual([]);
  clock += 1000;
  expect(headless.stopIdle()).toEqual([ID]);
});

test("a late SessionEnd from the stopped process doesn't end the chat; the sweep leaves it", async () => {
  await resumed();
  const pid = headless.pidOf(ID);
  clock += HOUR;
  headless.stopIdle();
  const late = (event: string) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: ID, cwd: work }, env: { claudePid: pid } },
      new AbortController().signal,
    );
  await late("Stop");
  await late("SessionEnd");
  await hooks.handle(
    { payload: { hook_event_name: "SessionEnd", session_id: ID, cwd: work }, env: {} },
    new AbortController().signal,
  );
  (registry as unknown as { sweep(): void }).sweep();
  expect(registry.get(ID)).toMatchObject({ status: "idle", idleStopped: true });
  expect((await listed()).map((s) => s.id)).toContain(ID);
});

test("a process of the person's own taking the chat over ends the kept-open state", async () => {
  await resumed();
  clock += HOUR;
  headless.stopIdle();
  await hooks.handle(
    {
      payload: { hook_event_name: "SessionStart", session_id: ID, cwd: work },
      env: { claudePid: 2147483000 },
    },
    new AbortController().signal,
  );
  expect(registry.get(ID)?.idleStopped).toBeUndefined();
});

test("a late SessionEnd from the stopped process after the next message doesn't end the chat", async () => {
  await resumed();
  const pid = headless.pidOf(ID);
  clock += HOUR;
  headless.stopIdle();
  await call("session.resume", { sessionId: ID, text: "again" });
  expect(headless.has(ID)).toBe(true);
  await hooks.handle(
    { payload: { hook_event_name: "SessionEnd", session_id: ID, cwd: work }, env: { claudePid: pid } },
    new AbortController().signal,
  );
  expect(headless.has(ID)).toBe(true);
  expect(registry.get(ID)?.status).not.toBe("ended");
  expect((await listed()).map((s) => s.id)).toContain(ID);
});

test("a late SessionEnd without a pid after the next message doesn't end the chat", async () => {
  await resumed();
  clock += HOUR;
  headless.stopIdle();
  await call("session.resume", { sessionId: ID, text: "again" });
  await hooks.handle(
    { payload: { hook_event_name: "SessionEnd", session_id: ID, cwd: work }, env: { claudePid: null } },
    new AbortController().signal,
  );
  expect(headless.has(ID)).toBe(true);
  expect(registry.get(ID)?.status).not.toBe("ended");
  expect((await listed()).map((s) => s.id)).toContain(ID);
});

test("a `claude agents` list asked for before the stop doesn't bring the stopped process back", async () => {
  await resumed();
  const pid = headless.pidOf(ID);
  const agents = join(tools, "agents-bin");
  writeFileSync(
    agents,
    `#!${process.execPath}
const list = [{ sessionId: "${ID}", pid: ${pid}, cwd: "${work}", status: "idle" }];
await Bun.sleep(400);
process.stdout.write(JSON.stringify(list));
`,
  );
  chmodSync(agents, 0o755);
  const reconciling = registry.reconcile(agents);
  await Bun.sleep(100);
  clock += HOUR;
  headless.stopIdle();
  await reconciling;
  expect(registry.get(ID)).toMatchObject({ status: "idle", idleStopped: true });
  (registry as unknown as { sweep(): void }).sweep();
  await registry.reconcile(agents);
  expect(registry.get(ID)).toMatchObject({ status: "idle", idleStopped: true });
  expect((await listed()).map((s) => s.id)).toContain(ID);
});

test("a stopped chat whose resume fails (Claude Code exits before it starts) is no longer listed", async () => {
  await resumed();
  clock += HOUR;
  headless.stopIdle();
  writeFileSync(join(tools, "claude"), `#!${process.execPath}\nprocess.exit(1);\n`);
  const reply = (await call("session.resume", { sessionId: ID, text: "again" })) as { error?: unknown };
  expect(reply.error).toBeDefined();
  expect(headless.has(ID)).toBe(false);
  await waitFor(() => registry.get(ID)?.status === "ended");
  expect(registry.get(ID)?.idleStopped).toBeUndefined();
  expect((await listed()).map((s) => s.id)).not.toContain(ID);
});

test("an open turn keeps the process", async () => {
  await resumed();
  db.query("INSERT INTO turns (id, session_id, started_at, prompt) VALUES ('t1', ?, 1000, 'go')").run(ID);
  clock += 5 * HOUR;
  expect(headless.stopIdle()).toEqual([]);
  db.query("UPDATE turns SET ended_at = 2000 WHERE id = 't1'").run();
  expect(headless.stopIdle()).toEqual([ID]);
});

test("an open prompt keeps the process", async () => {
  await resumed();
  emit({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
  });
  await call("session.send", { sessionId: ID, text: "run ls" });
  await waitFor(() => prompts === 1);
  clock += 5 * HOUR;
  expect(headless.stopIdle()).toEqual([]);
});

test("a running background task keeps the process", async () => {
  await resumed();
  tracker.stopped(ID, [{ id: "b1", type: "shell", status: "running", command: "sleep 9999" }]);
  clock += 5 * HOUR;
  expect(headless.stopIdle()).toEqual([]);
  tracker.stopped(ID, []);
  expect(headless.stopIdle()).toEqual([ID]);
});

test("a send being delivered keeps the process", async () => {
  await resumed();
  sendBusy = true;
  clock += 5 * HOUR;
  expect(headless.stopIdle()).toEqual([]);
  sendBusy = false;
  expect(headless.stopIdle()).toEqual([ID]);
});

test("a message Claude Code hasn't named yet keeps the process", async () => {
  await resumed();
  const entry = (
    headless as unknown as { owned: Map<string, { confirms: boolean; unnamed: Map<string, () => void> }> }
  ).owned.get(ID);
  entry?.unnamed.set("u1", () => {});
  if (entry) entry.confirms = true;
  clock += 5 * HOUR;
  expect(headless.stopIdle()).toEqual([]);
});

test("a scheduled wake-up keeps the process until it is due and the hour after", async () => {
  await resumed();
  emit(toolUse("ScheduleWakeup", { delaySeconds: 1800, reason: "check", prompt: "check" }));
  await call("session.send", { sessionId: ID, text: "check in half an hour" });
  await waitFor(() => stdinCount() === 2);
  await Bun.sleep(100);
  clock += HOUR + 1000;
  expect(headless.stopIdle()).toEqual([]);
  clock += 1800_000;
  expect(headless.stopIdle()).toEqual([ID]);
});

test("a cancelled wake-up no longer keeps it", async () => {
  await resumed();
  emit(toolUse("ScheduleWakeup", { delaySeconds: 3600, reason: "x", prompt: "x" }));
  await call("session.send", { sessionId: ID, text: "a" });
  await waitFor(() => stdinCount() === 2);
  emit(toolUse("ScheduleWakeup", { stop: true }));
  await call("session.send", { sessionId: ID, text: "b" });
  await waitFor(() => stdinCount() === 3);
  await Bun.sleep(100);
  clock += HOUR;
  expect(headless.stopIdle()).toEqual([ID]);
});

test("a scheduled job keeps the process until it is deleted", async () => {
  await resumed();
  emit(toolUse("CronCreate", { cron: "*/5 * * * *", prompt: "poll" }));
  await call("session.send", { sessionId: ID, text: "poll" });
  await waitFor(() => stdinCount() === 2);
  await Bun.sleep(100);
  clock += 5 * HOUR;
  expect(headless.stopIdle()).toEqual([]);
  emit(toolUse("CronDelete", { id: "j1" }));
  await call("session.send", { sessionId: ID, text: "stop polling" });
  await waitFor(() => stdinCount() === 3);
  await Bun.sleep(100);
  clock += HOUR;
  expect(headless.stopIdle()).toEqual([ID]);
});

test("the one timer stops idle processes by itself", async () => {
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at) VALUES (?, ?, 'proj', 'idle', 1000, 2000)",
  ).run(ID, work);
  let now = 0;
  const timed = new HeadlessSessions({
    registry,
    claudeBin: join(tools, "claude"),
    openPrompt: () => new Promise(() => {}),
    now: () => now,
    checkMs: 10,
  });
  await timed.resume(registry.get(ID) as SessionRecord, "carry on");
  expect(timed.has(ID)).toBe(true);
  await Bun.sleep(50);
  expect(timed.has(ID)).toBe(true);
  now = HOUR;
  await waitFor(() => !timed.has(ID), 2000, "the timer to stop it");
  expect(registry.get(ID)).toMatchObject({ idleStopped: true });
});

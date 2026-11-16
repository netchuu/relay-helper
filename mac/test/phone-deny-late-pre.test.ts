import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

const CWD = "/Users/me/Projects/my-app";

function setup(signal: AbortSignal = new AbortController().signal) {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 20 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      signal,
    );
  const tool = (event: string, id: string, name: string, input: Record<string, unknown> = {}) =>
    hook(event, { tool_use_id: id, tool_name: name, tool_input: input });
  const session = () => publicSession(registry.get("s1") as SessionRecord);
  return { broker, hook, tool, session };
}

afterEach(() => resetLiveSteps());

type Order = "pre-first" | "pre-before-answer" | "pre-after-answer";

async function run(order: Order) {
  const t = setup();
  const bash = { command: "rm -rf build" };
  await t.hook("UserPromptSubmit", { prompt: "x" });
  if (order === "pre-first") await t.tool("PreToolUse", "den", "Bash", bash);
  const prompt = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: bash });
  await Bun.sleep(5);
  if (order === "pre-before-answer") await t.tool("PreToolUse", "den", "Bash", bash);
  const id = t.broker.listOpen("s1")[0]!.id;
  expect(t.broker.answer(id, { kind: "permission", action: "deny" }, "device:a")).toEqual({ ok: true });
  await prompt;
  if (order === "pre-after-answer") await t.tool("PreToolUse", "den", "Bash", bash);
  await Bun.sleep(60);
  const afterDeny = t.session().step?.label;
  await t.tool("PreToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await t.tool("PostToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await Bun.sleep(60);
  return { afterDeny, afterRead: t.session().step?.label };
}

for (const order of ["pre-first", "pre-before-answer", "pre-after-answer"] as const) {
  test(`phone Deny ends at Thinking (${order})`, async () => {
    expect(await run(order)).toEqual({ afterDeny: "Thinking", afterRead: "Thinking" });
  });
}

const NPM = { command: "npm test" };

async function answer(t: ReturnType<typeof setup>, action: "allow" | "deny", index = 0) {
  const id = t.broker.listOpen("s1")[index]!.id;
  expect(t.broker.answer(id, { kind: "permission", action }, "device:a")).toEqual({ ok: true });
}

test("phone Allow on a pending prompt, then the same command denied later, ends at Thinking", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const first = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "allow");
  await first;
  await t.tool("PostToolUse", "a1", "Bash", NPM);
  await t.tool("PreToolUse", "a1", "Bash", NPM);
  await t.tool("PreToolUse", "a2", "Bash", NPM);
  const second = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "deny", 0);
  await second;
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a subagent's prompt doesn't tie to the main agent's same command", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const sub = { agent_id: "ag1" };
  await t.hook("PreToolUse", { tool_use_id: "sub1", tool_name: "Bash", tool_input: NPM, ...sub });
  const first = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM, ...sub });
  await Bun.sleep(5);
  await answer(t, "allow");
  await first;
  await t.hook("PostToolUse", { tool_use_id: "sub1", tool_name: "Bash", tool_input: NPM, ...sub });
  await t.tool("PreToolUse", "m1", "Bash", NPM);
  const second = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "deny", 0);
  await second;
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a denied subagent prompt doesn't hide the main agent's same command", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const first = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM, agent_id: "ag1" });
  await Bun.sleep(5);
  await answer(t, "deny");
  await first;
  await t.tool("PreToolUse", "m1", "Bash", NPM);
  expect(t.session().step?.label).toBe("Running npm test");
});

test("two identical pending prompts, both denied, end at Thinking", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const p1 = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  const p2 = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "deny", 0);
  await answer(t, "deny", 0);
  await Promise.all([p1, p2]);
  await t.tool("PreToolUse", "d1", "Bash", NPM);
  await t.tool("PreToolUse", "d2", "Bash", NPM);
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("an end hook for a tool nobody started clears its waiting prompt", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const first = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  // The tool ran (answered at the terminal) and its PreToolUse never comes.
  await t.tool("PostToolUse", "a1", "Bash", NPM);
  await t.tool("PreToolUse", "a2", "Bash", NPM);
  const second = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "deny", t.broker.listOpen("s1").length - 1);
  await second;
  void first;
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("Allow, late PreToolUse, then the same command denied, ends at Thinking", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const first = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "allow");
  await first;
  await t.tool("PreToolUse", "a1", "Bash", NPM);
  const second = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "deny", 0);
  await second;
  await t.tool("PostToolUse", "a1", "Bash", NPM);
  await t.tool("PreToolUse", "a2", "Bash", NPM);
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("Allow, second prompt, late PreToolUse of the first, Deny, ends at Thinking", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const first = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await answer(t, "allow");
  await first;
  const second = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: NPM });
  await Bun.sleep(5);
  await t.tool("PreToolUse", "a1", "Bash", NPM);
  await answer(t, "deny", 0);
  await second;
  await t.tool("PostToolUse", "a1", "Bash", NPM);
  await t.tool("PreToolUse", "a2", "Bash", NPM);
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a terminal No (hook aborted), late PreToolUse, ends at Thinking", async () => {
  const abort = new AbortController();
  const t = setup(abort.signal);
  const rm = { command: "rm -rf build" };
  await t.hook("UserPromptSubmit", { prompt: "x" });
  const prompt = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: rm });
  await Bun.sleep(5);
  abort.abort();
  await prompt;
  await t.tool("PreToolUse", "den", "Bash", rm);
  await t.tool("PreToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await t.tool("PostToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

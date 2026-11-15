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

function setup() {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 20 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const signal = new AbortController().signal;
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

async function askBash(t: ReturnType<typeof setup>) {
  const bash = { command: "rm -rf build" };
  await t.hook("UserPromptSubmit", { prompt: "x" });
  await t.tool("PreToolUse", "den", "Bash", bash);
  const prompt = t.hook("PermissionRequest", { tool_name: "Bash", tool_input: bash });
  return { prompt, id: t.broker.listOpen("s1")[0]!.id };
}

async function readAfter(t: ReturnType<typeof setup>) {
  await t.tool("PreToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  expect(t.session().step?.label).toBe("Reading a.ts");
  await t.tool("PostToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await Bun.sleep(60);
}

test("a tool denied from the phone stops showing as running", async () => {
  const t = setup();
  const { prompt, id } = await askBash(t);
  expect(t.broker.answer(id, { kind: "permission", action: "deny" }, "device:a")).toEqual({ ok: true });
  await prompt;
  await readAfter(t);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a tool denied from the phone with no end hook, then its late end hook, still ends once", async () => {
  const t = setup();
  const { prompt, id } = await askBash(t);
  t.broker.answer(id, { kind: "permission", action: "deny" }, "device:a");
  await prompt;
  await t.tool("PostToolUseFailure", "den", "Bash", { command: "rm -rf build" });
  await readAfter(t);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a tool allowed from the phone keeps showing as running until its own end hook", async () => {
  const t = setup();
  const { prompt, id } = await askBash(t);
  t.broker.answer(id, { kind: "permission", action: "allow" }, "device:a");
  await prompt;
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Running rm -rf build");
  await t.tool("PostToolUse", "den", "Bash", { command: "rm -rf build" });
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a late end hook of a denied tool after the next tool starts does not bring it back", async () => {
  const t = setup();
  const { prompt, id } = await askBash(t);
  t.broker.answer(id, { kind: "permission", action: "deny" }, "device:a");
  await prompt;
  await t.tool("PreToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await t.tool("PostToolUseFailure", "den", "Bash", { command: "rm -rf build" });
  expect(t.session().step?.label).toBe("Reading a.ts");
  await t.tool("PostToolUse", "rd", "Read", { file_path: `${CWD}/a.ts` });
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

test("a phone Deny with no next tool ends at Thinking", async () => {
  const t = setup();
  const { prompt, id } = await askBash(t);
  expect(t.session().step?.label).toBe("Running rm -rf build");
  t.broker.answer(id, { kind: "permission", action: "deny" }, "device:a");
  await prompt;
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
  await t.tool("PostToolUseFailure", "den", "Bash", { command: "rm -rf build" });
  await Bun.sleep(60);
  expect(t.session().step?.label).toBe("Thinking");
});

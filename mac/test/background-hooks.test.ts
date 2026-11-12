// Background work through the hooks: an agent's activity from PreToolUse and PostToolUse, a shell's title for any
// command, and an ended session's upsert.
import { afterEach, expect, test } from "bun:test";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { BackgroundTracker, backgroundOf, resetBackground } from "../src/daemon/background.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";

const SHELL = {
  id: "bonwwqtte",
  type: "shell",
  status: "running",
  description: "Wait two minutes",
  command: "sleep 120",
};
const AGENT = {
  id: "a009ac2509eecfda6",
  type: "subagent",
  status: "running",
  description: "Count to three slowly",
  agent_type: "general-purpose",
};
const NOTE = (id: string, status = "completed") =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>Done</summary>\n</task-notification>`;
afterEach(() => resetBackground());
function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence,
    config: { previewChars: 600 } as RelayConfig,
    background: new BackgroundTracker(events, { throttleMs: 0 }),
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/Users/me/app", ...fields }, env: {} },
      new AbortController().signal,
    );
  return { hook, registry, seen };
}

test("an agent's PostToolUse gives its activity", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "ok", background_tasks: [AGENT] });
  await t.hook("PostToolUse", {
    tool_use_id: "u1",
    tool_name: "Bash",
    tool_input: { command: "sleep 15" },
    tool_response: {},
    agent_id: AGENT.id,
  });
  expect(backgroundOf("s1")[0]?.activity?.label).toBe("Running sleep 15");
});

test("a shell's title is never empty, whatever its command", async () => {
  const t = setup();
  const cmds = ["| grep x", "> out.log", "&& ls", "cd /tmp && ", "FOO=1 ", "2>&1"];
  await t.hook("Stop", {
    last_assistant_message: "ok",
    background_tasks: cmds.map((command, i) => ({ id: `c${i}`, type: "shell", status: "running", command })),
  });
  const titles = backgroundOf("s1").map((x) => x.title);
  console.log(JSON.stringify(titles));
  for (const title of titles) expect(title.trim()).not.toBe("");
});

test("an ended session's upsert (reconcile) carries no stale background", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "ok", background_tasks: [SHELL] });
  t.registry.setStatus("s1", "ended");
  const up = t.seen.filter((e) => e.type === "session.upsert").at(-1);
  expect(up?.type === "session.upsert" && up.session.status).toBe("ended");
  expect(up?.type === "session.upsert" && up.session.background).toBeUndefined();
});

test("an agent's tool call just before the Stop that first lists it is its activity", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Start an agent" });
  await t.hook("PreToolUse", {
    tool_use_id: "u1",
    tool_name: "Bash",
    tool_input: { command: "sleep 15" },
    agent_id: AGENT.id,
    agent_type: "general-purpose",
  });
  await t.hook("Stop", { last_assistant_message: "ok", background_tasks: [AGENT] });
  expect(backgroundOf("s1")[0]?.activity?.label).toBe("Running sleep 15");
});

// A background agent's activity: an older call finishing does not replace the agent's newer running call.
import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { BackgroundTracker, backgroundOf, resetBackground } from "../src/daemon/background.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";

const AGENT = {
  id: "a009ac2509eecfda6",
  type: "subagent",
  status: "running",
  description: "Count",
  agent_type: "general-purpose",
};
afterEach(() => resetBackground());
test("an older call finishing doesn't replace the agent's newer running call", async () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const hooks = new HookHandler({
    db,
    events,
    registry: new Registry(db, events),
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    background: new BackgroundTracker(events, { throttleMs: 0 }),
  });
  const hook = (event: string, f: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/x", ...f }, env: {} },
      new AbortController().signal,
    );
  const call = (event: string, id: string, command: string) =>
    hook(event, {
      tool_use_id: id,
      tool_name: "Bash",
      tool_input: { command },
      tool_response: {},
      agent_id: AGENT.id,
    });
  await hook("Stop", { last_assistant_message: "ok", background_tasks: [AGENT] });
  await call("PreToolUse", "u1", "sleep 1");
  await call("PreToolUse", "u2", "bun test");
  await call("PostToolUse", "u1", "sleep 1");
  expect(backgroundOf("s1")[0]?.activity?.label).toBe("Running bun test");
});

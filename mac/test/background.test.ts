import { afterEach, expect, test } from "bun:test";
import { BackgroundTask, type RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import {
  BackgroundTracker,
  backgroundOf,
  notifiedTaskId,
  resetBackground,
} from "../src/daemon/background.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { formatEvent } from "../src/tailFormat.ts";

// Background work: the shells and agents Claude left running after a turn. The task shapes are the ones Claude Code
// sends in the Stop hook's background_tasks.

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
  `<task-notification> <task-id>${id}</task-id> <tool-use-id>toolu_1</tool-use-id> <status>${status}</status> <summary>x</summary> </task-notification>`;

afterEach(() => resetBackground());

function setup(throttleMs = 0) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const background = new BackgroundTracker(events, { throttleMs });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence,
    config: { previewChars: 600 } as RelayConfig,
    background,
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/Users/me/app", ...fields }, env: {} },
      new AbortController().signal,
    );
  const lists = () => seen.flatMap((e) => (e.type === "session.background" ? [e.tasks] : []));
  return { db, events, registry, hook, lists, seen };
}

test("a Stop's background_tasks become the session's list: a shell and an agent", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "Start the server" });
  await t.hook("Stop", { last_assistant_message: "Started.", background_tasks: [SHELL, AGENT] });
  const list = backgroundOf("s1");
  expect(list.map((x) => [x.id, x.kind, x.title, x.detail ?? null, x.agentType ?? null])).toEqual([
    ["bonwwqtte", "shell", "Wait two minutes", "sleep 120", null],
    ["a009ac2509eecfda6", "agent", "Count to three slowly", null, "general-purpose"],
  ]);
  for (const task of list) expect(BackgroundTask.safeParse(task).success).toBe(true);
  expect(
    t
      .lists()
      .at(-1)
      ?.map((x) => x.id),
  ).toEqual(["bonwwqtte", "a009ac2509eecfda6"]);
  // The session itself is idle (Claude waits for you) and carries the list.
  const s = publicSession(t.registry.get("s1") as SessionRecord);
  expect(s.status).toBe("idle");
  expect(s.background?.map((x) => x.id)).toEqual(["bonwwqtte", "a009ac2509eecfda6"]);
});

test("startedAt is kept across Stops; a task the next Stop doesn't list is gone; non-running ones are left out", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL] });
  const first = backgroundOf("s1")[0]?.startedAt;
  await Bun.sleep(5);
  await t.hook("Stop", {
    last_assistant_message: "b",
    background_tasks: [SHELL, { ...AGENT, status: "completed" }],
  });
  expect(backgroundOf("s1").map((x) => [x.id, x.startedAt])).toEqual([["bonwwqtte", first as number]]);
  await t.hook("Stop", { last_assistant_message: "c", background_tasks: [] });
  expect(backgroundOf("s1")).toEqual([]);
  expect("background" in publicSession(t.registry.get("s1") as SessionRecord)).toBe(false);
  expect(t.lists().at(-1)).toEqual([]);
});

test("a Stop without background_tasks (older Claude Code) changes nothing; an unchanged list sends nothing", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL] });
  const sent = t.lists().length;
  await t.hook("Stop", { last_assistant_message: "b" });
  await t.hook("Stop", { last_assistant_message: "c", background_tasks: [SHELL] });
  expect(backgroundOf("s1").map((x) => x.id)).toEqual(["bonwwqtte"]);
  expect(t.lists().length).toBe(sent);
});

test("a task-notification removes its task", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL, AGENT] });
  await t.hook("UserPromptSubmit", { prompt: NOTE("a009ac2509eecfda6") });
  expect(backgroundOf("s1").map((x) => x.id)).toEqual(["bonwwqtte"]);
  expect(notifiedTaskId("Please check <task-id>x</task-id>")).toBeNull();
  expect(notifiedTaskId(NOTE("bonwwqtte", "failed"))).toBe("bonwwqtte");
});

test("an agent's tool calls give its activity, at most once a second, and only for listed agents", async () => {
  const t = setup(1000);
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL, AGENT] });
  const sent = t.lists().length;
  const call = (cmd: string, agent = AGENT.id) =>
    t.hook("PreToolUse", {
      tool_use_id: `u-${cmd}`,
      tool_name: "Bash",
      tool_input: { command: cmd },
      agent_id: agent,
      agent_type: "general-purpose",
    });
  await call("sleep 15");
  expect(backgroundOf("s1")[1]?.activity?.label).toBe("Running sleep 15");
  await call("bun test");
  await call("bun test");
  await call("ls", "some-other-agent");
  // The first went out at once; the second waits for the second to pass.
  expect(t.lists().length).toBe(sent + 1);
  await Bun.sleep(1100);
  expect(t.lists().length).toBe(sent + 2);
  expect(t.lists().at(-1)?.[1]?.activity?.label).toBe("Running bun test");
  expect(backgroundOf("s1")[0]?.activity).toBeUndefined();
});

test("secrets in a shell's command or description are redacted, and long commands cut", async () => {
  const t = setup();
  const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";
  await t.hook("Stop", {
    last_assistant_message: "a",
    background_tasks: [
      {
        ...SHELL,
        description: `deploy with ${token}`,
        command: `GITHUB_TOKEN=${token} ${"x ".repeat(1500)}`,
      },
      { id: "n2", type: "shell", status: "running", command: "npm run dev -- --port 5180" },
    ],
  });
  const [a, b] = backgroundOf("s1");
  expect(JSON.stringify(a)).not.toContain("ghp_");
  expect(BackgroundTask.safeParse(a).success).toBe(true);
  expect(b?.title).toBe("npm run dev -- --port 5180");
});

test("SessionEnd and an ended session clear it", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL] });
  await t.hook("SessionEnd");
  expect(backgroundOf("s1")).toEqual([]);
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL] });
  t.registry.setStatus("s1", "ended");
  expect(backgroundOf("s1")).toEqual([]);
});

test("sync replays only the newest list per session, and nothing is pushed", async () => {
  const t = setup();
  await t.hook("Stop", { last_assistant_message: "a", background_tasks: [SHELL, AGENT] });
  await t.hook("UserPromptSubmit", { prompt: NOTE(AGENT.id) });
  await t.hook("Stop", { last_assistant_message: "b", background_tasks: [SHELL] });
  const replay = t.events.sinceForSync(0).filter((e) => e.type === "session.background");
  expect(replay).toHaveLength(1);
  for (const e of t.seen) if (e.type === "session.background") expect(alertFor(e, () => "x")).toBeNull();
  const line = formatEvent(replay[0] as RelayEvent);
  expect(line).toContain("shell · Wait two minutes");
  expect(line).not.toContain("\n");
});

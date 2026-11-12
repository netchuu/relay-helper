import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BackgroundTask,
  graphemes,
  RelayEvent,
  type RelayEvent as RelayEventT,
  Session,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { BackgroundTracker, backgroundOf, resetBackground } from "../src/daemon/background.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { alertFor } from "../src/daemon/notifier.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import type { TurnStopper } from "../src/daemon/stop.ts";
import { formatEvent } from "../src/tailFormat.ts";

// Background work, edge cases: odd background_tasks input, Stops and notifications in any order, an agent's activity,
// the once-a-second limit, sync and tail. Task shapes are the ones Claude Code sends in the Stop hook.

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
const AGENT2 = { ...AGENT, id: "a1112223334445556", description: "Read the docs" };
const NOTE = (id: string, status = "completed") =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>Done</summary>\n</task-notification>`;
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";

afterEach(() => resetBackground());

function setup(opts: { throttleMs?: number; justStopped?: boolean } = {}) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = {
    noteLocalActivity() {},
    get: () => ({ present: false, mode: "auto" }),
  } as unknown as PresenceMonitor;
  const stopper = opts.justStopped
    ? ({ justStopped: () => true, takeInboxStop: () => null } as unknown as TurnStopper)
    : undefined;
  const seen: RelayEventT[] = [];
  events.subscribe((e) => seen.push(e));
  const make = () => {
    const background = new BackgroundTracker(events, { throttleMs: opts.throttleMs ?? 0 });
    return new HookHandler({
      db,
      events,
      registry,
      broker,
      presence,
      config: { previewChars: 600 } as RelayConfig,
      background,
      ...(stopper ? { stopper } : {}),
    });
  };
  let hooks = make();
  const hook = (event: string, fields: Record<string, unknown> = {}, sessionId = "s1") =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: sessionId, cwd: "/Users/me/app", ...fields },
        env: {},
      },
      new AbortController().signal,
    );
  const stop = (tasks: unknown, sessionId = "s1", event = "Stop") =>
    hook(event, { last_assistant_message: "ok", background_tasks: tasks }, sessionId);
  const agentCall = (agentId: string, command: string, sessionId = "s1", event = "PreToolUse") =>
    hook(
      event,
      {
        tool_use_id: `u-${agentId}-${command}`,
        tool_name: "Bash",
        tool_input: { command },
        agent_id: agentId,
        agent_type: "general-purpose",
      },
      sessionId,
    );
  const bg = (sessionId?: string) =>
    seen.flatMap((e) =>
      e.type === "session.background" && (!sessionId || e.sessionId === sessionId) ? [e] : [],
    );
  const pub = (id = "s1") => publicSession(registry.get(id) as SessionRecord);
  // A helper restart: the in-memory list is gone, the database stays.
  const restart = () => {
    resetBackground();
    hooks = make();
  };
  const rpc = createRpc({ db, events, registry, broker, presence } as unknown as RpcDeps);
  return { db, events, registry, seen, hook, stop, agentCall, bg, pub, restart, rpc };
}

describe("inputs: background_tasks in shapes Claude Code doesn't send", () => {
  test("a background_tasks that isn't an array changes nothing, sends nothing and doesn't throw", async () => {
    const t = setup();
    await t.stop([SHELL]);
    const sent = t.bg().length;
    for (const bad of [{ 0: SHELL }, "sleep 120", null, 42, true, { tasks: [] }]) await t.stop(bad);
    expect(backgroundOf("s1").map((x) => x.id)).toEqual(["bonwwqtte"]);
    expect(t.bg().length).toBe(sent);
    expect(t.registry.get("s1")?.status).toBe("idle");
  });

  test("entries that aren't objects or have no usable id are left out; the good one stays", async () => {
    const t = setup();
    await t.stop([
      null,
      7,
      "bonwwqtte",
      [],
      {},
      { ...SHELL, id: undefined },
      { ...SHELL, id: 5 },
      { ...SHELL, id: "" },
      { ...SHELL, id: "   " },
      { ...SHELL, id: null },
      AGENT,
    ]);
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([AGENT.id]);
    expect(
      t
        .bg()
        .at(-1)
        ?.tasks.map((x) => x.id),
    ).toEqual([AGENT.id]);
  });

  test("a duplicated id is one task", async () => {
    const t = setup();
    await t.stop([SHELL, { ...SHELL, description: "Second copy" }, AGENT, AGENT]);
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([SHELL.id, AGENT.id]);
    const ids =
      t
        .bg()
        .at(-1)
        ?.tasks.map((x) => x.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every status other than running is left out", async () => {
    const t = setup();
    const statuses = ["completed", "failed", "killed", "stopped", "pending", "RUNNING", ""];
    await t.stop([...statuses.map((status, i) => ({ ...SHELL, id: `x${i}`, status })), AGENT]);
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([AGENT.id]);
  });

  test("a type the helper doesn't know becomes an agent (never a shell), titled by its description or Agent", async () => {
    const t = setup();
    await t.stop([
      { id: "r1", type: "remote_agent", status: "running", description: "Review the PR", command: "ignored" },
      { id: "r2", status: "running" },
      { id: "r3", type: 7, status: "running", description: "  " },
    ]);
    const list = backgroundOf("s1");
    expect(list.map((x) => [x.id, x.kind, x.title, x.detail ?? null])).toEqual([
      ["r1", "agent", "Review the PR", null],
      ["r2", "agent", "Agent", null],
      ["r3", "agent", "Agent", null],
    ]);
  });

  test("a shell's agent_type is ignored; an agent without agent_type has no agentType", async () => {
    const t = setup();
    await t.stop([
      { ...SHELL, agent_type: "general-purpose" },
      { ...AGENT, agent_type: undefined },
    ]);
    const [shell, agent] = backgroundOf("s1");
    expect(shell && "agentType" in shell).toBe(false);
    expect(agent && "agentType" in agent).toBe(false);
  });

  test("titles fall back: whitespace description → the command's first words; shell without either → Shell", async () => {
    const t = setup();
    await t.stop([
      {
        ...SHELL,
        id: "a",
        description: " \n\t ",
        command: "cd /Users/me/app && PORT=5180 npm run dev | tee log",
      },
      { ...SHELL, id: "b", description: undefined, command: "\n\n  bun test --watch\nsecond line" },
      { ...SHELL, id: "c", description: undefined, command: undefined },
      { ...SHELL, id: "d", description: undefined, command: "   " },
    ]);
    expect(backgroundOf("s1").map((x) => [x.title, x.detail ?? null])).toEqual([
      ["npm run dev", "cd /Users/me/app && PORT=5180 npm run dev | tee log"],
      ["bun test --watch", "bun test --watch\nsecond line"],
      ["Shell", null],
      ["Shell", null],
    ]);
  });

  test("a description with line breaks and tabs is one line", async () => {
    const t = setup();
    await t.stop([{ ...SHELL, description: "Start\nthe\r\ndev\tserver  \n" }]);
    expect(backgroundOf("s1")[0]?.title).toBe("Start the dev server");
  });

  test("a title is at most 80 characters, and emoji, ZWJ families and combining marks are never split", async () => {
    const t = setup();
    const family = "👨‍👩‍👧‍👦";
    const accented = "é";
    await t.stop([
      { ...SHELL, id: "f", description: family.repeat(100) },
      { ...SHELL, id: "c", description: accented.repeat(81) },
      { ...SHELL, id: "x", description: "y".repeat(80) },
      { ...SHELL, id: "z", description: "y".repeat(81) },
      { ...SHELL, id: "w", description: undefined, command: `echo ${"🙂".repeat(200)}` },
    ]);
    const list = backgroundOf("s1");
    for (const task of list) {
      expect(graphemes(task.title).length).toBeLessThanOrEqual(80);
      expect(BackgroundTask.safeParse(task).success).toBe(true);
    }
    const [f, c, x, z] = list;
    for (const g of graphemes(f?.title ?? "")) expect([family, "…"]).toContain(g);
    for (const g of graphemes(c?.title ?? "")) expect([accented, "…"]).toContain(g);
    expect(x?.title).toBe("y".repeat(80));
    expect(z?.title.endsWith("…")).toBe(true);
  });

  test("right-to-left and mixed text stays as it is", async () => {
    const t = setup();
    await t.stop([{ ...SHELL, description: "שרת פיתוח · خادم 🚀" }]);
    expect(backgroundOf("s1")[0]?.title).toBe("שרת פיתוח · خادم 🚀");
  });

  test("a huge command is cut to at most 2000 characters and still parses", async () => {
    const t = setup();
    await t.stop([{ ...SHELL, command: `node -e "${"a".repeat(100_000)}"` }]);
    const detail = backgroundOf("s1")[0]?.detail ?? "";
    expect(graphemes(detail).length).toBeLessThanOrEqual(2000);
    expect(detail.endsWith("…")).toBe(true);
    for (const e of t.bg()) expect(RelayEvent.safeParse(e).success).toBe(true);
  });

  test("a secret straddling the 2000-character cut doesn't leak even in part", async () => {
    const t = setup();
    await t.stop([{ ...SHELL, command: `${"x".repeat(1985)} ${TOKEN} tail` }]);
    const detail = backgroundOf("s1")[0]?.detail ?? "";
    expect(detail).not.toContain("ghp_");
    expect(detail).not.toContain("ABCDEFGHIJ");
  });

  test("secrets in the description, in a command-only title, and in the command are redacted", async () => {
    const t = setup();
    await t.stop([
      { ...SHELL, id: "a", description: `Deploy with ${TOKEN}` },
      { ...SHELL, id: "b", description: undefined, command: `curl -H "Authorization: Bearer ${TOKEN}" x` },
      { ...AGENT, id: "c", description: `Use ${TOKEN}` },
    ]);
    const all = JSON.stringify([backgroundOf("s1"), t.bg(), t.pub()]);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("ABCDEFGHIJKLMNOP");
  });

  test("text that looks like markup or a command is just text", async () => {
    const t = setup();
    await t.stop([{ ...SHELL, description: "<b>bold</b> $(rm -rf /) `x`" }]);
    expect(backgroundOf("s1")[0]?.title).toBe("<b>bold</b> $(rm -rf /) `x`");
  });

  test("every session.background sent parses as a RelayEvent", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    await t.agentCall(AGENT.id, "sleep 15");
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    await t.hook("SessionEnd");
    expect(t.bg().length).toBeGreaterThanOrEqual(4);
    for (const e of t.bg()) expect(RelayEvent.safeParse(e).success).toBe(true);
  });
});

describe("state: Stops, notifications, ends", () => {
  test("startedAt and an agent's activity are kept across Stops, whatever the order; a new task gets its own", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    const [s0, a0] = backgroundOf("s1");
    await t.agentCall(AGENT.id, "sleep 15");
    await Bun.sleep(10);
    const before = Date.now();
    await t.stop([AGENT2, AGENT, SHELL]);
    const list = backgroundOf("s1");
    expect(list.map((x) => x.id)).toEqual([AGENT2.id, AGENT.id, SHELL.id]);
    expect(list[1]?.startedAt).toBe(a0?.startedAt as number);
    expect(list[2]?.startedAt).toBe(s0?.startedAt as number);
    expect(list[0]?.startedAt).toBeGreaterThanOrEqual(before);
    expect(list[1]?.activity?.label).toBe("Running sleep 15");
    expect(list[0]?.activity).toBeUndefined();
  });

  test("the phone's Stop path (turn already ended by the phone) still updates the list", async () => {
    const t = setup({ justStopped: true });
    await t.hook("UserPromptSubmit", { prompt: "Run the server" });
    await t.stop([SHELL]);
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([SHELL.id]);
    expect(
      t
        .bg()
        .at(-1)
        ?.tasks.map((x) => x.id),
    ).toEqual([SHELL.id]);
    expect(t.pub().background?.map((x) => x.id)).toEqual([SHELL.id]);
    await t.stop([]);
    expect(t.bg().at(-1)?.tasks).toEqual([]);
  });

  test("StopFailure carries the list too", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "go" });
    await t.stop([SHELL, AGENT], "s1", "StopFailure");
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([SHELL.id, AGENT.id]);
    await t.stop([AGENT], "s1", "StopFailure");
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([AGENT.id]);
  });

  test("an empty list after an empty list sends nothing", async () => {
    const t = setup();
    await t.stop([]);
    await t.stop([]);
    await t.hook("SessionEnd");
    expect(t.bg()).toHaveLength(0);
  });

  test("a notification for an unknown id, a finished one, or one twice sends nothing more", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    const sent = t.bg().length;
    await t.hook("UserPromptSubmit", { prompt: NOTE("nobody-knows-me") });
    expect(t.bg().length).toBe(sent);
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id, "killed") });
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    expect(t.bg().length).toBe(sent + 1);
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([AGENT.id]);
  });

  test("a notification in one session doesn't touch another session's task with that id", async () => {
    const t = setup();
    await t.stop([SHELL], "s1");
    await t.stop([SHELL], "s2");
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) }, "s2");
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([SHELL.id]);
    expect(backgroundOf("s2")).toEqual([]);
  });

  test("a notification with leading blank lines (or IDE context stripped) still removes its task", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    await t.hook("UserPromptSubmit", { prompt: `\n\n  ${NOTE(SHELL.id, "failed")}` });
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([AGENT.id]);
  });

  test("two notifications in back-to-back prompts (Claude Code sends one prompt each) remove both", async () => {
    const t = setup();
    await t.stop([SHELL, { ...SHELL, id: "b57rt92av" }]);
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    await t.hook("UserPromptSubmit", { prompt: NOTE("b57rt92av") });
    expect(backgroundOf("s1")).toEqual([]);
    expect(t.bg().at(-1)?.tasks).toEqual([]);
  });

  test("a prompt you typed that quotes a task-notification removes nothing", async () => {
    const t = setup();
    await t.stop([SHELL]);
    await t.hook("UserPromptSubmit", { prompt: `What does this mean? ${NOTE(SHELL.id)}` });
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([SHELL.id]);
  });

  test("the session stays idle with things running, and going idle again doesn't clear the list", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Start it" });
    await t.stop([SHELL]);
    expect(t.pub().status).toBe("idle");
    t.registry.setStatus("s1", "idle");
    expect(backgroundOf("s1").map((x) => x.id)).toEqual([SHELL.id]);
  });

  test("SessionEnd clears and sends an empty list once; later agent calls and notifications send nothing", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    await t.hook("SessionEnd");
    expect(t.bg().at(-1)?.tasks).toEqual([]);
    const sent = t.bg().length;
    await t.agentCall(AGENT.id, "ls");
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    expect(t.bg().length).toBe(sent);
    expect(backgroundOf("s1")).toEqual([]);
  });

  test("an ended session (reconcile) clears its list and sends an empty one after the ended upsert", async () => {
    const t = setup();
    await t.stop([SHELL]);
    t.registry.setStatus("s1", "ended");
    expect(backgroundOf("s1")).toEqual([]);
    const ended = t.seen.findIndex((e) => e.type === "session.upsert" && e.session.status === "ended");
    const cleared = t.seen.findLastIndex((e) => e.type === "session.background" && e.tasks.length === 0);
    expect(ended).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(ended);
    expect("background" in t.pub()).toBe(false);
  });

  test("SessionEnd's ended upsert carries no background", async () => {
    const t = setup();
    await t.stop([SHELL]);
    await t.hook("SessionEnd");
    const up = t.seen.filter((e) => e.type === "session.upsert").at(-1);
    expect(up?.type === "session.upsert" && up.session.status).toBe("ended");
    expect(up?.type === "session.upsert" && "background" in up.session).toBe(false);
  });

  test("the session.upsert at the end of a Stop already carries the new list", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Start it" });
    await t.stop([SHELL, AGENT]);
    const up = t.seen.filter((e) => e.type === "session.upsert").at(-1);
    expect(up?.type === "session.upsert" && up.session.background?.map((x) => x.id)).toEqual([
      SHELL.id,
      AGENT.id,
    ]);
    expect(Session.safeParse(up?.type === "session.upsert" ? up.session : null).success).toBe(true);
  });

  test("a helper restart: nothing until the next Stop; old notifications and agent calls do nothing; then it's back", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    const firstStart = backgroundOf("s1")[0]?.startedAt as number;
    t.restart();
    expect("background" in t.pub()).toBe(false);
    const sent = t.bg().length;
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    await t.agentCall(AGENT.id, "ls");
    expect(t.bg().length).toBe(sent);
    await Bun.sleep(5);
    await t.stop([SHELL, AGENT]);
    expect(t.pub().background?.map((x) => x.id)).toEqual([SHELL.id, AGENT.id]);
    expect(backgroundOf("s1")[0]?.startedAt).toBeGreaterThan(firstStart);
  });

  test("many sessions keep separate lists; ending one leaves the others", async () => {
    const t = setup();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        t.stop([{ ...SHELL, id: `sh${i}`, description: `Server ${i}` }], `s${i}`),
      ),
    );
    await t.hook("SessionEnd", {}, "s7");
    for (let i = 0; i < 30; i++) {
      const ids = backgroundOf(`s${i}`).map((x) => x.id);
      expect(ids).toEqual(i === 7 ? [] : [`sh${i}`]);
      expect(t.pub(`s${i}`).background?.[0]?.title ?? null).toBe(i === 7 ? null : `Server ${i}`);
    }
  });
});

describe("an agent's activity", () => {
  test("a shell's id, an unlisted agent, or an agent of another session gets no activity and sends nothing", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT], "s1");
    await t.stop([AGENT2], "s2");
    const sent = t.bg().length;
    await t.agentCall(SHELL.id, "ls");
    await t.agentCall("a-not-listed", "ls");
    await t.agentCall(AGENT2.id, "ls", "s1");
    expect(t.bg().length).toBe(sent);
    for (const x of [...backgroundOf("s1"), ...backgroundOf("s2")]) expect(x.activity).toBeUndefined();
  });

  test("an agent's tool call leaves the session idle and starts no turn step, action or alert", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Start an agent" });
    await t.stop([AGENT]);
    const from = t.seen.length;
    await t.agentCall(AGENT.id, "sleep 15");
    await t.agentCall(AGENT.id, "bun test", "s1", "PostToolUse");
    const after = t.seen.slice(from);
    expect(after.map((e) => e.type).filter((x) => x !== "session.background")).toEqual([]);
    expect(t.pub().status).toBe("idle");
    for (const e of after) expect(alertFor(e, () => "x")).toBeNull();
  });

  test("an agent's activity is redacted", async () => {
    const t = setup();
    await t.stop([AGENT]);
    await t.agentCall(AGENT.id, `GITHUB_TOKEN=${TOKEN} gh pr list`);
    expect(JSON.stringify([backgroundOf("s1"), t.bg()])).not.toContain("ABCDEFGHIJKLMNOP");
  });

  test("the same activity again sends nothing", async () => {
    const t = setup();
    await t.stop([AGENT]);
    await t.agentCall(AGENT.id, "sleep 15");
    const sent = t.bg().length;
    await t.agentCall(AGENT.id, "sleep 15");
    expect(t.bg().length).toBe(sent);
  });

  test("the publicSession and sync snapshot carry the activity", async () => {
    const t = setup();
    await t.stop([AGENT]);
    await t.agentCall(AGENT.id, "sleep 15");
    expect(t.pub().background?.[0]?.activity?.label).toBe("Running sleep 15");
    const sync = (await t.rpc("sync", { sinceSeq: 0 }, "device:a")) as {
      result: { snapshot: { sessions: Session[] } };
    };
    expect(sync.result.snapshot.sessions[0]?.background?.[0]?.activity?.label).toBe("Running sleep 15");
    const listed = (await t.rpc("sessions.list", {}, "device:a")) as { result: Session[] };
    expect(listed.result[0]?.background?.[0]?.id).toBe(AGENT.id);
  });
});

describe("the once-a-second activity limit", () => {
  const W = 150;

  test("two agents in one session share the limit; the trailing send has both newest activities", async () => {
    const t = setup({ throttleMs: W });
    await t.stop([AGENT, AGENT2]);
    const sent = t.bg().length;
    await t.agentCall(AGENT.id, "sleep 1");
    await t.agentCall(AGENT2.id, "sleep 2");
    await t.agentCall(AGENT.id, "sleep 3");
    expect(t.bg().length).toBe(sent + 1);
    await Bun.sleep(W + 60);
    expect(t.bg().length).toBe(sent + 2);
    expect(
      t
        .bg()
        .at(-1)
        ?.tasks.map((x) => x.activity?.label),
    ).toEqual(["Running sleep 3", "Running sleep 2"]);
    await Bun.sleep(W + 60);
    expect(t.bg().length).toBe(sent + 2);
  });

  test("the limit is per session: two sessions both send at once", async () => {
    const t = setup({ throttleMs: W });
    await t.stop([AGENT], "s1");
    await t.stop([AGENT], "s2");
    await t.agentCall(AGENT.id, "sleep 1", "s1");
    await t.agentCall(AGENT.id, "sleep 1", "s2");
    expect(t.bg("s1").at(-1)?.tasks[0]?.activity?.label).toBe("Running sleep 1");
    expect(t.bg("s2").at(-1)?.tasks[0]?.activity?.label).toBe("Running sleep 1");
  });

  test("a list change inside the window goes out at once with the pending activity, and no stale trailing send follows", async () => {
    const t = setup({ throttleMs: W });
    await t.stop([SHELL, AGENT]);
    await t.agentCall(AGENT.id, "sleep 1");
    await t.agentCall(AGENT.id, "sleep 2"); // pending
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    const last = t.bg().at(-1);
    expect(last?.tasks.map((x) => [x.id, x.activity?.label])).toEqual([[AGENT.id, "Running sleep 2"]]);
    const sent = t.bg().length;
    await Bun.sleep(W + 60);
    expect(t.bg().length).toBe(sent);
  });

  test("SessionEnd inside the window: nothing is sent after the empty list", async () => {
    const t = setup({ throttleMs: W });
    await t.stop([AGENT]);
    await t.agentCall(AGENT.id, "sleep 1");
    await t.agentCall(AGENT.id, "sleep 2"); // pending
    await t.hook("SessionEnd");
    await Bun.sleep(W + 60);
    expect(t.bg().at(-1)?.tasks).toEqual([]);
    expect(backgroundOf("s1")).toEqual([]);
  });

  test("the agent's own notification inside the window: it doesn't come back in a trailing send", async () => {
    const t = setup({ throttleMs: W });
    await t.stop([SHELL, AGENT]);
    await t.agentCall(AGENT.id, "sleep 1");
    await t.agentCall(AGENT.id, "sleep 2"); // pending
    await t.hook("UserPromptSubmit", { prompt: NOTE(AGENT.id) });
    await Bun.sleep(W + 60);
    expect(
      t
        .bg()
        .at(-1)
        ?.tasks.map((x) => x.id),
    ).toEqual([SHELL.id]);
  });

  test("after the window passes, the next activity goes out at once", async () => {
    const t = setup({ throttleMs: W });
    await t.stop([AGENT]);
    await t.agentCall(AGENT.id, "sleep 1");
    await Bun.sleep(W + 30);
    const sent = t.bg().length;
    await t.agentCall(AGENT.id, "sleep 2");
    expect(t.bg().length).toBe(sent + 1);
  });
});

describe("sync, tail and pushes", () => {
  test("sync since a seq replays the newest list of each session, keeps other events, and the empty one when that's newest", async () => {
    const t = setup();
    await t.stop([SHELL], "s1");
    const since = t.events.latestSeq();
    await t.stop([SHELL, AGENT], "s1");
    await t.stop([AGENT], "s2");
    await t.hook("UserPromptSubmit", { prompt: NOTE(AGENT.id) }, "s1");
    await t.stop([AGENT, AGENT2], "s2");
    await t.hook("SessionEnd", {}, "s1");
    const r = (await t.rpc("sync", { sinceSeq: since }, "device:a")) as { result: { events: RelayEventT[] } };
    const bgs = r.result.events.filter((e) => e.type === "session.background");
    expect(bgs.map((e) => (e.type === "session.background" ? [e.sessionId, e.tasks.length] : null))).toEqual([
      ["s2", 2],
      ["s1", 0],
    ]);
    expect(r.result.events.some((e) => e.type === "session.upsert")).toBe(true);
    expect(r.result.events.some((e) => e.type === "turn.started")).toBe(true);
  });

  test("sync from after the newest list replays none", async () => {
    const t = setup();
    await t.stop([SHELL]);
    await t.hook("SessionStart");
    const since = t.events.latestSeq();
    const r = (await t.rpc("sync", { sinceSeq: since }, "device:a")) as { result: { events: RelayEventT[] } };
    expect(r.result.events.filter((e) => e.type === "session.background")).toHaveLength(0);
  });

  test("hundreds of activity updates don't crowd real events out of a sync replay", async () => {
    const t = setup();
    await t.stop([AGENT]);
    const since = t.events.latestSeq();
    for (let i = 0; i < 1200; i++) await t.agentCall(AGENT.id, `step ${i}`);
    await t.hook("UserPromptSubmit", { prompt: "after all that" });
    const r = (await t.rpc("sync", { sinceSeq: since }, "device:a")) as { result: { events: RelayEventT[] } };
    expect(r.result.events.filter((e) => e.type === "session.background")).toHaveLength(1);
    expect(r.result.events.some((e) => e.type === "turn.started")).toBe(true);
  });

  test("no event of the whole flow raises an alert of its own", async () => {
    const t = setup({ throttleMs: 0 });
    await t.stop([SHELL, AGENT]);
    await t.agentCall(AGENT.id, "sleep 1");
    await t.hook("SessionEnd");
    for (const e of t.bg()) expect(alertFor(e, () => "x")).toBeNull();
  });

  test("relay tail prints one line per list, emoji and right-to-left included, and the empty list", async () => {
    const t = setup();
    await t.stop([{ ...SHELL, description: "שרת 🚀\nnext" }, AGENT]);
    await t.stop([]);
    const [full, empty] = t.bg();
    const a = formatEvent(full as RelayEventT);
    expect(a).toContain("shell · שרת 🚀 next");
    expect(a).toContain(`agent · ${AGENT.description}`);
    expect(a).not.toContain("\n");
    expect(formatEvent(empty as RelayEventT)).toContain("nothing in the background");
  });

  test("the fixture's events and session parse", () => {
    const fx = JSON.parse(
      readFileSync(join(import.meta.dir, "../../protocol/fixtures/background.json"), "utf8"),
    ) as { events: unknown[]; session: unknown };
    for (const e of fx.events) expect(RelayEvent.safeParse(e).success).toBe(true);
    expect(Session.safeParse(fx.session).success).toBe(true);
  });
});

describe("early activity, PostToolUse, title fallback, ended upsert, old rows", () => {
  const early = (t: ReturnType<typeof setup>, agentId: string, command: string, sessionId = "s1") =>
    t.agentCall(agentId, command, sessionId);

  test("an agent's call before the first Stop sends nothing then, and is its activity once listed", async () => {
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Start an agent" });
    await early(t, AGENT.id, "sleep 1");
    await early(t, AGENT.id, "sleep 2");
    expect(t.bg()).toHaveLength(0);
    await t.stop([AGENT]);
    expect(t.bg().at(-1)?.tasks[0]?.activity?.label).toBe("Running sleep 2");
  });

  test("at most 16 not-yet-listed agents are remembered per session: the oldest goes first", async () => {
    const t = setup();
    const ids = Array.from({ length: 17 }, (_, i) => `ag${i}`);
    for (const id of ids) await early(t, id, `sleep ${id}`);
    await t.stop(ids.map((id) => ({ ...AGENT, id })));
    const list = backgroundOf("s1");
    expect(list[0]?.activity).toBeUndefined();
    for (const task of list.slice(1)) expect(task.activity?.label).toBe(`Running sleep ${task.id}`);
  });

  test("a remembered call is dropped at a Stop that doesn't list its agent, and at SessionEnd", async () => {
    const t = setup();
    await early(t, AGENT.id, "sleep 1");
    await t.stop([SHELL]);
    await t.stop([SHELL, AGENT]);
    expect(backgroundOf("s1")[1]?.activity).toBeUndefined();
    await early(t, AGENT2.id, "sleep 2", "s2");
    await t.hook("SessionEnd", {}, "s2");
    await t.stop([AGENT2], "s2");
    expect(backgroundOf("s2")[0]?.activity).toBeUndefined();
  });

  test("a remembered call belongs to its own session only", async () => {
    const t = setup();
    await early(t, AGENT.id, "sleep 1", "s2");
    await t.stop([AGENT], "s1");
    expect(backgroundOf("s1")[0]?.activity).toBeUndefined();
  });

  test("a Stop without background_tasks keeps a remembered call for the next one", async () => {
    const t = setup();
    await early(t, AGENT.id, "sleep 1");
    await t.hook("Stop", { last_assistant_message: "older Claude Code" });
    await t.stop([AGENT]);
    expect(backgroundOf("s1")[0]?.activity?.label).toBe("Running sleep 1");
  });

  test("a call with a listed shell's id is never an agent's activity, early or late", async () => {
    const t = setup();
    await t.stop([SHELL]);
    await early(t, SHELL.id, "ls");
    await t.stop([SHELL]);
    expect(backgroundOf("s1")[0]?.activity).toBeUndefined();
  });

  test("a remembered call is redacted and the kept activity parses", async () => {
    const t = setup();
    await early(t, AGENT.id, `GITHUB_TOKEN=${TOKEN} gh pr list`);
    await t.stop([AGENT]);
    expect(JSON.stringify([backgroundOf("s1"), t.bg()])).not.toContain("ABCDEFGHIJKLMNOP");
    for (const e of t.bg()) expect(RelayEvent.safeParse(e).success).toBe(true);
  });

  test("PostToolUse after its PreToolUse sends nothing more; PostToolUseFailure gives activity too", async () => {
    const t = setup();
    await t.stop([AGENT, AGENT2]);
    await t.agentCall(AGENT.id, "sleep 15");
    const sent = t.bg().length;
    await t.agentCall(AGENT.id, "sleep 15", "s1", "PostToolUse");
    expect(t.bg().length).toBe(sent);
    await t.agentCall(AGENT2.id, "false", "s1", "PostToolUseFailure");
    expect(backgroundOf("s1")[1]?.activity?.label).toBe("Running false");
  });

  test("a shell whose command has no first words is titled by the command on one line, cut and redacted", async () => {
    const t = setup();
    await t.stop([
      { id: "a", type: "shell", status: "running", command: "| grep x" },
      { id: "b", type: "shell", status: "running", command: `| curl -H "Authorization: Bearer ${TOKEN}"` },
      { id: "c", type: "shell", status: "running", command: `&& ${"y".repeat(500)}` },
      { id: "d", type: "shell", status: "running", command: "cd /tmp && \n\n" },
    ]);
    const list = backgroundOf("s1");
    for (const task of list) {
      expect(task.title.trim()).not.toBe("");
      expect(task.title).not.toContain("\n");
      expect(BackgroundTask.safeParse(task).success).toBe(true);
    }
    expect(list[0]?.title).toBe("| grep x");
    expect(list[1]?.title).not.toContain("ABCDEFGHIJ");
  });

  test("ended sessions carry no background anywhere: the upsert, sessions.list with ended, and sync", async () => {
    const t = setup();
    await t.stop([SHELL]);
    const since = t.events.latestSeq();
    t.registry.setStatus("s1", "ended");
    const ups = t.seen.filter((e) => e.type === "session.upsert" && e.session.status === "ended");
    for (const u of ups) expect(u.type === "session.upsert" && "background" in u.session).toBe(false);
    const all = (await t.rpc("sessions.list", { includeEnded: true }, "device:a")) as { result: Session[] };
    expect(all.result.find((s) => s.id === "s1")?.background).toBeUndefined();
    const r = (await t.rpc("sync", { sinceSeq: since }, "device:a")) as { result: { events: RelayEventT[] } };
    const last = r.result.events.filter((e) => e.type === "session.background").at(-1);
    expect(last?.type === "session.background" && last.tasks).toEqual([]);
  });

  test("only the newest list of each session stays in the log; other sessions and other events stay", async () => {
    const t = setup();
    await t.stop([SHELL], "s1");
    await t.stop([AGENT], "s2");
    await t.stop([SHELL, AGENT], "s1");
    for (let i = 0; i < 20; i++) await t.agentCall(AGENT.id, `step ${i}`, "s1");
    const rows = t.db
      .query(
        "SELECT json_extract(data_json, '$.sessionId') AS s, COUNT(*) AS n FROM events WHERE type = 'session.background' GROUP BY s ORDER BY s",
      )
      .all();
    expect(rows).toEqual([
      { s: "s1", n: 1 },
      { s: "s2", n: 1 },
    ]);
    expect(t.events.since(0).some((e) => e.type === "session.upsert")).toBe(true);
  });

  test("a phone that synced before many updates gets the newest list from sync", async () => {
    const t = setup();
    await t.stop([SHELL, AGENT]);
    const since = t.events.latestSeq(); // the phone saw this list
    for (let i = 0; i < 10; i++) await t.agentCall(AGENT.id, `step ${i}`);
    await t.hook("UserPromptSubmit", { prompt: NOTE(SHELL.id) });
    const r = (await t.rpc("sync", { sinceSeq: since }, "device:a")) as { result: { events: RelayEventT[] } };
    const bgs = r.result.events.filter((e) => e.type === "session.background");
    expect(bgs).toHaveLength(1);
    expect(
      bgs[0]?.type === "session.background" && bgs[0].tasks.map((x) => [x.id, x.activity?.label]),
    ).toEqual([[AGENT.id, "Running step 9"]]);
  });

  test("a phone whose cursor sits among deleted rows still ends with the newest list (events or snapshot)", async () => {
    const t = setup();
    await t.stop([SHELL]);
    // A week later: everything else was pruned, the list's row is the oldest in the log.
    t.db.query("DELETE FROM events WHERE type != 'session.background'").run();
    const cursor = t.events.oldestSeq() - 1;
    await t.stop([SHELL, AGENT]);
    const r = (await t.rpc("sync", { sinceSeq: cursor }, "device:a")) as {
      result: { events: RelayEventT[]; snapshot?: { sessions: Session[] } };
    };
    const fromEvents = r.result.events.filter((e) => e.type === "session.background").at(-1);
    const ids = r.result.snapshot
      ? r.result.snapshot.sessions.find((s) => s.id === "s1")?.background?.map((x) => x.id)
      : fromEvents?.type === "session.background"
        ? fromEvents.tasks.map((x) => x.id)
        : null;
    expect(ids).toEqual([SHELL.id, AGENT.id]);
  });

  test("a live phone gets every list as it goes out, even though older rows are deleted", async () => {
    const t = setup();
    await t.stop([SHELL]);
    await t.stop([SHELL, AGENT]);
    await t.stop([]);
    expect(t.bg().map((e) => e.tasks.length)).toEqual([1, 2, 0]);
  });
});

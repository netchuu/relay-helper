// A full context: the failed turn says so, the session shows 0% left until it is compacted or cleared, and
// `/compact` is a turn of its own.
import { afterEach, expect, test } from "bun:test";
import { type RelayEvent, Session, type Turn } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { COMPACTED, CONTEXT_FULL, HookHandler, notePhoneTyped } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { isContextFullError, resetUsage, usageOf } from "../src/daemon/usage.ts";
import { relayHooks } from "../src/install.ts";

afterEach(() => resetUsage());

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  let local = 0;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity: () => local++ } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, more: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/Users/me/app", ...more }, env: {} },
      new AbortController().signal,
    );
  const session = () => {
    const last = seen.findLast((e) => e.type === "session.upsert");
    if (last?.type !== "session.upsert") throw new Error("no session sent");
    return Session.parse(last.session);
  };
  const finished = (): Turn[] => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : []));
  const started = () => seen.flatMap((e) => (e.type === "turn.started" ? [e] : []));
  const notices = () => seen.filter((e) => e.type === "session.notice");
  const tooLong = () =>
    hook("StopFailure", { error: "invalid_request", last_assistant_message: "Prompt is too long" });
  return { hooks, hook, session, finished, started, notices, tooLong, localActivity: () => local };
}

test("only Claude Code's own context error counts, not another failure or an answer that starts like it", () => {
  expect(isContextFullError("invalid_request", "Prompt is too long")).toBe(true);
  expect(isContextFullError("invalid_request", " prompt is too long.\n")).toBe(true);
  expect(isContextFullError("invalid_request", "API Error: 400", "prompt is too long: 210000 tokens")).toBe(
    true,
  );
  expect(isContextFullError(undefined, "Prompt is too long")).toBe(true);
  expect(isContextFullError("rate_limit", "Prompt is too long")).toBe(false);
  expect(isContextFullError("server_error", "API Error: 500", "prompt is too long")).toBe(false);
  expect(isContextFullError("invalid_request", "API Error: 400 bad tool schema")).toBe(false);
  expect(isContextFullError(undefined, "Prompt is too long for a commit title, so I shortened it.")).toBe(
    false,
  );
  expect(isContextFullError(undefined, "Done.", "prompt is too long")).toBe(false);
});

test("a turn that didn't fit says the context is full and the session shows none left", async () => {
  const t = setup();
  await t.hook("SessionStart");
  t.hooks.statusLine({ session_id: "s1", context_window: { remaining_percentage: 3 } });
  await t.hook("UserPromptSubmit", { prompt: "carry on" });
  await t.tooLong();
  const turn = t.finished().at(-1);
  expect(turn?.summary).toBe(CONTEXT_FULL);
  expect(turn?.failed).toBe(true);
  expect(t.session().usage).toEqual({ contextLeftPercent: 0, contextFull: true });
  expect(t.session().status).toBe("idle");
  // The turn says it; a second notice with the raw error would only repeat it.
  expect(t.notices()).toEqual([]);
});

test("a full context shows without any status line reading, and a stale reading doesn't undo it", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "carry on" });
  await t.tooLong();
  expect(usageOf("s1")).toEqual({ contextLeftPercent: 0, contextFull: true });
  t.hooks.statusLine({ session_id: "s1", context_window: { remaining_percentage: 3 } });
  t.hooks.statusLine({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 40 } } });
  expect(t.session().usage).toEqual({
    contextLeftPercent: 0,
    contextFull: true,
    fiveHour: { usedPercent: 40 },
  });
});

test("another failed turn keeps its own error and its notice", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "carry on" });
  await t.hook("StopFailure", {
    error: "rate_limit",
    last_assistant_message: "API Error: Rate limit reached",
  });
  expect(t.finished().at(-1)?.summary).toBe("API Error: Rate limit reached");
  expect(t.notices().length).toBe(1);
  expect(usageOf("s1")).toBeUndefined();
});

test("compacting makes room: /compact is a turn that ends when the session is compacted", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "carry on" });
  await t.tooLong();
  await t.hook("PreCompact", { trigger: "manual", custom_instructions: "" });
  expect(t.started().at(-1)?.prompt).toBe("/compact");
  expect(t.session().status).toBe("working");
  // Still full while it compacts.
  expect(t.session().usage?.contextFull).toBe(true);
  await t.hook("SessionStart", { source: "compact" });
  const turn = t.finished().at(-1);
  expect(turn?.id).toBe(t.started().at(-1)?.turnId);
  expect(turn?.summary).toBe(COMPACTED);
  expect(turn?.failed).toBeFalsy();
  expect(t.session().status).toBe("idle");
  expect(t.session().usage).toBeUndefined();
  t.hooks.statusLine({ session_id: "s1", context_window: { remaining_percentage: 91 } });
  expect(t.session().usage).toEqual({ contextLeftPercent: 91 });
});

test("the phone's /compact is the turn's message, with what it asked to keep", async () => {
  const t = setup();
  await t.hook("SessionStart");
  notePhoneTyped("s1", "/compact keep the test plan", false, "send-1");
  await t.hook("PreCompact", { trigger: "manual", custom_instructions: "keep the test plan" });
  const started = t.started().at(-1);
  expect(started?.prompt).toBe("/compact keep the test plan");
  expect(started?.sendId).toBe("send-1");
  expect(t.localActivity()).toBe(0);
});

test("without the PreCompact hook, the phone's /compact still becomes a finished turn", async () => {
  const t = setup();
  await t.hook("SessionStart");
  notePhoneTyped("s1", "/compact", false, "send-2");
  await t.hook("SessionStart", { source: "compact" });
  expect(t.started().at(-1)).toMatchObject({ prompt: "/compact", sendId: "send-2" });
  expect(t.finished().at(-1)?.summary).toBe(COMPACTED);
  expect(t.session().status).toBe("idle");
  // A session compacted at the Mac, with nothing from the phone, gets no turn.
  await t.hook("SessionStart", { source: "compact" });
  expect(t.started().length).toBe(1);
});

test("a /compact typed at the Mac counts as activity there and carries no phone message", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("PreCompact", { trigger: "manual" });
  expect(t.started().at(-1)?.sendId).toBeUndefined();
  expect(t.localActivity()).toBe(1);
});

test("compacting by itself in the middle of a turn starts no turn and ends none", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "a long job" });
  await t.hook("PreCompact", { trigger: "auto" });
  await t.hook("PreCompact", { trigger: "manual" });
  await t.hook("SessionStart", { source: "compact" });
  expect(t.started().length).toBe(1);
  expect(t.finished()).toEqual([]);
  expect(t.session().status).toBe("working");
});

test("clearing makes room, and so does any turn that ends well", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "carry on" });
  await t.tooLong();
  await t.hook("SessionStart", { source: "clear" });
  expect(t.session().usage).toBeUndefined();

  await t.hook("UserPromptSubmit", { prompt: "again" });
  await t.tooLong();
  expect(usageOf("s1")?.contextFull).toBe(true);
  // Another failure says nothing about the context.
  await t.hook("UserPromptSubmit", { prompt: "again" });
  await t.hook("StopFailure", { error: "server_error", last_assistant_message: "API Error: 500" });
  expect(usageOf("s1")?.contextFull).toBe(true);
  await t.hook("UserPromptSubmit", { prompt: "again" });
  await t.hook("Stop", { last_assistant_message: "Done." });
  expect(usageOf("s1")).toBeUndefined();
});

test("a session that ends is no longer full", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("UserPromptSubmit", { prompt: "carry on" });
  await t.tooLong();
  await t.hook("SessionEnd");
  expect(usageOf("s1")).toBeUndefined();
});

test("install wires the hook a /compact fires", () => {
  expect(Object.keys(relayHooks("/bin/relay-hook"))).toContain("PreCompact");
});

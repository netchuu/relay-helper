// usage-left: what is left of the plan limits and the context, from Claude Code's status line. The helper keeps it per
// session, sends it to the phones, and keeps the person's own status line running and restorable.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayEvent, Session } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { sessionModels } from "../src/daemon/model.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { noteUsage, noteUsageAll, parseUsage, resetUsage, usageOf } from "../src/daemon/usage.ts";
import { mergeStatusLine, removeStatusLine } from "../src/install.ts";

const BIN = "/Users/me/.relay/bin/relay-hook";
const dirs: string[] = [];
afterEach(() => {
  resetUsage();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("parseUsage reads the context and both limits, resets in epoch seconds", () => {
  expect(
    parseUsage({
      context_window: { remaining_percentage: 62.4 },
      rate_limits: {
        five_hour: { used_percentage: 38, resets_at: 1_793_627_200 },
        seven_day: { used_percentage: 71.2, resets_at: 1_793_879_200 },
      },
    }),
  ).toEqual({
    contextLeftPercent: 62,
    fiveHour: { usedPercent: 38, resetsAt: 1_793_627_200_000 },
    sevenDay: { usedPercent: 71, resetsAt: 1_793_879_200_000 },
  });
});

test("parseUsage leaves out what is missing or not a number, and is null when nothing is there", () => {
  expect(parseUsage({ context_window: { remaining_percentage: 8 } })).toEqual({ contextLeftPercent: 8 });
  expect(
    parseUsage({ rate_limits: { five_hour: { used_percentage: "x" }, seven_day: { used_percentage: 5 } } }),
  ).toEqual({
    sevenDay: { usedPercent: 5 },
  });
  expect(parseUsage({ context_window: { remaining_percentage: null }, rate_limits: {} })).toBeNull();
  expect(parseUsage(null)).toBeNull();
  expect(parseUsage({ context_window: { remaining_percentage: 140 } })).toEqual({ contextLeftPercent: 100 });
});

test("a new session gets the plan limits seen in another one, until they reset", () => {
  const limit = { usedPercent: 40, resetsAt: Date.now() + 60_000 };
  noteUsage("a", { contextLeftPercent: 50, fiveHour: limit });
  noteUsage("b", { contextLeftPercent: 90 });
  expect(usageOf("b")?.fiveHour).toEqual(limit);
  expect(usageOf("b", Date.now() + 120_000)?.fiveHour).toBeUndefined();
});

test("the newest limit reading wins in every session, also over one a session had itself", () => {
  const at = Date.now() + 60_000;
  noteUsage("b", { contextLeftPercent: 90, fiveHour: { usedPercent: 38, resetsAt: at } });
  noteUsage("a", { contextLeftPercent: 50, fiveHour: { usedPercent: 95, resetsAt: at } });
  expect(usageOf("b")?.fiveHour?.usedPercent).toBe(95);
});

test("an older, lower reading sent after a newer one changes nothing", () => {
  const at = Date.now() + 60_000;
  noteUsage("b", { fiveHour: { usedPercent: 38, resetsAt: at } });
  noteUsage("a", { fiveHour: { usedPercent: 95, resetsAt: at } });
  expect(noteUsageAll("b", { fiveHour: { usedPercent: 38, resetsAt: at } })).toEqual([]);
  expect(usageOf("a")?.fiveHour?.usedPercent).toBe(95);
  // A reading of an earlier window never replaces a later one; a later window does.
  expect(noteUsageAll("b", { fiveHour: { usedPercent: 99, resetsAt: at - 1000 } })).toEqual([]);
  expect(noteUsageAll("b", { fiveHour: { usedPercent: 2, resetsAt: at + 5000 } }).sort()).toEqual(["a", "b"]);
  expect(usageOf("a")?.fiveHour?.usedPercent).toBe(2);
});

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: "/Users/me/app" }, env: {} },
      new AbortController().signal,
    );
  const upserts = () => seen.filter((e) => e.type === "session.upsert");
  return { hooks, hook, upserts, registry };
}

test("a session the registry ended is not published again and its usage is dropped", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hooks.handle(
    { payload: { hook_event_name: "SessionStart", session_id: "s2", cwd: "/Users/me/other" }, env: {} },
    new AbortController().signal,
  );
  t.hooks.statusLine({ session_id: "s2", context_window: { remaining_percentage: 80 } });
  t.registry.setStatus("s2", "ended");
  const before = t.upserts().length;
  for (const used of [10, 20, 30, 40, 50]) {
    t.hooks.statusLine({
      session_id: "s1",
      rate_limits: { five_hour: { used_percentage: used, resets_at: 4_000_000_000 } },
    });
  }
  const sent = t.upserts().slice(before);
  expect(sent.length).toBe(5);
  expect(sent.every((e) => e.type === "session.upsert" && e.session.id === "s1")).toBe(true);
  expect(usageOf("s2")).toBeUndefined();
});

test("a status line refresh puts usage on the session, once per change", async () => {
  const t = setup();
  await t.hook("SessionStart");
  const before = t.upserts().length;
  const payload = {
    session_id: "s1",
    context_window: { remaining_percentage: 62 },
    rate_limits: { five_hour: { used_percentage: 38, resets_at: 4_000_000_000 } },
  };
  t.hooks.statusLine(payload);
  t.hooks.statusLine(payload);
  const sent = t.upserts();
  expect(sent.length).toBe(before + 1);
  const last = sent.at(-1);
  if (last?.type !== "session.upsert") throw new Error("no upsert");
  expect(Session.parse(last.session).usage).toEqual({
    contextLeftPercent: 62,
    fiveHour: { usedPercent: 38, resetsAt: 4_000_000_000_000 },
  });
});

test("new account limits from one session are published for the other live sessions", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hooks.handle(
    { payload: { hook_event_name: "SessionStart", session_id: "s2", cwd: "/Users/me/other" }, env: {} },
    new AbortController().signal,
  );
  t.hooks.statusLine({ session_id: "s2", context_window: { remaining_percentage: 80 } });
  const before = t.upserts().length;
  t.hooks.statusLine({
    session_id: "s1",
    rate_limits: { five_hour: { used_percentage: 95, resets_at: 4_000_000_000 } },
  });
  const sent = t.upserts().slice(before);
  const forS2 = sent.find((e) => e.type === "session.upsert" && e.session.id === "s2");
  if (forS2?.type !== "session.upsert") throw new Error("no upsert for s2");
  expect(forS2.session.usage?.fiveHour?.usedPercent).toBe(95);
});

test("a status line after SessionEnd sends nothing and keeps nothing", async () => {
  const t = setup();
  await t.hook("SessionStart");
  await t.hook("SessionEnd");
  const before = t.upserts().length;
  t.hooks.statusLine({ session_id: "s1", context_window: { remaining_percentage: 62 } });
  expect(t.upserts().length).toBe(before);
  expect(usageOf("s1")).toBeUndefined();
});

test("a status line for a session the helper doesn't know changes nothing", () => {
  const t = setup();
  t.hooks.statusLine({ session_id: "nope", context_window: { remaining_percentage: 5 } });
  expect(usageOf("nope")).toBeUndefined();
  expect(t.upserts().length).toBe(0);
});

test("an ended session shows no usage", async () => {
  const t = setup();
  await t.hook("SessionStart");
  t.hooks.statusLine({ session_id: "s1", context_window: { remaining_percentage: 62 } });
  await t.hook("SessionEnd");
  const last = t.upserts().at(-1);
  if (last?.type !== "session.upsert") throw new Error("no upsert");
  expect(last.session.usage).toBeUndefined();
});

// The person's own status line.

test("install keeps the person's status line and runs it through Relay's", () => {
  const own = { type: "command", command: "~/bin/my-line.sh", padding: 2 };
  const { settings, saved } = mergeStatusLine({ model: "x", statusLine: own }, BIN, null);
  expect(settings.statusLine).toEqual({ type: "command", command: `${BIN} statusline`, padding: 2 });
  expect(settings.model).toBe("x");
  expect(saved.previous).toEqual(own);
});

test("install keeps the person's refresh interval and vim indicator setting", () => {
  const own = { type: "command", command: "~/clock.sh", refreshInterval: 1, hideVimModeIndicator: true };
  const { settings } = mergeStatusLine({ statusLine: own }, BIN, null);
  expect(settings.statusLine).toEqual({ ...own, command: `${BIN} statusline` });
});

test("installing twice doesn't save Relay's own line as the person's", () => {
  const own = { type: "command", command: "~/bin/my-line.sh" };
  const first = mergeStatusLine({ statusLine: own }, BIN, null);
  const second = mergeStatusLine(first.settings, BIN, first.saved);
  expect(second.saved.previous).toEqual(own);
  expect(removeStatusLine(second.settings, second.saved).statusLine).toEqual(own);
});

test("uninstall gives the status line back, or removes Relay's when there was none", () => {
  const own = { type: "command", command: "~/bin/my-line.sh" };
  const withOwn = mergeStatusLine({ statusLine: own }, BIN, null);
  expect(removeStatusLine(withOwn.settings, withOwn.saved).statusLine).toEqual(own);
  const without = mergeStatusLine({ theme: "dark" }, BIN, null);
  expect(removeStatusLine(without.settings, without.saved)).toEqual({ theme: "dark" });
});

test("uninstall leaves a status line that isn't Relay's alone", () => {
  const other = { type: "command", command: "slack-relay-hook.sh statusline" };
  expect(removeStatusLine({ statusLine: other }, { previous: null }).statusLine).toEqual(other);
});

// relay-hook statusline: reports to the daemon and prints the person's own line unchanged.

const CLIENT = join(import.meta.dir, "../src/hook/client.ts");
const INPUT = JSON.stringify({ session_id: "s1", context_window: { remaining_percentage: 62 } });

async function runLine(saved: unknown, daemon: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "relay-line-"));
  dirs.push(dir);
  const bodies: string[] = [];
  const server = daemon
    ? Bun.serve({
        unix: join(dir, "hook.sock"),
        async fetch(req) {
          bodies.push(await req.text());
          return Response.json({ ok: true });
        },
      })
    : null;
  if (saved) writeFileSync(join(dir, "statusline.json"), JSON.stringify(saved));
  const proc = Bun.spawn(["bun", CLIENT, "statusline"], {
    env: { ...process.env, RELAY_HOME: dir },
    stdin: new Blob([INPUT]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  server?.stop(true);
  return { out, bodies };
}

test("the status line command sends the input on and prints the person's line unchanged", async () => {
  const { out, bodies } = await runLine(
    { previous: { type: "command", command: "cat | tr a-z A-Z; printf ' ok'" } },
    true,
  );
  expect(out).toBe(`${INPUT.toUpperCase()} ok`);
  expect(bodies).toEqual([INPUT]);
});

test("without a line of the person's it prints nothing, and with the daemon down it still works", async () => {
  expect((await runLine(null, true)).out).toBe("");
  const down = await runLine({ previous: { type: "command", command: "echo mine" } }, false);
  expect(down.out).toBe("mine\n");
});

test("a status line refresh puts the model and effort on the session, once per change", async () => {
  const t = setup();
  await t.hook("SessionStart");
  const before = t.upserts().length;
  const payload = { session_id: "s1", model: { display_name: "Opus 4.7" }, effort: { level: "high" } };
  t.hooks.statusLine(payload);
  t.hooks.statusLine(payload);
  expect(t.upserts().length).toBe(before + 1);
  const last = t.upserts().at(-1);
  if (last?.type !== "session.upsert") throw new Error("no upsert");
  expect(last.session.model).toBe("Opus 4.7");
  expect(last.session.effort).toBe("high");
  t.hooks.statusLine({ ...payload, effort: { level: "low" } });
  const next = t.upserts().at(-1);
  if (next?.type !== "session.upsert") throw new Error("no upsert");
  expect(next.session.effort).toBe("low");
  sessionModels.forget("s1");
});

test("a refresh without an effort clears it (a model that has none)", async () => {
  const t = setup();
  await t.hook("SessionStart");
  t.hooks.statusLine({ session_id: "s1", model: { display_name: "Opus 4.7" }, effort: { level: "high" } });
  const before = t.upserts().length;
  t.hooks.statusLine({ session_id: "s1", model: { display_name: "Haiku 4.5" } });
  expect(t.upserts().length).toBe(before + 1);
  const last = t.upserts().at(-1);
  if (last?.type !== "session.upsert") throw new Error("no upsert");
  expect(last.session.model).toBe("Haiku 4.5");
  expect(last.session.effort).toBeUndefined();
  t.hooks.statusLine({ session_id: "s1", model: { display_name: "Haiku 4.5" } });
  expect(t.upserts().length).toBe(before + 1);
  sessionModels.forget("s1");
});

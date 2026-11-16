import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { dropPhoneTyped, type HookEnvelope, HookHandler, notePhoneTyped } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

// A photo the phone typed into tmux comes back from Claude Code as "[Image #N]", with no path: the turn must still
// list the photo, also after a restart, and a prompt typed at the Mac must not take it.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLiveSteps();
});

function setup(dir: string, dbPath = ":memory:") {
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(dbPath);
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker: Broker = new Broker(db, events, () => {});
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const config = { previewChars: 600, preferTyping: true } as RelayConfig;
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = {
    noteLocalActivity: () => {},
    get: () => ({ mode: "auto", present: true, idleSeconds: 0, locked: false }),
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const rpc = createRpc({ db, events, registry, broker, presence, config, steps } as unknown as RpcDeps);
  const call = async <T>(method: string, params: object): Promise<T> => {
    const out = (await rpc(method, params, "device:d1")) as { result?: T; error?: { message: string } };
    if (out.error) throw new Error(out.error.message);
    return out.result as T;
  };
  const hook = (event: string, sessionId: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: {
          hook_event_name: event,
          session_id: sessionId,
          cwd: dir,
          transcript_path: transcript,
          ...fields,
        },
        env: {},
      } as HookEnvelope,
      new AbortController().signal,
    );
  const photo = (sessionId: string, id: string) => {
    const path = join(dir, "attachments", sessionId, `${id}-photo.png`);
    db.query(
      "INSERT INTO attachments (id, session_id, name, mime, size, sha256, path, created_at, finished_at) VALUES (?, ?, 'photo.png', 'image/png', 10, 'x', ?, ?, ?)",
    ).run(id, sessionId, path, Date.now(), Date.now());
    return path;
  };
  return { db, seen, call, hook, photo };
}

type Started = Extract<RelayEvent, { type: "turn.started" }>;
type Done = Extract<RelayEvent, { type: "turn.done" }>;
type T = { prompt?: string; attachments?: { id: string }[] };
const turnsOf = (r: { turns?: T[] } | T[]) => (Array.isArray(r) ? r : (r.turns ?? []));
const ids = (a?: { id: string }[]) => a?.map((x) => x.id);

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "relay-photo-turn-"));
  dirs.push(dir);
  return dir;
}

async function run(sent: (p: string) => string, reported: (p: string) => string, id: string) {
  const s = setup(tmpDir());
  await s.hook("SessionStart", id);
  const path = s.photo(id, "a1");
  notePhoneTyped(id, sent(path));
  await s.hook("UserPromptSubmit", id, { prompt: reported(path) });
  const started = s.seen.filter((e): e is Started => e.type === "turn.started").at(-1);
  await s.hook("Stop", id, { last_assistant_message: "Done." });
  const done = s.seen.filter((e): e is Done => e.type === "turn.done").at(-1);
  const turns = turnsOf(await s.call("session.turns", { sessionId: id, limit: 10 }));
  return { started, done, turns };
}

test("a prompt that still holds the path lists the photo once", async () => {
  const r = await run(
    (p) => `look\n${p}`,
    (p) => `look\n${p}`,
    "pt-control",
  );
  expect(ids(r.started?.attachments)).toEqual(["a1"]);
  expect(ids(r.done?.turn.attachments)).toEqual(["a1"]);
  expect(ids(r.turns[0]?.attachments)).toEqual(["a1"]);
});

test("caption and photo, reported as 'look [Image #1]'", async () => {
  const r = await run(
    (p) => `look\n${p}`,
    () => "look [Image #1]",
    "pt-caption",
  );
  expect(ids(r.started?.attachments)).toEqual(["a1"]);
  expect(ids(r.done?.turn.attachments)).toEqual(["a1"]);
  expect(ids(r.turns[0]?.attachments)).toEqual(["a1"]);
});

test("photo without a caption, reported as '[Image #1]'", async () => {
  const r = await run(
    (p) => p,
    () => "[Image #1]",
    "pt-bare",
  );
  expect(ids(r.started?.attachments)).toEqual(["a1"]);
  expect(ids(r.done?.turn.attachments)).toEqual(["a1"]);
  expect(ids(r.turns[0]?.attachments)).toEqual(["a1"]);
});

test("two photos keep the order they were typed in", async () => {
  const id = "pt-two";
  const s = setup(tmpDir());
  await s.hook("SessionStart", id);
  const a = s.photo(id, "a1");
  const b = s.photo(id, "b2");
  notePhoneTyped(id, `look\n${b}\n${a}`);
  await s.hook("UserPromptSubmit", id, { prompt: "look [Image #1] [Image #2]" });
  const started = s.seen.filter((e): e is Started => e.type === "turn.started").at(-1);
  expect(ids(started?.attachments)).toEqual(["b2", "a1"]);
});

test("the link survives a helper restart", async () => {
  const dir = tmpDir();
  const file = join(dir, "relay.db");
  const id = "pt-restart";
  const first = setup(dir, file);
  await first.hook("SessionStart", id);
  const path = first.photo(id, "a1");
  notePhoneTyped(id, `look\n${path}`);
  await first.hook("UserPromptSubmit", id, { prompt: "look [Image #1]" });
  await first.hook("Stop", id, { last_assistant_message: "Done." });
  first.db.close();
  const second = setup(dir, file);
  const turns = turnsOf(await second.call("session.turns", { sessionId: id, limit: 10 }));
  expect(turns[0]?.prompt).toBe("look [Image #1]");
  expect(ids(turns[0]?.attachments)).toEqual(["a1"]);
});

test("a prompt typed at the Mac with its own [Image #1] gets nothing from an earlier phone message", async () => {
  const id = "pt-mac";
  const s = setup(tmpDir());
  await s.hook("SessionStart", id);
  const path = s.photo(id, "a1");
  notePhoneTyped(id, `look\n${path}`);
  await s.hook("UserPromptSubmit", id, { prompt: "look [Image #1]" });
  await s.hook("Stop", id, { last_assistant_message: "Done." });
  await s.hook("UserPromptSubmit", id, { prompt: "and this [Image #1]" });
  await s.hook("Stop", id, { last_assistant_message: "Ok." });
  const turns = turnsOf(await s.call("session.turns", { sessionId: id, limit: 10 }));
  const mac = turns.find((t) => t.prompt === "and this [Image #1]");
  expect(mac).toBeDefined();
  expect(mac?.attachments).toBeUndefined();
  const phone = turns.find((t) => t.prompt === "look [Image #1]");
  expect(ids(phone?.attachments)).toEqual(["a1"]);
});

test("a photo that was queued, not typed, doesn't give a Mac '[Image #1]' the photo", async () => {
  const id = "pt-queued";
  const s = setup(tmpDir());
  await s.hook("SessionStart", id);
  const path = s.photo(id, "a1");
  notePhoneTyped(id, path);
  // Delivery didn't type it (the person was typing): the entry goes.
  dropPhoneTyped(id, path);
  await s.hook("UserPromptSubmit", id, { prompt: "[Image #1]" });
  const started = s.seen.filter((e): e is Started => e.type === "turn.started").at(-1);
  expect(ids(started?.attachments) ?? []).toEqual([]);
});

test("dropPhoneTyped leaves an entry for other text", async () => {
  const id = "pt-other";
  const s = setup(tmpDir());
  await s.hook("SessionStart", id);
  const path = s.photo(id, "a1");
  notePhoneTyped(id, path);
  dropPhoneTyped(id, "something else");
  await s.hook("UserPromptSubmit", id, { prompt: "[Image #1]" });
  const started = s.seen.filter((e): e is Started => e.type === "turn.started").at(-1);
  expect(ids(started?.attachments)).toEqual(["a1"]);
});

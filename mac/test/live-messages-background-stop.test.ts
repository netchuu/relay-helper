// Live messages: a background task's turn ended by a Stop that arrives after a typed prompt.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, Turn } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { MessageTracker, resetLiveMessages, shownMessage } from "../src/daemon/messages.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { compact } from "../src/daemon/render.ts";
import { StepTracker } from "../src/daemon/steps.ts";

const CWD = "/Users/me/Projects/my-app";
const dirs: string[] = [];
afterEach(() => {
  resetLiveMessages();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-messages-cand2-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "");
  return path;
}
const append = (path: string, ...lines: object[]) =>
  appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
const iso = (ms: number) => new Date(ms).toISOString();
const text = (uuid: string, t: string, at = Date.now() + 5) => ({
  type: "assistant",
  uuid,
  timestamp: iso(at),
  message: { model: "claude-opus-5-5", content: [{ type: "text", text: t }] },
});
const userPrompt = (t: string, at = Date.now() + 1) => ({
  type: "user",
  uuid: `u-${t}`,
  timestamp: iso(at),
  message: { content: t },
});
const hookTool = (id: string) => ({ tool_use_id: id, tool_name: "Bash", tool_input: { command: "ls" } });

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 10_000 });
  const messages = new MessageTracker(events, { pollMs: 0 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps, messages });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  const msgs = () =>
    seen.filter((e): e is Extract<RelayEvent, { type: "turn.message" }> => e.type === "turn.message");
  const turnIds = () => seen.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
  const dones = () => seen.flatMap((e) => (e.type === "turn.done" ? [e.turn] : [])) as Turn[];
  return { db, hook, msgs, turnIds, dones, registry };
}

function openFenceAt(textIn: string): string | null {
  const body = textIn.replace(/ …$/, "");
  let open: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const fence = m[1] as string;
    const info = m[2] as string;
    if (open === null) {
      if (fence.startsWith("`") && info.includes("`")) continue;
      open = fence;
    } else if (fence[0] === open[0] && fence.length >= open.length && !info.trim()) open = null;
  }
  return open;
}

const toolUse = (id: string, at = Date.now() + 5) => ({
  type: "assistant",
  uuid: `tu-${id}`,
  timestamp: iso(at),
  message: {
    model: "claude-opus-5-5",
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
  },
});
const interrupt = (at = Date.now() + 2) => ({
  type: "user",
  uuid: "u-int",
  timestamp: iso(at),
  message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
});

const note = "<task-notification> <task-id>b1</task-id> <status>completed</status> </task-notification>";
const status = (t: ReturnType<typeof setup>) => t.registry.get("s1")?.status;
const summaries = (t: ReturnType<typeof setup>) => {
  const ids = t.turnIds();
  return t.dones().map((d) => [ids.indexOf(d.id) >= 0 ? `t${ids.indexOf(d.id) + 1}` : "new", d.summary]);
};

test("a background task's turn whose Stop arrives just after the next typed prompt: the answer is the task turn's", async () => {
  const t = setup();
  const path = tempFile();
  await t.hook("UserPromptSubmit", { prompt: note, transcript_path: path });
  append(
    path,
    { type: "user", uuid: "u-note", timestamp: iso(Date.now() + 1), message: { content: note } },
    text("w1", "The build finished; checking the output."),
    text("a1", "The build passed."),
  );
  await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
  append(path, userPrompt("Ship it"));
  await t.hook("UserPromptSubmit", { prompt: "Ship it", transcript_path: path });
  await t.hook("Stop", { last_assistant_message: "The build passed.", transcript_path: path });
  expect(summaries(t)).toEqual([["t1", "The build passed."]]);
  expect(t.dones()[0]?.messages?.map((m) => m.id)).toEqual(["w1"]);
  expect(status(t)).toBe("working");
  append(path, text("n1", "Shipping."));
  await t.hook("PreToolUse", { ...hookTool("x"), transcript_path: path });
  const second = t.turnIds()[1];
  expect(
    t
      .msgs()
      .filter((e) => e.turnId === second)
      .map((e) => e.message.id),
  ).toEqual(["n1"]);
});

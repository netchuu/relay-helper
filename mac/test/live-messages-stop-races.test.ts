// Live messages: nested code fences at the paragraph cut, prompts queued during Stop's wait, and a Stop that arrives
// after the next prompt's hook.
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

test("a ``` block with a ~~~ line and blank lines inside: the paragraph cut leaves it open", () => {
  const code = `\`\`\`md\n~~~\n${"line\n\n".repeat(600)}\`\`\``;
  const raw = `Intro.\n\n${code}`;
  const m = shownMessage({ id: "m", raw, at: 1 });
  expect(m.truncated).toBe(true);
  expect(openFenceAt(m.text)).toBeNull(); // got "```"
  expect(openFenceAt(compact(raw, 600).text)).toBeNull(); // the answer's preview: same
});

test("a ```` fence with ``` lines inside is closed with ````", () => {
  const raw = `\`\`\`\`md\n${"```js\nconst a = 1;\n```\nprose line here\n".repeat(150)}\`\`\`\``;
  const m = shownMessage({ id: "m", raw, at: 1 });
  expect(m.truncated).toBe(true);
  expect(openFenceAt(m.text)).toBeNull(); // got "````"
  expect(openFenceAt(compact(raw, 600).text)).toBeNull();
});

test("no transcript, queued prompt during Stop's wait: the first turn keeps the steps its hooks saw", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "First" });
  await t.hook("PreToolUse", hookTool("a"));
  await t.hook("PostToolUse", hookTool("a"));
  const stop = t.hook("Stop", { last_assistant_message: "Turn one done." });
  await Bun.sleep(50);
  await t.hook("UserPromptSubmit", { prompt: "Second" });
  await stop;
  const [first] = t.turnIds() as [string];
  const one = t.dones().find((d) => d.id === first);
  expect(one?.summary).toBe("Turn one done.");
  expect(t.registry.get("s1")?.status).toBe("working");
  expect(one?.steps?.length).toBe(1); // got undefined
  expect(one?.stats.toolCalls).toBe(1); // got 0
});

test("Stop for a turn the helper never saw start, with a prompt queued during the wait: the new turn keeps its live messages", async () => {
  const t = setup();
  const path = tempFile();
  // The helper started mid-turn: the first hook it sees is a tool call, then the Stop.
  append(path, userPrompt("Old"), text("m0", "Old turn."));
  await t.hook("PreToolUse", { ...hookTool("a"), transcript_path: path });
  const stop = t.hook("Stop", { last_assistant_message: "Old turn.", transcript_path: path });
  await Bun.sleep(50);
  append(path, userPrompt("Second"));
  await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
  const second = t.turnIds()[0] as string;
  await stop;
  append(path, text("n1", "Second turn."));
  await t.hook("PreToolUse", { ...hookTool("b"), transcript_path: path });
  expect(
    t
      .msgs()
      .filter((e) => e.turnId === second)
      .map((e) => e.message.id),
  ).toEqual(["n1"]); // got []
  expect(t.dones().some((d) => d.id === second)).toBe(false); // the Stop finished "Second" instead
});

test("the Stop arriving just after the next prompt's hook still ends the earlier turn", async () => {
  const t = setup();
  const path = tempFile();
  await t.hook("UserPromptSubmit", { prompt: "Make the Word file", transcript_path: path });
  append(
    path,
    userPrompt("Make the Word file", Date.now() + 1),
    text("m1", "I'll wait for the install and extraction to finish."),
    text("a1", "The install is still running. I'll continue once it finishes."),
  );
  // A background task finishing: Claude Code starts a turn with its notification; that hook wins the race.
  await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
  append(path, {
    type: "user",
    uuid: "u-note",
    timestamp: new Date(Date.now() + 1).toISOString(),
    message: { content: "<task-notification> <task-id>b8cs0uuse</task-id> </task-notification>" },
  });
  await t.hook("UserPromptSubmit", {
    prompt: "<task-notification> <task-id>b8cs0uuse</task-id> </task-notification>",
    transcript_path: path,
  });
  await t.hook("Stop", {
    last_assistant_message: "The install is still running. I'll continue once it finishes.",
    transcript_path: path,
  });
  const [first, second] = t.turnIds() as [string, string];
  expect(t.dones().map((d) => [d.id, d.summary])).toEqual([
    [first, "The install is still running. I'll continue once it finishes."],
  ]);
  expect(t.dones()[0]?.messages?.map((m) => m.id)).toEqual(["m1"]);
  // The notification's turn is still running and followed; its own Stop ends it.
  expect((t.db.query("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string }).status).toBe(
    "working",
  );
  append(path, text("n1", "The install finished."), text("a2", "The server is ready."));
  await t.hook("PreToolUse", hookTool("x"));
  expect(
    t
      .msgs()
      .filter((e) => e.turnId === second)
      .map((e) => e.message.id),
  ).toEqual(["n1", "a2"]);
  await t.hook("Stop", { last_assistant_message: "The server is ready.", transcript_path: path });
  expect(t.dones().map((d) => [d.id, d.summary])).toEqual([
    [first, "The install is still running. I'll continue once it finishes."],
    [second, "The server is ready."],
  ]);
  expect(t.dones()[1]?.messages?.map((m) => m.id)).toEqual(["n1"]);
});

test("a Stop for a quick new turn that answered at once stays with that turn", async () => {
  const t = setup();
  const path = tempFile();
  await t.hook("UserPromptSubmit", { prompt: "First", transcript_path: path });
  append(path, userPrompt("First", Date.now() + 1), text("w1", "Working on it."));
  // The second prompt replaces the first before its Stop (Esc, then a new prompt), and is answered at once.
  await Bun.sleep(25); // past the +5 ms timestamps of the text written before it
  append(path, userPrompt("Second", Date.now() + 1));
  await t.hook("UserPromptSubmit", { prompt: "Second", transcript_path: path });
  append(path, text("a2", "Yes."));
  await t.hook("Stop", { last_assistant_message: "Yes.", transcript_path: path });
  const [, second] = t.turnIds() as [string, string];
  expect(t.dones().map((d) => [d.id, d.summary])).toEqual([[second, "Yes."]]);
});

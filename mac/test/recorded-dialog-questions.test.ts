// Dialogs recorded from Claude Code 2.1.332 open as phone questions; a kind without a recorded screen only waits.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { DialogWatcher } from "../src/daemon/dialogWatch.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Category, promptAlert } from "../src/daemon/notifier.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";
import { publicSession } from "../src/daemon/registry.ts";

const screen = (name: string) =>
  readFileSync(new URL(`./fixtures/screens/claude-2.1.332-${name}.txt`, import.meta.url), "utf8");

const SESSION = {
  id: "rq",
  status: "waiting",
  canReceive: true,
  updatedAt: Date.now(),
  title: null,
  name: null,
  cwd: "/Users/me/scratch",
  project: "scratch",
  branch: null,
  kind: "interactive",
  terminal: null,
  startedAt: 0,
  lastSummary: null,
  ptySocket: "/tmp/p.sock",
  ptyToken: "tok",
  pid: 4242,
} as unknown as SessionRecord;

async function look(text: string) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const broker = new Broker(db, events);
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events,
    broker,
    hasOpen: (id) => broker.listOpen(id).some((p) => !p.dialog),
    read: async () => text,
  });
  await w.look("rq");
  return { broker, p: broker.listOpen("rq")[0] };
}

const cases = [
  ["mcp-approval", "mcpServer", "Continue without using this MCP server"],
  ["rate-limit-menu", "rateLimit", "Stop and wait for limit to reset"],
  ["exit-with-tasks", "exitTasks", "Exit and stop tasks"],
  ["add-dir-confirm", "confirm", "Yes, add it"],
] as const;

for (const [name, kind, label] of cases) {
  test(`the recorded ${name} screen opens as a ${kind} question with its options`, async () => {
    const { p } = await look(screen(name));
    expect(p?.dialog?.kind).toBe(kind);
    const q = p?.payload.kind === "question" ? p.payload.questions[0] : undefined;
    expect(q?.options.map((o) => o.label)).toContain(label);
    expect(publicSession(SESSION).atMac).toBeUndefined();
  });
}

test("an MCP push carries no answer buttons", async () => {
  const { p } = await look(screen("mcp-approval"));
  const alert = promptAlert(p as never, "scratch");
  expect(alert.category).toBe(Category.notice);
  expect(alert.mutable).toBeUndefined();
  expect(alert.data.options).toBeUndefined();
});

test("a kind without a recorded screen opens no question", async () => {
  const bypass = [
    "─".repeat(80),
    " WARNING: Claude Code running in Bypass Permissions mode",
    "",
    " ❯ 1. No, exit",
    "   2. Yes, I accept",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const { p } = await look(bypass);
  expect(p).toBeUndefined();
});

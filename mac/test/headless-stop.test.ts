import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeadlessSessions } from "../src/daemon/headless.ts";
import type { KeyOps } from "../src/daemon/inject.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { TurnStopper } from "../src/daemon/stop.ts";
import { waitFor } from "./support/wait.ts";

const root = mkdtempSync(join(tmpdir(), "relay-headless-stop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";

/**
 * Stands in for `claude -p --resume … --input-format stream-json`: logs every stdin line and never finishes a turn
 * by itself. An `interrupt` control request is answered like the real one (control_response, interrupted user line, no
 * result), unless a file named `deaf` exists.
 */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const here = import.meta.dir;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "x" });
let buf = "";
for await (const chunk of process.stdin) {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    appendFileSync(here + "/stdin.log", line + "\\n");
    const m = JSON.parse(line);
    if (m.type === "control_request" && m.request.subtype === "interrupt" && !existsSync(here + "/deaf"))
{
      // What a real claude does (checked): a success control_response, then the interrupted user line, no result.
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
      out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    }
  }
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

let db: DB;
let registry: Registry;
let headless: HeadlessSessions;
let rpc: ReturnType<typeof createRpc>;
let tools: string;
let work: string;
let inboxCalls: string[];

const call = (method: string, params: unknown = {}) => rpc(method, params, "device:test");
const stdinLines = (): { type: string; request?: { subtype: string } }[] => {
  try {
    return readFileSync(join(tools, "stdin.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const interrupts = () => stdinLines().filter((m) => m.type === "control_request");

beforeEach(() => {
  db = openDb(":memory:");
  const events = new EventLog(db);
  registry = new Registry(db, events);
  const broker = new Broker(db, events);
  tools = mkdtempSync(join(root, "bin-"));
  work = realpathSync(mkdtempSync(join(root, "work-")));
  const claudeBin = fakeClaude(tools);
  headless = new HeadlessSessions({ registry, claudeBin, openPrompt: () => new Promise(() => {}) });
  registry.ownedByHelper = (id) => headless.has(id);
  inboxCalls = [];
  const keys: KeyOps = {
    pty: async () => {
      throw new Error("the tab is gone");
    },
    tmux: async () => {
      throw new Error("no pane");
    },
    routes: () => [],
    app: async () => false,
    ttyOf: async () => null,
  };
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config: { previewChars: 600 },
    keys,
    inbox: async (path) => {
      inboxCalls.push(path);
    },
    timing: { inboxMs: 50, graceMs: 10, markerMs: 100, pollMs: 10 },
  });
  stopper.headless = headless;
  rpc = createRpc({
    db,
    events,
    registry,
    broker,
    claudeBin,
    headless,
    stopper,
    hasTranscript: () => true,
    config: { preferTyping: false },
  } as unknown as RpcDeps);
});

function ended(socketPath: string | null) {
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, pid, socket_path, started_at, updated_at, ended_at) VALUES (?, ?, 'proj', 'ended', NULL, ?, 1000, 2000, 2000)",
  ).run(ID, work, socketPath);
}

async function resumed(socketPath: string | null) {
  ended(socketPath);
  await call("session.resume", { sessionId: ID, text: "carry on" });
  await waitFor(() => stdinLines().length === 1);
  expect(registry.get(ID)?.status).toBe("working");
}

test("Stop tells the owned process to interrupt, and the session is no longer working", async () => {
  await resumed(null);
  const res = (await call("session.interrupt", { sessionId: ID })) as { error?: unknown; via?: string };
  expect(res.error).toBeUndefined();
  expect(res).toMatchObject({ result: { via: "headless" } });
  expect(interrupts().map((m) => m.request?.subtype)).toEqual(["interrupt"]);
  expect(headless.has(ID)).toBe(true);
  expect(registry.get(ID)?.status).toBe("idle");
  headless.stopAll();
});

test("Stop never posts to the closed terminal's inbox socket", async () => {
  await resumed(join(root, "closed-terminal.sock"));
  const res = (await call("session.interrupt", { sessionId: ID })) as { error?: unknown };
  expect(res.error).toBeUndefined();
  expect(inboxCalls).toEqual([]);
  expect(interrupts()).toHaveLength(1);
  headless.stopAll();
});

test("an open turn ends as stopped", async () => {
  await resumed(null);
  db.query("INSERT INTO turns (id, session_id, started_at, prompt) VALUES ('t1', ?, 1000, 'carry on')").run(
    ID,
  );
  const res = (await call("session.interrupt", { sessionId: ID })) as { result?: { turnId: string | null } };
  const row = db.query("SELECT stopped, ended_at FROM turns WHERE id = 't1'").get() as {
    stopped: number;
    ended_at: number | null;
  };
  expect(row.stopped).toBe(1);
  expect(row.ended_at).not.toBeNull();
  expect(res).toMatchObject({ result: { turnId: "t1" } });
  headless.stopAll();
});

test("a process that ignores the interrupt is ended, not left working", async () => {
  await resumed(null);
  writeFileSync(join(tools, "deaf"), "");
  expect(await headless.interrupt(ID, 150)).toBe("ended");
  expect(headless.has(ID)).toBe(false);
  expect(registry.get(ID)?.status).toBe("ended");
});

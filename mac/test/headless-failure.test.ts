import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeadlessSessions } from "../src/daemon/headless.ts";
import { Registry } from "../src/daemon/registry.ts";
import { TurnStopper } from "../src/daemon/stop.ts";
import { waitFor } from "./support/wait.ts";

const root = mkdtempSync(join(tmpdir(), "relay-headless-failure-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";
const TURN = "turn-1";

/** A stand-in for `claude -p --resume`; files in its folder pick what it does after the first message. */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { existsSync, readFileSync } from "node:fs";
const here = import.meta.dir;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "x" });
let buf = "";
for await (const chunk of process.stdin) {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (m.type === "control_request") {
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id } });
      continue;
    }
    if (m.type !== "user") continue;
    if (existsSync(here + "/stderr")) process.stderr.write(readFileSync(here + "/stderr", "utf8"));
    if (existsSync(here + "/exit")) process.exit(1);
    if (existsSync(here + "/apiError"))
      out({ type: "result", subtype: "success", is_error: true, result: readFileSync(here + "/apiError", "utf8") });
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
let tools: string;
let notices: string[];
let failed: { turnId: string; text?: string }[];
let open: string | null;

beforeEach(() => {
  db = openDb(":memory:");
  registry = new Registry(db, new EventLog(db));
  tools = mkdtempSync(join(root, "bin-"));
  const work = realpathSync(mkdtempSync(join(root, "work-")));
  notices = [];
  failed = [];
  open = TURN;
  headless = new HeadlessSessions({
    registry,
    claudeBin: fakeClaude(tools),
    openPrompt: () => new Promise(() => {}),
    notice: (_id, text) => notices.push(text),
    turns: {
      openId: () => open,
      fail: (turnId, text) => {
        failed.push({ turnId, text });
        open = null;
      },
    },
    errorGraceMs: 80,
  });
  registry.ownedByHelper = (id) => headless.has(id);
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, pid, socket_path, started_at, updated_at, ended_at) VALUES (?, ?, 'proj', 'ended', NULL, NULL, 1000, 2000, 2000)",
  ).run(ID, work);
});

const session = () => registry.get(ID) as NonNullable<ReturnType<Registry["get"]>>;
const mark = (name: string, text = "") => writeFileSync(join(tools, name), text);

test("a process that exits by itself gives one notice with its last stderr line, and fails the open turn", async () => {
  mark("stderr", "warming up\nfatal: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rejected\n");
  mark("exit");
  await headless.resume(session(), "carry on");
  await waitFor(() => notices.length === 1);
  const notice = notices[0] ?? "";
  expect(notice).toStartWith("Claude Code stopped: fatal: token");
  expect(notice).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(notice.length).toBeLessThanOrEqual(230);
  expect(failed).toEqual([{ turnId: TURN, text: undefined }]);
  expect(registry.get(ID)?.status).toBe("ended");
});

test("a process that exits without stderr gets a plain sentence", async () => {
  mark("exit");
  await headless.resume(session(), "carry on");
  await waitFor(() => notices.length === 1);
  expect(notices).toEqual(["Claude Code stopped by itself."]);
});

test("a stop Relay asked for gives no notice and fails no turn", async () => {
  await headless.resume(session(), "carry on");
  headless.stopAll();
  await Bun.sleep(400);
  expect(notices).toEqual([]);
  expect(failed).toEqual([]);

  registry.setStatus(ID, "ended");
  await headless.resume(session(), "again");
  headless.holdStatus(ID);
  headless.release(ID);
  await Bun.sleep(400);
  expect(notices).toEqual([]);
  expect(failed).toEqual([]);
});

test("a result with is_error and no StopFailure hook fails the turn with its redacted text", async () => {
  mark("apiError", "Usage limit reached. key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  await headless.resume(session(), "carry on");
  await waitFor(() => failed.length === 1);
  const text = failed[0]?.text ?? "";
  expect(failed[0]?.turnId).toBe(TURN);
  expect(text).toStartWith("Usage limit reached.");
  expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  expect(notices).toEqual([text]);
});

test("a turn the StopFailure hook already ended produces no second notice", async () => {
  mark("apiError", "Overloaded");
  await headless.resume(session(), "carry on");
  open = null;
  await Bun.sleep(400);
  expect(notices).toEqual([]);
  expect(failed).toEqual([]);
  expect(existsSync(join(tools, "apiError"))).toBe(true);
});

test("the stopper ends the turn as failed without a push, with the error text", async () => {
  const events = new EventLog(db);
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    config: { previewChars: 600 },
    transcriptPath: () => null,
  } as unknown as ConstructorParameters<typeof TurnStopper>[0]);
  db.query("INSERT INTO turns (id, session_id, prompt, started_at) VALUES (?, ?, 'hi', 1500)").run(TURN, ID);
  stopper.endFailed(TURN, "Usage limit reached.");
  const row = db.query("SELECT failed, full_text, ended_at FROM turns WHERE id = ?").get(TURN) as {
    failed: number;
    full_text: string;
    ended_at: number | null;
  };
  expect(row.failed).toBe(1);
  expect(row.full_text).toBe("Usage limit reached.");
  expect(row.ended_at).not.toBeNull();
});

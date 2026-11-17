import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeadlessSessions } from "../src/daemon/headless.ts";
import { HookHandler, notePhoneTyped } from "../src/daemon/hooks.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { waitFor } from "./support/wait.ts";

// A session the helper continues has no keyboard at the Mac: its prompts are the phone's, however late the hook
// arrives and however many messages are waiting. A prompt typed into a terminal session still is Mac activity.

const root = mkdtempSync(join(tmpdir(), "relay-headless-presence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = "9a1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";

function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const here = import.meta.dir;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "x" }) + "\\n");
let buf = "";
for await (const chunk of process.stdin) {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (m.type === "user") appendFileSync(here + "/lines.log", m.message.content + "\\n");
  }
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

let db: DB;
let events: EventLog;
let registry: Registry;
let headless: HeadlessSessions;
let hooks: HookHandler;
let rpc: ReturnType<typeof createRpc>;
let tools: string;
let work: string;
let localActivity = 0;
let seen: RelayEvent[] = [];

const call = (method: string, params: unknown = {}) => rpc(method, params, "device:test");
const lines = () => {
  try {
    return readFileSync(join(tools, "lines.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};
const submit = (prompt: string, id = ID) =>
  hooks.handle(
    { payload: { hook_event_name: "UserPromptSubmit", session_id: id, cwd: work, prompt }, env: {} as never },
    new AbortController().signal,
  );
const photo = (id: string, name: string) => {
  const path = join(work, "attachments", id, `${name}-photo.png`);
  db.query(
    "INSERT INTO attachments (id, session_id, name, mime, size, sha256, path, created_at, finished_at) VALUES (?, ?, 'photo.png', 'image/png', 10, 'x', ?, ?, ?)",
  ).run(name, id, path, Date.now(), Date.now());
  return path;
};

beforeEach(() => {
  db = openDb(":memory:");
  events = new EventLog(db);
  registry = new Registry(db, events);
  const broker = new Broker(db, events);
  seen = [];
  events.subscribe((e) => seen.push(e));
  localActivity = 0;
  tools = mkdtempSync(join(root, "bin-"));
  work = realpathSync(mkdtempSync(join(root, "work-")));
  mkdirSync(work, { recursive: true });
  hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence: {
      noteLocalActivity() {
        localActivity++;
      },
      get: () => ({}),
    },
    config: { previewChars: 600 },
  } as unknown as ConstructorParameters<typeof HookHandler>[0]);
  const claudeBin = fakeClaude(tools);
  headless = new HeadlessSessions({
    registry,
    claudeBin,
    openPrompt: (input, signal) => hooks.openPrompt(input, signal),
  });
  registry.ownedByHelper = (id) => headless.has(id);
  rpc = createRpc({
    db,
    events,
    registry,
    broker,
    claudeBin,
    headless,
    hasTranscript: () => true,
    config: { preferTyping: false },
  } as unknown as RpcDeps);
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, pid, started_at, updated_at, ended_at) VALUES (?, ?, 'proj', 'ended', NULL, 1000, 2000, 2000)",
  ).run(ID, work);
});

afterEach(() => {
  setSystemTime();
  headless.stopAll();
});

const resume = async (text = "first") => {
  await call("session.resume", { sessionId: ID, text });
  expect(headless.has(ID)).toBe(true);
};

const startedAttachments = () =>
  seen
    .filter((e): e is Extract<RelayEvent, { type: "turn.started" }> => e.type === "turn.started")
    .map((e) => e.attachments?.map((a) => a.id) ?? []);

describe("prompts of a session the helper runs", () => {
  test("the resume's own message is not Mac activity", async () => {
    await resume();
    await submit("first");
    expect(localActivity).toBe(0);
  });

  test("two phone messages in a row are not Mac activity", async () => {
    await resume();
    await submit("first");
    await call("session.send", { sessionId: ID, text: "also run the tests" });
    await call("session.send", { sessionId: ID, text: "and lint" });
    await waitFor(() => lines().length === 3, 30_000, "both lines");
    await submit("also run the tests");
    await submit("and lint");
    expect(localActivity).toBe(0);
  });

  test("a hook 16 seconds after the message is not Mac activity", async () => {
    await resume();
    await submit("first");
    await call("session.send", { sessionId: ID, text: "also run the tests" });
    setSystemTime(new Date(Date.now() + 16_000));
    await submit("also run the tests");
    expect(localActivity).toBe(0);
  });

  test("the resume's first prompt 16 seconds after the resume is not Mac activity", async () => {
    await resume();
    setSystemTime(new Date(Date.now() + 16_000));
    await submit("first");
    expect(localActivity).toBe(0);
  });

  test("each of two messages keeps its photo on its own turn", async () => {
    await resume();
    await submit("first");
    const a = photo(ID, "pa");
    const b = photo(ID, "pb");
    await call("session.send", { sessionId: ID, text: `look\n${a}` });
    await call("session.send", { sessionId: ID, text: `and this\n${b}` });
    await submit("look [Image #1]");
    await submit("and this [Image #1]");
    expect(startedAttachments().slice(-2)).toEqual([["pa"], ["pb"]]);
  });
});

describe("a terminal session", () => {
  test("a prompt typed at the Mac is Mac activity, and a phone message is not", async () => {
    const id = "term-1";
    db.query(
      "INSERT INTO sessions (id, cwd, project, status, pid, started_at, updated_at) VALUES (?, ?, 'proj', 'idle', NULL, 1000, 2000)",
    ).run(id, work);
    notePhoneTyped(id, "from the phone");
    await submit("from the phone", id);
    expect(localActivity).toBe(0);
    await submit("typed at the desk", id);
    expect(localActivity).toBe(1);
  });
});

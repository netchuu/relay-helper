import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeadlessSessions, resumeCommand, userLine } from "../src/daemon/headless.ts";
import { Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { waitFor } from "./support/wait.ts";

const root = mkdtempSync(join(tmpdir(), "relay-headless-confirm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";

/**
 * A stand-in for `claude -p --resume --replay-user-messages`. Files in its folder pick what it does: `lifecycle` sends
 * queued lines like Claude Code 2.1.330 (a turn that never ends, so later messages queue behind it), `dieOnSecond`
 * exits on the second line without naming it, `echo` answers with a user echo only.
 */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const here = import.meta.dir;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const init = () => out({ type: "system", subtype: "init", session_id: "x" });
let buf = "";
let n = 0;
for await (const chunk of process.stdin) {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (m.type !== "user") continue;
    appendFileSync(here + "/lines.log", JSON.stringify(m) + "\\n");
    n++;
    if (n === 1 && !existsSync(here + "/lifecycle")) init();
    if (n === 2 && existsSync(here + "/dieOnSecond")) process.exit(1);
    if (existsSync(here + "/lifecycle")) {
      out({ type: "system", subtype: "command_lifecycle", command_uuid: m.uuid, state: "queued" });
      if (n === 1) init();
    }
    else if (existsSync(here + "/unknownState")) out({ type: "system", subtype: "command_lifecycle", command_uuid: m.uuid, state: "weird" });
    else if (existsSync(here + "/echo")) out({ type: "user", uuid: m.uuid, isReplay: true, message: m.message });
    else out({ type: "result", subtype: "success", user_message_uuids: [m.uuid] });
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
let session: SessionRecord;

const mode = (name: string) => writeFileSync(join(tools, name), "");
const logged = (): { uuid?: string; message: { content: string } }[] => {
  try {
    return readFileSync(join(tools, "lines.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

beforeEach(() => {
  db = openDb(":memory:");
  registry = new Registry(db, new EventLog(db));
  tools = mkdtempSync(join(root, "bin-"));
  const work = realpathSync(mkdtempSync(join(root, "work-")));
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, pid, started_at, updated_at, ended_at) VALUES (?, ?, 'proj', 'ended', NULL, 1000, 2000, 2000)",
  ).run(ID, work);
  session = registry.get(ID) as SessionRecord;
  headless = new HeadlessSessions({
    registry,
    claudeBin: fakeClaude(tools),
    openPrompt: () => new Promise(() => {}),
  });
});

test("the command asks Claude Code to echo user messages and every line has a uuid", () => {
  expect(resumeCommand("claude", ID)).toContain("--replay-user-messages");
  expect(JSON.parse(userLine("hi")).uuid).toMatch(/^[0-9a-f-]{36}$/);
});

test("a message sent while an earlier turn runs is delivered once it is queued", async () => {
  mode("lifecycle");
  await headless.resume(session, "first");
  // The fake never finishes a turn: only the queued line can answer.
  await headless.send(ID, "second");
  const lines = logged();
  expect(lines.map((l) => l.message.content)).toEqual(["first", "second"]);
  expect(lines.every((l) => typeof l.uuid === "string")).toBe(true);
  headless.stopAll();
});

test("a process that ends before reading a message fails the send", async () => {
  mode("lifecycle");
  mode("dieOnSecond");
  await headless.resume(session, "first");
  await expect(headless.send(ID, "second")).rejects.toThrow("stopped before it got the message");
});

test("without command_lifecycle a message is delivered on the write, and lost if the process ends unread", async () => {
  mode("dieOnSecond");
  await headless.resume(session, "first");
  let lost = 0;
  await headless.send(ID, "second", () => lost++);
  await waitFor(() => lost === 1, 10_000, "the lost message");
});

test("without command_lifecycle a message that is named is not lost", async () => {
  let lost = 0;
  await headless.resume(session, "first", undefined, () => lost++);
  await headless.send(ID, "second", () => lost++);
  await Bun.sleep(100);
  expect(lost).toBe(0);
  headless.stopAll();
});

test("a user echo names the message too", async () => {
  mode("echo");
  let lost = 0;
  await headless.resume(session, "first", undefined, () => lost++);
  await headless.send(ID, "second", () => lost++);
  await Bun.sleep(100);
  headless.stopAll();
  await Bun.sleep(100);
  expect(lost).toBe(0);
});

test("a lifecycle state it doesn't know says nothing", async () => {
  mode("unknownState");
  mode("dieOnSecond");
  await headless.resume(session, "first");
  await Bun.sleep(100);
  let lost = 0;
  // Not taken as confirmation: the send is delivered on the write, then lost when the process ends unread.
  await headless.send(ID, "second", () => lost++);
  await waitFor(() => lost === 1, 10_000, "the lost message");
  expect(lost).toBe(1);
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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
import { RpcSchemas, SendResult, type Session, SessionResumed } from "../../protocol/index.ts";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HeadlessSessions, resumeCommand } from "../src/daemon/headless.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { processAlive, publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { waitFor } from "./support/wait.ts";

const root = mkdtempSync(join(tmpdir(), "relay-resume-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";

/** A stand-in for `claude -p --resume`: records its arguments, logs user lines, answers with a result, asks `can_use_tool` on request. */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const here = import.meta.dir;
if (existsSync(here + "/refuse")) { console.error("No conversation found with session ID"); process.exit(1); }
writeFileSync(here + "/argv.json", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), internal: process.env.RELAY_INTERNAL ?? null }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (existsSync(here + "/slow")) await new Promise((r) => setTimeout(r, 400));
if (!existsSync(here + "/silent")) out({ type: "system", subtype: "init", session_id: "x" });
let buf = "";
for await (const chunk of process.stdin) {
  buf += chunk;
  for (let nl = buf.indexOf("\\n"); nl >= 0; nl = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (m.type === "user") {
      appendFileSync(here + "/lines.log", m.message.content + "\\n");
      if (m.message.content.includes("needs permission"))
        out({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, permission_suggestions: [] } });
      else if (m.message.content.includes("cancelled request")) {
        out({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, permission_suggestions: [] } });
        out({ type: "control_cancel_request", request_id: "r1" });
      }
      else out({ type: "result", subtype: "success" });
    } else if (m.type === "control_response") {
      appendFileSync(here + "/answers.log", JSON.stringify(m.response) + "\\n");
      out({ type: "result", subtype: "success" });
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
let broker: Broker;
let headless: HeadlessSessions;
let rpc: ReturnType<typeof createRpc>;
let tools: string;
let work: string;
let events: EventLog;

const call = (method: string, params: unknown = {}) => rpc(method, params, "device:test");
const lines = () => {
  try {
    return readFileSync(join(tools, "lines.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};
const answers = () => {
  try {
    return readFileSync(join(tools, "answers.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const until = (check: () => boolean, ms = 30_000) => waitFor(check, ms, "the condition");

/** A session whose terminal is closed: ended, in `work`. */
function ended(id = ID, pid: number | null = null, status = "ended") {
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, pid, started_at, updated_at, ended_at) VALUES (?, ?, 'proj', ?, ?, 1000, 2000, 2000)",
  ).run(id, work, status, pid);
}

function build(initTimeoutMs?: number) {
  const claudeBin = fakeClaude(tools);
  headless = new HeadlessSessions({
    registry,
    claudeBin,
    initTimeoutMs,
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
}

let hooks: HookHandler;

beforeEach(() => {
  db = openDb(":memory:");
  events = new EventLog(db);
  registry = new Registry(db, events);
  broker = new Broker(db, events);
  tools = mkdtempSync(join(root, "bin-"));
  work = realpathSync(mkdtempSync(join(root, "work-")));
  mkdirSync(work, { recursive: true });
  hooks = new HookHandler({
    db,
    events,
    registry,
    broker,
    presence: { noteLocalActivity() {}, get: () => ({}) },
    config: { previewChars: 600 },
  } as unknown as ConstructorParameters<typeof HookHandler>[0]);
  build();
});

describe("session.resume", () => {
  test("resumes an ended session headless with the first message, and the list says it runs in the helper", async () => {
    ended();
    const seen: Session[] = [];
    events.subscribe((e) => {
      if (e.type === "session.upsert") seen.push(e.session);
    });
    const res = (await call("session.resume", {
      sessionId: ID,
      text: "carry on",
    })) as { result: unknown };
    expect(SessionResumed.parse(res.result)).toEqual({ via: "headless" });

    const started = JSON.parse(readFileSync(join(tools, "argv.json"), "utf8"));
    expect(started.argv).toEqual(resumeCommand("claude", ID).slice(1));
    expect(started.cwd).toBe(work);
    // The session keeps reporting through the hooks, so the helper doesn't mark the process internal.
    expect(started.internal).toBeNull();
    await until(() => lines().length === 1);
    expect(lines()).toEqual(["carry on"]);

    const s = registry.get(ID);
    expect(s?.status).toBe("working");
    expect(s?.canReceive).toBe(true);
    const shown = (await call("sessions.list")) as { result: Session[] };
    const mine = shown.result.find((x) => x.id === ID);
    expect(mine?.runsInHelper).toBe(true);
    expect(mine?.replyRoute).toBe("typed");
    expect(seen.at(-1)?.runsInHelper).toBe(true);
  });

  test("a later send goes to the same process", async () => {
    ended();
    await call("session.resume", { sessionId: ID, text: "first" });
    const pid = headless.pidOf(ID);
    const res = (await call("session.send", {
      sessionId: ID,
      text: "second",
    })) as { result: unknown };
    expect(SendResult.parse(res.result)).toEqual({ via: "headless" });
    await until(() => lines().length === 2);
    expect(lines()).toEqual(["first", "second"]);
    expect(headless.pidOf(ID)).toBe(pid);
  });

  test("a permission request reaches the phone as a prompt, and the answer goes back to the process", async () => {
    ended();
    await call("session.resume", { sessionId: ID, text: "first" });
    await call("session.send", {
      sessionId: ID,
      text: "this needs permission",
    });
    await until(() => broker.listOpen(ID).length === 1);
    const prompt = broker.listOpen(ID)[0];
    expect(prompt?.kind).toBe("permission");
    expect(registry.get(ID)?.status).toBe("waiting");

    const ok = await call("prompt.answer", {
      promptId: prompt?.id,
      answer: { kind: "permission", action: "allow" },
    });
    expect(ok).toEqual({ result: expect.anything() });
    await until(() => answers().length === 1);
    expect(answers()[0]).toEqual({
      subtype: "success",
      request_id: "r1",
      response: { behavior: "allow", updatedInput: { command: "ls" } },
    });

    // A denial carries the sentence Claude gets.
    await call("session.send", {
      sessionId: ID,
      text: "again, needs permission",
    });
    await until(() => broker.listOpen(ID).length === 1);
    await call("prompt.answer", {
      promptId: broker.listOpen(ID)[0]?.id,
      answer: { kind: "permission", action: "deny", reason: "not now" },
    });
    await until(() => answers().length === 2);
    expect(answers()[1].response.behavior).toBe("deny");
    expect(answers()[1].response.message).toContain("not now");
  });

  test("the hook and the process asking for the same tool call open one prompt", async () => {
    ended();
    await call("session.resume", { sessionId: ID, text: "first" });
    await call("session.send", {
      sessionId: ID,
      text: "this needs permission",
    });
    await until(() => broker.listOpen(ID).length === 1);
    const hook = await hooks.handle(
      {
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: ID,
          cwd: work,
          tool_name: "Bash",
          tool_input: { command: "ls" },
        },
        env: {} as never,
      },
      new AbortController().signal,
    );
    expect(hook.stdout ?? "").toBe("");
    expect(broker.listOpen(ID)).toHaveLength(1);
  });

  test("Claude Code cancelling a request closes its prompt and nothing is answered", async () => {
    ended();
    await call("session.resume", { sessionId: ID, text: "first" });
    await call("session.send", { sessionId: ID, text: "a cancelled request" });
    await until(() => lines().length === 2);
    await Bun.sleep(300);
    expect(broker.listOpen(ID)).toEqual([]);
    expect(answers()).toEqual([]);
  });

  test("a resume that is still starting is delivered, and Try Again with its sendId isn't typed twice", async () => {
    ended();
    writeFileSync(join(tools, "slow"), "");
    const sendId = "send-1";
    const resuming = call("session.resume", {
      sessionId: ID,
      text: "carry on",
      sendId,
    });
    await Bun.sleep(100);
    // The fake takes 400 ms to answer init: the answer must come well before it.
    const early = await Promise.race([
      call("session.delivered", { sessionId: ID, sendId }),
      Bun.sleep(200).then(() => "late"),
    ]);
    expect(early).toEqual({ result: { delivered: true, via: "headless" } });
    const retried = await call("session.send", {
      sessionId: ID,
      text: "carry on",
      sendId,
    });
    expect(retried).toEqual({ result: { via: "headless", repeat: true } });
    await resuming;
    await Bun.sleep(100);
    expect(lines()).toEqual(["carry on"]);
    expect(await call("session.delivered", { sessionId: ID, sendId })).toEqual({
      result: { delivered: true, via: "headless" },
    });
  });

  test("a resume that fails is not remembered as delivered", async () => {
    ended();
    writeFileSync(join(tools, "refuse"), "");
    const sendId = "send-2";
    const failed = await call("session.resume", {
      sessionId: ID,
      text: "carry on",
      sendId,
    });
    expect(failed).toEqual({ error: expect.anything() });
    expect(await call("session.delivered", { sessionId: ID, sendId })).toEqual({
      result: { delivered: false },
    });
  });

  test("a message sent while the resume still waits for Claude Code follows it", async () => {
    ended();
    writeFileSync(join(tools, "slow"), "");
    const resuming = call("session.resume", { sessionId: ID, text: "first" });
    await Bun.sleep(100);
    expect(registry.get(ID)?.status).toBe("ended");
    const second = await call("session.send", {
      sessionId: ID,
      text: "second",
    });
    expect(second).toEqual({ result: expect.anything() });
    await resuming;
    await until(() => lines().length === 2);
    expect(lines()).toEqual(["first", "second"]);
  });

  test("a prompt nobody answered becomes a denial when the process goes away, not a hang", async () => {
    ended();
    await call("session.resume", {
      sessionId: ID,
      text: "this needs permission",
    });
    await until(() => broker.listOpen(ID).length === 1);
    headless.stopAll();
    expect(broker.listOpen(ID)).toEqual([]);
    expect(registry.get(ID)?.status).toBe("ended");
  });

  test("never resumes a session whose process is alive, or one that already runs here", async () => {
    // Alive: this very test process stands in for the terminal's Claude Code.
    ended(ID, process.pid);
    const alive = (await call("session.resume", {
      sessionId: ID,
      text: "hi",
    })) as {
      error: { code: string; message: string; canResume?: true };
    };
    expect(alive.error.code).toBe("conflict");
    expect(alive.error.message).toContain("still running");
    expect(alive.error.canResume).toBeUndefined();

    // Listed as running, process unknown: refused as well.
    ended("11111111-aaaa-bbbb-cccc-ddddeeeeffff", null, "idle");
    const listed = (await call("session.resume", {
      sessionId: "11111111-aaaa-bbbb-cccc-ddddeeeeffff",
      text: "hi",
    })) as { error: { code: string } };
    expect(listed.error.code).toBe("conflict");

    // Nothing was started for either.
    expect(lines()).toEqual([]);
    expect(headless.has(ID)).toBe(false);

    // Once it runs here, a second request is refused too (and the same one twice at once starts one copy).
    db.query("UPDATE sessions SET pid = NULL WHERE id = ?").run(ID);
    const both = await Promise.all([
      call("session.resume", { sessionId: ID, text: "one" }),
      call("session.resume", { sessionId: ID, text: "two" }),
    ]);
    const codes = both.map((r) => ("error" in r ? r.error.code : "ok")).sort();
    expect(codes).toEqual(["conflict", "ok"]);
    const again = (await call("session.resume", {
      sessionId: ID,
      text: "three",
    })) as {
      error: { code: string };
    };
    expect(again.error.code).toBe("conflict");
    await until(() => lines().length === 1);
    expect(lines()).toHaveLength(1);
  });

  test("a send to a session with no live process says it can be resumed; a live one doesn't", async () => {
    ended();
    const gone = (await call("session.send", {
      sessionId: ID,
      text: "hi",
    })) as {
      error: { code: string; canResume?: true };
    };
    expect(gone.error).toMatchObject({ code: "not_found", canResume: true });

    db.query("UPDATE sessions SET pid = ? WHERE id = ?").run(process.pid, ID);
    const live = (await call("session.send", {
      sessionId: ID,
      text: "hi",
    })) as {
      error: { canResume?: true };
    };
    expect(live.error.canResume).toBeUndefined();
  });

  test("the process is stopped with the daemon", async () => {
    ended();
    await call("session.resume", { sessionId: ID, text: "first" });
    const pid = headless.pidOf(ID) as number;
    expect(processAlive(pid)).toBe(true);
    headless.stopAll();
    expect(headless.has(ID)).toBe(false);
    await until(() => !processAlive(pid));
    // The session list no longer says it runs in the helper.
    expect(publicSession(registry.get(ID) as NonNullable<ReturnType<typeof registry.get>>).runsInHelper).toBe(
      undefined,
    );
  });

  test("a Claude Code that refuses or stays silent fails the request with a plain sentence", async () => {
    ended();
    writeFileSync(join(tools, "refuse"), "");
    const refused = (await call("session.resume", {
      sessionId: ID,
      text: "hi",
    })) as {
      error: { code: string; message: string };
    };
    expect(refused.error.code).toBe("unavailable");
    expect(refused.error.message).toContain("No conversation found");
    expect(headless.has(ID)).toBe(false);

    rmSync(join(tools, "refuse"));
    writeFileSync(join(tools, "silent"), "");
    build(300);
    const silent = (await call("session.resume", {
      sessionId: ID,
      text: "hi",
    })) as {
      error: { code: string; message: string };
    };
    expect(silent.error.code).toBe("unavailable");
    expect(silent.error.message).toContain("didn't answer");
    expect(headless.has(ID)).toBe(false);
  });

  test("an unknown session is not_found, and an empty message is refused", async () => {
    const missing = (await call("session.resume", {
      sessionId: "nope",
      text: "hi",
    })) as {
      error: { code: string };
    };
    expect(missing.error.code).toBe("not_found");
    const empty = (await call("session.resume", {
      sessionId: ID,
      text: "",
    })) as { error: { code: string } };
    expect(empty.error.code).toBe("bad_request");
  });
});

describe("protocol fixtures (resume.json)", () => {
  const f = JSON.parse(readFileSync(join(import.meta.dir, "../../protocol/fixtures/resume.json"), "utf8"));
  test("decode with the schemas", () => {
    expect(RpcSchemas["session.resume"].parse(f.params)).toEqual(f.params);
    expect(SessionResumed.parse(f.result)).toEqual({ via: "headless" });
    expect(f.session.runsInHelper).toBe(true);
    expect(f.sendRefused.error.canResume).toBe(true);
    expect(f.refused[0].error.canResume).toBeUndefined();
  });
});

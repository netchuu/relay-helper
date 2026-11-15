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
import {
  HostInfo,
  type RelayEvent,
  RpcSchemas,
  type Session,
  SessionDirectory,
  SessionStarted,
} from "../../protocol/index.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { sessionDirectories, startCommand } from "../src/daemon/startSession.ts";
import { hostInfo, setCanStartSessions } from "../src/platform/index.ts";

const root = mkdtempSync(join(tmpdir(), "relay-start-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A stand-in for `claude`: `--bg -- <prompt>` writes its arguments, folder and prompt where the test reads them and
 * prints the short id like Claude Code does; `agents --json --all` lists the session it "started".
 */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
here="$(dirname "$0")"
if [ "$1" = "agents" ]; then
  [ -f "$here/started.json" ] && cat "$here/started.json" || echo "[]"
  exit 0
fi
if [ -f "$here/refuse" ]; then
  echo "Workspace not trusted." >&2
  exit 1
fi
printf '%s\\n' "$@" > "$here/argv.txt"
pwd > "$here/cwd.txt"
echo "RELAY_INTERNAL=\${RELAY_INTERNAL-unset}" > "$here/env.txt"
shift 2
printf '%s' "$1" > "$here/prompt.txt"
[ -f "$here/unlisted" ] && { [ -f "$here/silent" ] && echo "backgrounded" || echo "backgrounded · 7c1d2e3f"; exit 0; }
cat > "$here/started.json" <<EOF
[{"id":"7c1d2e3f","cwd":"$(pwd)","kind":"background","sessionId":"7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff","name":"cart-fix","state":"busy"}]
EOF
echo "backgrounded · 7c1d2e3f"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

let db: DB;
let registry: Registry;
let log: EventLog;
let upserts: Session[];
let rpc: ReturnType<typeof createRpc>;
let hooks: HookHandler;
let tools: string;
let work: string;

function dirOf(name: string): string {
  const p = join(work, name);
  mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  db = openDb(":memory:");
  const events = new EventLog(db);
  log = events;
  registry = new Registry(db, events);
  upserts = [];
  events.subscribe((e) => {
    if (e.type === "session.upsert") upserts.push(e.session);
  });
  tools = mkdtempSync(join(root, "bin-"));
  work = mkdtempSync(join(root, "work-"));
  rpc = createRpc({
    db,
    events,
    registry,
    claudeBin: fakeClaude(tools),
  } as unknown as RpcDeps);
  hooks = new HookHandler({
    db,
    events,
    registry,
    broker: { settleFromSessionEvent() {}, hasOpen: () => false, listOpen: () => [] },
    presence: { noteLocalActivity() {}, get: () => ({}) },
    config: { previewChars: 600 },
  } as unknown as ConstructorParameters<typeof HookHandler>[0]);
});

/** A past session in `cwd`, at `updatedAt`. */
function past(id: string, cwd: string, updatedAt: number, ended = false, project = "proj") {
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, cwd, project, ended ? "ended" : "idle", updatedAt - 1000, updatedAt, ended ? updatedAt : null);
}

const call = (method: string, params: unknown = {}) => rpc(method, params, "device:test");

describe("sessions.directories", () => {
  test("lists each folder once, most recent first, ended sessions included", async () => {
    const a = dirOf("a");
    const b = dirOf("b");
    past("s1", a, 1000);
    past("s2", b, 3000, true, "bee");
    past("s3", a, 2000, true);
    const res = await call("sessions.directories");
    const list = (res as { result: unknown[] }).result.map((d) => SessionDirectory.parse(d));
    expect(list).toEqual([
      { path: b, project: "bee", lastUsedAt: 3000 },
      { path: a, project: "proj", lastUsedAt: 2000 },
    ]);
  });

  test("leaves out a directory that was deleted", async () => {
    const a = dirOf("a");
    const gone = dirOf("gone");
    past("s1", a, 1000);
    past("s2", gone, 2000);
    rmSync(gone, { recursive: true });
    const list = sessionDirectories(db);
    expect(list.map((d) => d.path)).toEqual([a]);
  });

  test("a file in place of a folder isn't listed", () => {
    const f = join(work, "file");
    writeFileSync(f, "x");
    past("s1", f, 1000);
    expect(sessionDirectories(db)).toEqual([]);
  });
});

describe("session.start", () => {
  test("starts a background session in the folder, with the first message as its prompt", async () => {
    const a = dirOf("a");
    past("old", a, 1000, true);
    const text = `Fix "the cart" $(whoami) \`id\`; echo 'x' \\n -- --dangerously-skip-permissions\nline two`;
    const res = (await call("session.start", { directory: a, text })) as { result: unknown };
    expect(SessionStarted.parse(res.result).sessionId).toBe("7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff");
    // The message went in as one argument, untouched.
    expect(readFileSync(join(tools, "prompt.txt"), "utf8")).toBe(text);
    expect(realpathSync(readFileSync(join(tools, "cwd.txt"), "utf8").trim())).toBe(realpathSync(a));

    // It shows up as a background session in that folder, named by Claude Code.
    const listed = ((await call("sessions.list")) as { result: Session[] }).result;
    const s = listed.find((x) => x.id === "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff");
    expect(s?.kind).toBe("background");
    expect(s?.cwd).toBe(a);
    expect(s?.name).toBe("cart-fix");
    expect(upserts.some((u) => u.id === s?.id)).toBe(true);

    // Claude Code's hooks then bring the first turn, as for any session.
    const events: RelayEvent[] = [];
    log.subscribe((e) => events.push(e));
    await hooks.handle(
      {
        env: {},
        payload: { hook_event_name: "UserPromptSubmit", session_id: s?.id, cwd: a, prompt: text },
      } as never,
      new AbortController().signal,
    );
    const turn = events.find((e) => e.type === "turn.started");
    expect(turn && "prompt" in turn ? turn.prompt : null).toContain("Fix");
  });

  test("the launch does not carry RELAY_INTERNAL, even when the helper's own environment has it", async () => {
    const a = dirOf("a");
    past("old", a, 1000, true);
    const before = process.env.RELAY_INTERNAL;
    process.env.RELAY_INTERNAL = "1";
    try {
      await call("session.start", { directory: a, text: "hi" });
    } finally {
      if (before === undefined) delete process.env.RELAY_INTERNAL;
      else process.env.RELAY_INTERNAL = before;
    }
    expect(readFileSync(join(tools, "env.txt"), "utf8").trim()).toBe("RELAY_INTERNAL=unset");
  });

  test("the launch has no permission-bypass flag and no permission mode", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    await call("session.start", { directory: a, text: "hello" });
    const argv = readFileSync(join(tools, "argv.txt"), "utf8").trim().split("\n");
    expect(argv).toEqual(["--bg", "--", "hello"]);
    const cmd = startCommand("/bin/claude", "hi").join(" ");
    expect(cmd).not.toMatch(/skip-permissions|bypass|permission/i);
  });

  test("a directory that isn't listed is refused and nothing starts", async () => {
    const a = dirOf("a");
    const other = dirOf("other");
    past("old", a, 1000);
    for (const directory of [other, "/", `${a}/..`, `${a}/sub`, "relative"]) {
      const res = (await call("session.start", { directory, text: "hi" })) as {
        error: { code: string; message: string };
      };
      expect(res.error.code).toBe("not_found");
      expect(res.error.message).toContain("past chats");
    }
    expect(Bun.file(join(tools, "argv.txt")).size).toBe(0);
  });

  test("a directory that disappeared since is refused and nothing starts", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    rmSync(a, { recursive: true });
    const res = (await call("session.start", { directory: a, text: "hi" })) as {
      error: { code: string; message: string };
    };
    expect(res.error.code).toBe("not_found");
    expect(res.error.message).toContain("no longer exists");
    expect(Bun.file(join(tools, "argv.txt")).size).toBe(0);
  });

  test("an empty first message is refused", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    for (const text of ["", "  \n\t "]) {
      const res = (await call("session.start", { directory: a, text })) as { error: { code: string } };
      expect(res.error.code).toBe("bad_request");
    }
    expect(Bun.file(join(tools, "argv.txt")).size).toBe(0);
    expect(RpcSchemas["session.start"].safeParse({ directory: a }).success).toBe(false);
  });

  test("Claude Code refusing to start gives a plain error and no session", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    writeFileSync(join(tools, "refuse"), "");
    const res = (await call("session.start", { directory: a, text: "hi" })) as {
      error: { code: string; message: string };
    };
    expect(res.error.code).toBe("unavailable");
    expect(res.error.message).toContain("Workspace not trusted");
    expect(registry.list().map((s) => s.id)).toEqual(["old"]);
  });

  test("without Claude Code on the computer it says so", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    const bare = createRpc({
      db,
      events: new EventLog(db),
      registry,
      claudeBin: null,
    } as unknown as RpcDeps);
    const res = (await bare("session.start", { directory: a, text: "hi" }, "device:test")) as {
      error: { code: string };
    };
    expect(res.error.code).toBe("unavailable");
  });

  test("the start is in the audit log, without the message", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    await call("session.start", { directory: a, text: "a secret plan" });
    const rows = db.query("SELECT actor, action, detail FROM audit WHERE action = 'session.start'").all() as {
      actor: string;
      detail: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("device:test");
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      sessionId: "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff",
      directory: a,
      chars: 13,
    });
    expect(rows[0]?.detail).not.toContain("secret");
  });

  const startRows = () =>
    (db.query("SELECT detail FROM audit WHERE action = 'session.start'").all() as { detail: string }[]).map(
      (r) => JSON.parse(r.detail),
    );

  for (const [name, flags, shortId] of [
    ["isn't listed", ["unlisted"], "7c1d2e3f"],
    ["has no short id in the launch output", ["unlisted", "silent"], undefined],
  ] as const) {
    test(`a launch that ran is audited when the session ${name}`, async () => {
      const a = dirOf("a");
      past("old", a, 1000);
      for (const f of flags) writeFileSync(join(tools, f), "");
      const res = (await call("session.start", { directory: a, text: "a secret plan" })) as {
        error: { code: string };
      };
      expect(res.error.code).toBe("unavailable");
      expect(readFileSync(join(tools, "prompt.txt"), "utf8")).toBe("a secret plan");
      expect(startRows()).toEqual([{ ...(shortId ? { sessionId: shortId } : {}), directory: a, chars: 13 }]);
      expect(JSON.stringify(startRows())).not.toContain("secret");
    }, 30_000);
  }

  test("a refused launch, an unlisted directory and an empty message leave no start row", async () => {
    const a = dirOf("a");
    past("old", a, 1000);
    writeFileSync(join(tools, "refuse"), "");
    await call("session.start", { directory: a, text: "hi" });
    await call("session.start", { directory: dirOf("other"), text: "hi" });
    await call("session.start", { directory: a, text: " " });
    expect(startRows()).toEqual([]);
  });
});

describe("capability and fixtures", () => {
  test("HostInfo says canStartSessions only when the helper can", async () => {
    setCanStartSessions(false);
    expect("canStartSessions" in (await hostInfo())).toBe(false);
    setCanStartSessions(true);
    expect(HostInfo.parse(await hostInfo()).canStartSessions).toBe(true);
    setCanStartSessions(false);
  });

  test("the fixtures parse with the schemas", () => {
    const f = JSON.parse(readFileSync(join(import.meta.dir, "../../protocol/fixtures/start.json"), "utf8"));
    expect(HostInfo.parse(f.host).canStartSessions).toBe(true);
    expect("canStartSessions" in HostInfo.parse(f.hostOlder)).toBe(false);
    RpcSchemas["sessions.directories"].parse(f.directoriesParams);
    for (const d of f.directories) SessionDirectory.parse(d);
    RpcSchemas["session.start"].parse(f.params);
    SessionStarted.parse(f.result);
    expect(f.errors).toHaveLength(3);
  });
});

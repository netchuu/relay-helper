import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostInfo, RpcSchemas, type Session, SessionStarted } from "../../protocol/index.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { startCommand } from "../src/daemon/startSession.ts";
import { hostInfo, setCanStartSessions } from "../src/platform/index.ts";

const root = mkdtempSync(join(tmpdir(), "relay-start-empty-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in for `claude`: records its arguments, prints a short id, and lists the session as Claude Code names it. */
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
printf '%s\\n' "$@" > "$here/argv.txt"
cat > "$here/started.json" <<EOF
[{"id":"7c1d2e3f","cwd":"$(pwd)","kind":"background","sessionId":"7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff","name":"7c1d2e3f","state":"idle"}]
EOF
echo "backgrounded · 7c1d2e3f (idle — send a prompt to start)"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

let db: DB;
let rpc: ReturnType<typeof createRpc>;
let tools: string;
let dir: string;
let upserts: Session[];

beforeEach(() => {
  db = openDb(":memory:");
  const events = new EventLog(db);
  upserts = [];
  events.subscribe((e) => {
    if (e.type === "session.upsert") upserts.push(e.session);
  });
  tools = mkdtempSync(join(root, "bin-"));
  dir = mkdtempSync(join(root, "work-"));
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at, ended_at) VALUES ('old', ?, 'proj', 'ended', 1, 2, 2)",
  ).run(dir);
  rpc = createRpc({
    db,
    events,
    registry: new Registry(db, events),
    claudeBin: fakeClaude(tools),
  } as unknown as RpcDeps);
});

const call = (params: unknown) => rpc("session.start", params, "device:test");
const argv = () => readFileSync(join(tools, "argv.txt"), "utf8").trim().split("\n");
const listed = async () =>
  ((await rpc("sessions.list", {}, "device:test")) as { result: Session[] }).result.find(
    (s) => s.id === "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff",
  );

describe("session.start without a first message", () => {
  test("starts an empty session: no prompt on the command line, the default name", async () => {
    const res = (await call({ directory: dir })) as { result: unknown };
    expect(SessionStarted.parse(res.result).sessionId).toBe("7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff");
    expect(argv()).toEqual(["--bg"]);
    const s = await listed();
    expect(s?.kind).toBe("background");
    expect(s?.cwd).toBe(dir);
    expect(s?.name).toBe("7c1d2e3f");
  });

  test("a name from the phone shows as the session's name, Claude Code's kept as originalName", async () => {
    await call({ directory: dir, name: "  Coupon fix  " });
    expect(argv()).toEqual(["--bg"]);
    const s = await listed();
    expect(s?.name).toBe("Coupon fix");
    expect(s?.originalName).toBe("7c1d2e3f");
    expect(upserts.at(-1)?.name).toBe("Coupon fix");
  });

  test("a name works with a first message too", async () => {
    await call({ directory: dir, text: "hi", name: "Coupon fix" });
    expect(argv()).toEqual(["--bg", "--", "hi"]);
    expect((await listed())?.name).toBe("Coupon fix");
  });

  test("a name that shows nothing is no name", async () => {
    await call({ directory: dir, name: " ​ " });
    expect((await listed())?.name).toBe("7c1d2e3f");
  });

  test("a name over one line or too long is refused by the schema", () => {
    const schema = RpcSchemas["session.start"];
    expect(schema.safeParse({ directory: dir, name: "a\nb" }).success).toBe(false);
    expect(schema.safeParse({ directory: dir, name: "x".repeat(61) }).success).toBe(false);
    expect(schema.safeParse({ directory: dir, name: null }).success).toBe(true);
  });

  test("a blank message is still refused, and an unknown folder too", async () => {
    const code = async (params: unknown) => ((await call(params)) as { error: { code: string } }).error.code;
    expect(await code({ directory: dir, text: "  " })).toBe("bad_request");
    expect(await code({ directory: join(dir, "nope") })).toBe("not_found");
    expect(existsSync(join(tools, "argv.txt"))).toBe(false);
  });
});

describe("the command and the capability", () => {
  test("no text is no `--` argument", () => {
    expect(startCommand("/bin/claude")).toEqual(["/bin/claude", "--bg"]);
    expect(startCommand("/bin/claude", "hi")).toEqual(["/bin/claude", "--bg", "--", "hi"]);
  });

  test("HostInfo says canStartEmpty with canStartSessions, and an older host leaves it out", async () => {
    setCanStartSessions(false);
    expect("canStartEmpty" in (await hostInfo())).toBe(false);
    setCanStartSessions(true);
    expect(HostInfo.parse(await hostInfo()).canStartEmpty).toBe(true);
    setCanStartSessions(false);
    const f = JSON.parse(readFileSync(join(import.meta.dir, "../../protocol/fixtures/start.json"), "utf8"));
    expect(HostInfo.parse(f.host).canStartEmpty).toBe(true);
    expect("canStartEmpty" in HostInfo.parse(f.hostOlder)).toBe(false);
    expect(RpcSchemas["session.start"].parse(f.paramsEmpty)).toEqual({
      directory: "/Users/me/Projects/web-shop",
      name: "Coupon fix",
    });
    expect(RpcSchemas["session.start"].parse(f.paramsEmptyUnnamed).name).toBeUndefined();
  });
});

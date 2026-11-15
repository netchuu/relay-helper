import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-starterr-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function startError(line: string): Promise<string> {
  const dir = mkdtempSync(join(root, "c-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "${line}" >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  const work = join(dir, "work");
  mkdirSync(work);
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("old", work, "proj", "idle", 0, 1000, null);
  const rpc = createRpc({ db, events, registry, claudeBin: bin } as unknown as RpcDeps);
  const res = (await rpc("session.start", { directory: work, text: "hi" }, "device:test")) as {
    error: { code: string; message: string };
  };
  expect(res.error.code).toBe("unavailable");
  return res.error.message;
}

const PREFIX = "Claude Code couldn't start: ";

test("the start error is not cut inside an emoji", async () => {
  const m = await startError(`${"a".repeat(199)}😀 tail`);
  expect(m.isWellFormed()).toBe(true);
  expect(m).toBe(`${PREFIX}${"a".repeat(199)}`);
});

test("a plain error line is still cut at 200 units", async () => {
  const m = await startError("b".repeat(300));
  expect(m).toBe(`${PREFIX}${"b".repeat(200)}`);
});

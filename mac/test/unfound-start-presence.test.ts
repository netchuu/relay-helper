import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb, setSetting } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler, notePhoneLaunch } from "../src/daemon/hooks.ts";
import { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

const root = mkdtempSync(join(tmpdir(), "relay-unfound-start-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SID = "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";

/** A claude whose `--bg` exits `code` but whose new session can't be looked up. */
function fakeClaude(dir: string, printsId: boolean, code = 0): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "agents" ]; then echo "[]"; exit 0; fi
echo "backgrounded${printsId ? " · 7c1d2e3f" : ""}"
exit ${code}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function setup(printsId: boolean, code = 0) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const tools = mkdtempSync(join(root, "bin-"));
  const work = join(mkdtempSync(join(root, "work-")), "a");
  mkdirSync(work, { recursive: true });
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("old", work, "proj", "ended", 0, 1000, 1000);
  setSetting(db, "presence.mode", "auto");
  const presence = new PresenceMonitor(db, events, 120);
  (presence as unknown as { state: unknown }).state = {
    mode: "auto",
    present: false,
    idleSeconds: 600,
    locked: false,
  };
  let calls = 0;
  const real = presence.noteLocalActivity.bind(presence);
  presence.noteLocalActivity = () => {
    calls++;
    real();
  };
  const rpc = createRpc({
    db,
    events,
    registry,
    claudeBin: fakeClaude(tools, printsId, code),
  } as unknown as RpcDeps);
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: { settleFromSessionEvent() {}, hasOpen: () => false, listOpen: () => [] },
    presence,
    config: { previewChars: 600 },
  } as unknown as ConstructorParameters<typeof HookHandler>[0]);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const submit = (prompt: string, session = SID) =>
    hooks.handle(
      {
        env: {},
        payload: { hook_event_name: "UserPromptSubmit", session_id: session, cwd: work, prompt },
      } as never,
      new AbortController().signal,
    );
  return { rpc, work, presence, seen, submit, calls: () => calls };
}

const changed = (seen: RelayEvent[]) => seen.filter((e) => e.type === "presence.changed");
type Reply = { error?: { code: string } };

for (const printsId of [false, true]) {
  test(`a launched but unfound phone start is not Mac activity (id printed: ${printsId})`, async () => {
    const s = setup(printsId);
    const text = "Fix the cart";
    const res = (await s.rpc("session.start", { directory: s.work, text }, "device:test")) as Reply;
    expect(res.error?.code).toBe("unavailable");
    await s.submit(text);
    expect(s.calls()).toBe(0);
    expect(s.presence.get().present).toBe(false);
    expect(changed(s.seen)).toEqual([]);
    // The kept launch is used once: the same words typed at the Mac afterwards count.
    await s.submit(text, "other-session");
    expect(s.calls()).toBe(1);
  }, 20_000);
}

test("a launch that exited non-zero drops its entry at once", async () => {
  const s = setup(false, 1);
  const text = "Fix the cart";
  const res = (await s.rpc("session.start", { directory: s.work, text }, "device:test")) as Reply;
  expect(res.error?.code).toBe("unavailable");
  await s.submit(text);
  expect(s.calls()).toBe(1);
}, 20_000);

test("a kept launch expires: a later prompt in that folder is Mac activity", async () => {
  const s = setup(false);
  notePhoneLaunch(s.work, "Fix the cart").keep(20);
  await Bun.sleep(60);
  await s.submit("Fix the cart");
  expect(s.calls()).toBe(1);
});

test("an aborted launch is dropped at once", async () => {
  const s = setup(false);
  notePhoneLaunch(s.work, "Fix the cart").abort();
  await s.submit("Fix the cart");
  expect(s.calls()).toBe(1);
});

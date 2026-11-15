import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb, setSetting } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

const root = mkdtempSync(join(tmpdir(), "relay-start-presence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SID = "7c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff";

/** A claude that takes `delay` seconds to print the new session's id, as a real launch does. */
function fakeClaude(dir: string, delay: number): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
here="$(dirname "$0")"
if [ "$1" = "agents" ]; then
  [ -f "$here/started.json" ] && cat "$here/started.json" || echo "[]"
  exit 0
fi
sleep ${delay}
cat > "$here/started.json" <<EOF2
[{"id":"7c1d2e3f","cwd":"$(pwd)","kind":"background","sessionId":"${SID}","name":"cart-fix","state":"busy"}]
EOF2
echo "backgrounded · 7c1d2e3f"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function setup(delay = 0) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const tools = mkdtempSync(join(root, "bin-"));
  const work = join(mkdtempSync(join(root, "work-")), "a");
  mkdirSync(work, { recursive: true });
  db.query(
    "INSERT INTO sessions (id, cwd, project, status, started_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("old", work, "proj", "ended", 0, 1000, 1000);
  // Presence mode "auto", Mac idle past idleAwaySeconds: the user is away with the phone.
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
  const rpc = createRpc({ db, events, registry, claudeBin: fakeClaude(tools, delay) } as unknown as RpcDeps);
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
  const submit = (prompt: string) =>
    hooks.handle(
      {
        env: {},
        payload: { hook_event_name: "UserPromptSubmit", session_id: SID, cwd: work, prompt },
      } as never,
      new AbortController().signal,
    );
  return { rpc, work, presence, seen, submit, calls: () => calls };
}

const changed = (seen: RelayEvent[]) => seen.filter((e) => e.type === "presence.changed");

test("the first message of a phone-started session is not Mac activity", async () => {
  const s = setup();
  const text = "Fix the cart";
  const res = (await s.rpc("session.start", { directory: s.work, text }, "device:test")) as {
    result: { sessionId: string };
  };
  expect(res.result.sessionId).toBe(SID);
  await s.submit(text);
  expect(s.calls()).toBe(0);
  expect(s.presence.get().present).toBe(false);
  expect(changed(s.seen)).toEqual([]);
});

test("the same holds when the hook arrives before session.start returns", async () => {
  const s = setup(1);
  const text = "Fix the cart";
  const started = s.rpc("session.start", { directory: s.work, text }, "device:test");
  await Bun.sleep(300);
  await s.submit(text);
  await started;
  expect(s.calls()).toBe(0);
  expect(s.presence.get().present).toBe(false);
  expect(changed(s.seen)).toEqual([]);
  // The first message was used up: the next prompt in that session is typed at the Mac.
  await s.submit("Now something else");
  expect(s.calls()).toBe(1);
});

test("a prompt typed at the Mac afterwards still counts as Mac activity", async () => {
  const s = setup();
  await s.rpc("session.start", { directory: s.work, text: "Fix the cart" }, "device:test");
  await s.submit("Fix the cart");
  expect(s.calls()).toBe(0);
  await s.submit("Also the header");
  expect(s.calls()).toBe(1);
  expect(s.presence.get().present).toBe(true);
  expect(changed(s.seen).length).toBe(1);
});

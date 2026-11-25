import { afterEach, expect, test } from "bun:test";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { SuggestionWatcher, suggestionOf } from "../src/daemon/suggestion.ts";
import { resetSuggestionSeen } from "../src/daemon/suggestionSeen.ts";
import { platform } from "../src/platform/index.ts";

const read = platform.presence.read;
afterEach(() => {
  platform.presence.read = read;
  resetSuggestionSeen();
});

// A message from the phone ends the suggestion at once, not only when Claude Code's prompt hook arrives.
test("a sent message clears the session's suggestion in the next update", async () => {
  platform.presence.read = async () => ({ idleSeconds: 60, locked: false, source: "test" });
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  registry.touch("sg1", {
    cwd: "/tmp/sg",
    env: { tmux: "/tmp/tmux-501/default,1,0", tmuxPane: "%3", claudePid: 4242 },
  });
  registry.setStatus("sg1", "idle");
  const suggestions = new SuggestionWatcher({
    registry,
    phoneConnected: () => true,
    sleep: async () => {
      await Bun.sleep(1);
    },
    read: async () => "how much left",
  });
  suggestions.turnEnded("sg1");
  await Bun.sleep(30);
  expect(suggestionOf("sg1")).toBe("how much left");

  const headless = { has: () => true, send: async () => {}, busy: () => false };
  const rpc = createRpc({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    headless,
    suggestions,
  } as unknown as RpcDeps);
  await rpc("session.send", { sessionId: "sg1", text: "how much left" }, "phone");

  expect(suggestionOf("sg1")).toBeUndefined();
  const last = seen.filter((e) => e.type === "session.upsert").at(-1) as { session: { suggestion?: string } };
  expect(last.session.suggestion).toBeUndefined();
});

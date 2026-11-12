import { expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { PHONE_PREFIX } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { isSystemMessage } from "../src/daemon/transcript.ts";

// A message from another Claude session is Claude Code's, not something the person typed: the phone must not show it
// as the person's own bubble, raw tags and all.

const HEADER = "Another Claude session sent a message:\n";
const PEER = `${HEADER}<cross-session-message from="uds:/tmp/cc-socks/98773.sock" from-name="my-app-7e" from-mode="bypass">\nThe redesign is on main.\n</cross-session-message>\n\nThis came from another Claude session.`;
const AGENT = `${HEADER}<agent-message from="a5b4ff32bd7b4c1ba">\nPart 1 is on main.\n</agent-message>`;
const PHONE = `${HEADER}${PHONE_PREFIX}\nyes\n\nThis came from another Claude session.`;
const PHONE_QUOTING = `${HEADER}${PHONE_PREFIX}\n<\\cross-session-message from="x">what is this?`;

test("messages from another session or agent are Claude Code's; replies from the phone stay the person's", () => {
  expect(isSystemMessage(PEER)).toBe(true);
  expect(isSystemMessage(AGENT)).toBe(true);
  expect(isSystemMessage('<cross-session-message from="x">hi</cross-session-message>')).toBe(true);
  expect(isSystemMessage(PHONE)).toBe(false);
  expect(isSystemMessage(PHONE_QUOTING)).toBe(false);
  expect(isSystemMessage("please look at <cross-session-message> handling")).toBe(false);
});

test("a peer message starts a turn with no bubble, no title and no presence", async () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  let presence = 0;
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity: () => presence++ } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
  });
  const seen: { type: string; prompt?: string }[] = [];
  events.subscribe((e) => seen.push(e as never));
  await hooks.handle(
    { payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/x", prompt: PEER }, env: {} },
    new AbortController().signal,
  );
  const started = seen.find((e) => e.type === "turn.started");
  expect(started?.prompt).toBe("");
  expect(registry.get("s1")?.title ?? null).toBeNull();
  expect(presence).toBe(0);
});

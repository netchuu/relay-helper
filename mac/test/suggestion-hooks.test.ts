import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { promptHoldsText } from "../src/daemon/promptLine.ts";
import { Registry } from "../src/daemon/registry.ts";
import { SuggestionWatcher } from "../src/daemon/suggestion.ts";
import {
  noteSuggestionKnown,
  resetSuggestionSeen,
  suggestionKnownOf,
  untypedStopAt,
} from "../src/daemon/suggestionSeen.ts";

const RULE = "─".repeat(80);
const screen = (...lines: string[]) => [RULE, ...lines, RULE].join("\n");

afterEach(() => resetSuggestionSeen());

// By default the screen can't be read once the Stop arrives, so only a tool hook's read can mark the turn.
function setup(
  tab: { screen: string },
  stopRead: { readable: boolean; delayMs?: number } = { readable: false },
) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  let stopped = false;
  const suggestions = new SuggestionWatcher({
    registry,
    holdsText: async (_s, _o, known) => {
      if (!stopped) return promptHoldsText(tab.screen, known);
      if (stopRead.delayMs) await Bun.sleep(stopRead.delayMs);
      return stopRead.readable ? promptHoldsText(tab.screen, known) : undefined;
    },
    read: async () => undefined,
    sleep: async () => {},
    phoneConnected: () => false,
  });
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    suggestions,
  });
  const hook = (event: string, fields: Record<string, unknown> = {}) => {
    if (event === "Stop") stopped = true;
    return hooks.handle(
      {
        payload: { hook_event_name: event, session_id: "h1", cwd: "/Users/me/app", ...fields },
        env: { socket: "/tmp/h1.sock" },
      },
      new AbortController().signal,
    );
  };
  return { hook, suggestions };
}

const tool = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "u1" };

test("text in the prompt at a PreToolUse means the Stop that follows keeps no suggestion", async () => {
  const t = setup({ screen: screen("❯ also check the signup") });
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("PreToolUse", tool);
  await Bun.sleep(20);
  await t.hook("Stop", { last_assistant_message: "ok" });
  expect(untypedStopAt("h1")).toBeUndefined();
  t.suggestions.clear("h1");
});

test("text in the prompt at a PostToolUse means the Stop that follows keeps no suggestion", async () => {
  const t = setup({ screen: screen("❯ also check the signup") });
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("PostToolUse", { ...tool, tool_response: {} });
  await Bun.sleep(20);
  await t.hook("Stop", { last_assistant_message: "ok" });
  expect(untypedStopAt("h1")).toBeUndefined();
  t.suggestions.clear("h1");
});

test("an empty prompt at the tool hook leaves the Stop known", async () => {
  const t = setup({ screen: screen("❯") });
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("PreToolUse", tool);
  await Bun.sleep(20);
  await t.hook("Stop", { last_assistant_message: "ok" });
  expect(untypedStopAt("h1")).toBeDefined();
  t.suggestions.clear("h1");
});

test("text typed after the last tool hook is seen when the Stop arrives", async () => {
  const tab = { screen: screen("❯") };
  const t = setup(tab, { readable: true });
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("PreToolUse", tool);
  await Bun.sleep(20);
  tab.screen = screen("❯ also check the signup");
  await t.hook("Stop", { last_assistant_message: "ok" });
  expect(untypedStopAt("h1")).toBeUndefined();
  t.suggestions.clear("h1");
});

test("a read that finishes after the Stop's deadline does not count: it may be the suggestion", async () => {
  const t = setup({ screen: screen("❯ fix the login test") }, { readable: true, delayMs: 700 });
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("Stop", { last_assistant_message: "ok" });
  expect(untypedStopAt("h1")).toBeDefined();
  t.suggestions.clear("h1");
});

test("a system prompt keeps the known suggestion, a real submit drops it", async () => {
  const t = setup({ screen: screen("❯") });
  noteSuggestionKnown("h1", "run the tests");
  await t.hook("UserPromptSubmit", { prompt: "<task-notification>done</task-notification>" });
  expect(suggestionKnownOf("h1")).toBe("run the tests");
  await t.hook("UserPromptSubmit", { prompt: "go" });
  expect(suggestionKnownOf("h1")).toBeUndefined();
  t.suggestions.clear("h1");
});

test("the known suggestion in the prompt during a turn is not typing", async () => {
  const t = setup({ screen: screen("❯ run the tests") });
  noteSuggestionKnown("h1", "run the tests");
  await t.hook("UserPromptSubmit", { prompt: "<task-notification>done</task-notification>" });
  await t.hook("PreToolUse", tool);
  await Bun.sleep(20);
  await t.hook("Stop", { last_assistant_message: "ok" });
  expect(untypedStopAt("h1")).toBeDefined();
  t.suggestions.clear("h1");
});

test("promptHoldsText: an empty box, the placeholder, text, wrapped text and no prompt", () => {
  expect(promptHoldsText(screen("❯"))).toBe(false);
  expect(promptHoldsText(screen("❯ "))).toBe(false);
  expect(promptHoldsText(screen('❯ Try "fix typecheck errors"'))).toBe(false);
  expect(promptHoldsText(screen("❯ fix the login test"))).toBe(true);
  expect(promptHoldsText(screen("❯ fix the login test", "  and the signup one"))).toBe(true);
  expect(promptHoldsText("$ ls\nREADME.md")).toBeUndefined();
  expect(promptHoldsText("")).toBeUndefined();
});

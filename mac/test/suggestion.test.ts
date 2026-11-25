// Claude Code's suggested next message, read off the terminal screen and sent to the phones as `suggestion` (redacted, one line).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type RelayEvent, Session } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import { readSuggestion, type TypeOps } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { promptSuggestion, promptSuggestionRead } from "../src/daemon/promptLine.ts";
import { Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { cleanSuggestion, SuggestionWatcher, suggestionOf } from "../src/daemon/suggestion.ts";
import { forgetSuggestionKnown } from "../src/daemon/suggestionSeen.ts";

const RULE = "─".repeat(100);
const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
const screen = (...prompt: string[]) =>
  ["⏺ Done. The tests pass.", "", RULE, ...prompt, RULE, "  ⏵⏵ bypass permissions on"].join("\n");

afterEach(() => {
  for (const id of ["s1", "s2"]) new SuggestionWatcher({ registry: nobody }).clear(id);
});
const nobody = { get: () => null, list: () => [], publish() {} };

test("promptSuggestion takes a dimmed prompt as the suggestion, never typing or the Try hint", () => {
  expect(promptSuggestion(screen(`❯ ${dim("run the tests and fix what fails")}`))).toBe(
    "run the tests and fix what fails",
  );
  // The cursor is drawn over the first letter of a suggestion.
  expect(promptSuggestion(screen(`❯ \u001b[7mr\u001b[0m${dim("un the tests")}`))).toBe("run the tests");
  expect(promptSuggestion(screen("❯ also check the signup"))).toBeNull();
  expect(promptSuggestion(screen("❯ "))).toBeNull();
  expect(promptSuggestion(screen('❯ Try "fix typecheck errors"'))).toBeNull();
  expect(promptSuggestion("just a shell prompt $ ")).toBeNull();
});

test("a terminal with no attributes shows a suggestion only when no key was pressed since the prompt", () => {
  const plain = screen("❯ run the tests");
  expect(promptSuggestion(plain)).toBeNull();
  expect(promptSuggestion(plain, { noKeySincePrompt: false })).toBeNull();
  expect(promptSuggestion(plain, { noKeySincePrompt: true })).toBe("run the tests");
});

test("a suggestion is one line", () => {
  expect(promptSuggestion(screen(`❯ ${dim("run the tests")}`, `  ${dim("and fix what fails")}`))).toBe(
    "run the tests and fix what fails",
  );
});

test("cleanSuggestion redacts secrets, squashes whitespace and cuts long text", () => {
  const secret = ["sk", "ant", "api03", "A".repeat(40)].join("-");
  const out = cleanSuggestion(`use  ${secret}\n now`);
  expect(out).not.toContain(secret);
  expect(out).not.toContain("\n");
  expect(cleanSuggestion("   ")).toBeNull();
  expect(cleanSuggestion("x".repeat(500))?.length).toBe(300);
});

function ops(over: Partial<TypeOps>): TypeOps {
  return {
    pty: async () => ({ ok: false, reason: "none" }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    tmuxPaneTty: async () => null,
    routes: () => [],
    ttyOf: async () => null,
    peek: async () => null,
    type: async () => false,
    inFront: async () => true,
    ...over,
  } as unknown as TypeOps;
}

const record = (over: Partial<SessionRecord>) =>
  ({ id: "s1", pid: 4242, cwd: "/x", terminal: null, ...over }) as SessionRecord;

test("readSuggestion reads tmux with its attributes, and iTerm2 by the no-key rule", async () => {
  const tmux = record({ tmuxPane: "%1", tmuxSocket: "/tmp/tmux-1/default" });
  expect(await readSuggestion(tmux, ops({ tmuxScreen: async () => screen(`❯ ${dim("ship it")}`) }))).toBe(
    "ship it",
  );
  expect(await readSuggestion(tmux, ops({ tmuxScreen: async () => screen("❯ ship it") }))).toBeNull();

  const tab = record({ terminal: "iTerm.app" });
  const iterm = (noKey: boolean) =>
    ops({
      routes: () => ["iterm"],
      ttyOf: async () => "/dev/ttys004",
      peek: async () => ({ front: false, screen: screen("❯ ship it") }),
      noKeySincePrompt: () => noKey,
    });
  expect(await readSuggestion(tab, iterm(true))).toBe("ship it");
  forgetSuggestionKnown(tab.id);
  expect(await readSuggestion(tab, iterm(false))).toBeNull();
});

test("readSuggestion says unreadable where the screen can't be read", async () => {
  expect(await readSuggestion(record({ ptySocket: "/tmp/p.sock" }), ops({}))).toBeUndefined();
  expect(
    await readSuggestion(
      record({ terminal: "iTerm.app" }),
      ops({ routes: () => ["iterm"], ttyOf: async () => "/dev/ttys004" }),
    ),
  ).toBeUndefined();
  const boom = ops({
    tmuxScreen: async () => {
      throw new Error("no tmux");
    },
  });
  expect(await readSuggestion(record({ tmuxPane: "%1", tmuxSocket: "/s" }), boom)).toBeUndefined();
});

/** `null` in `screens` is a read that fails (the screen can't be read); the last entry repeats. */
function setup(screens: (string | null)[]) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  let n = 0;
  const reads: string[] = [];
  const waits: number[] = [];
  let time = 0;
  const suggestions = new SuggestionWatcher({
    registry,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
      await Bun.sleep(1);
    },
    now: () => time,
    read: async (s) => {
      reads.push(s.id);
      const text = screens[Math.min(n++, screens.length - 1)] ?? null;
      return text === null ? undefined : promptSuggestionRead(text);
    },
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
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (
    event: string,
    id = "s1",
    env: Record<string, unknown> = { tmux: "/tmp/t,1,0", tmuxPane: "%1" },
  ) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: id, cwd: "/x" }, env },
      new AbortController().signal,
    );
  const last = (id = "s1") =>
    seen
      .filter((e): e is Extract<RelayEvent, { type: "session.upsert" }> => e.type === "session.upsert")
      .filter((e) => e.session.id === id)
      .at(-1)?.session;
  return { registry, hook, last, reads, waits };
}

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 300 && !fn(); i++) await Bun.sleep(5);
  expect(fn()).toBe(true);
};
const SUGGESTED = screen(`❯ ${dim("run the tests")}`);

test("a Stop shows the suggestion on the idle session; a new turn clears it at once", async () => {
  const t = setup([SUGGESTED]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.last()?.suggestion === "run the tests");
  expect(Session.safeParse(t.last()).success).toBe(true);
  expect(t.last()?.status).toBe("idle");
  await t.hook("UserPromptSubmit");
  expect(t.last()?.suggestion).toBeUndefined();
  expect(suggestionOf("s1")).toBeUndefined();
});

test("the suggestion goes away when the screen no longer shows it", async () => {
  const t = setup([SUGGESTED, SUGGESTED, SUGGESTED, SUGGESTED, SUGGESTED, SUGGESTED, screen("❯ ")]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.last()?.suggestion === "run the tests");
  await waitFor(() => t.last()?.suggestion === undefined);
  expect(t.last()?.status).toBe("idle");
});

test("no suggestion on the screen means none on the session", async () => {
  const t = setup([screen("❯ ")]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.reads.length >= 5);
  expect(t.last()?.suggestion).toBeUndefined();
});

test("a session that can't receive messages never shows one", async () => {
  const t = setup([SUGGESTED]);
  await t.hook("UserPromptSubmit", "s2", {});
  await t.hook("Stop", "s2", {});
  await Bun.sleep(30);
  expect(t.reads).toEqual([]);
  expect(t.last("s2")?.suggestion).toBeUndefined();
});

test("the ended session shows none", async () => {
  const t = setup([SUGGESTED]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.last()?.suggestion === "run the tests");
  await t.hook("SessionEnd");
  expect(t.last()?.suggestion).toBeUndefined();
});

test("the fixture decodes: a suggestion on an idle session, and none", () => {
  const fx = JSON.parse(
    readFileSync(join(import.meta.dir, "../../protocol/fixtures/suggestion.json"), "utf8"),
  );
  expect(Session.parse(fx.shown).suggestion).toBe("run the tests and fix what fails");
  expect(Session.parse(fx.none).suggestion).toBeUndefined();
});

test("a read that fails keeps the suggestion and the watch going", async () => {
  // Reads 0-5 show it; read 6 can't read the screen; later reads show it again.
  const t = setup([SUGGESTED, SUGGESTED, SUGGESTED, SUGGESTED, SUGGESTED, SUGGESTED, null, SUGGESTED]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.reads.length >= 12);
  expect(t.last()?.suggestion).toBe("run the tests");
  expect(suggestionOf("s1")).toBe("run the tests");
});

test("one empty look in the middle of a redraw doesn't clear the suggestion, two in a row do", async () => {
  const t = setup([
    SUGGESTED,
    SUGGESTED,
    SUGGESTED,
    SUGGESTED,
    SUGGESTED,
    SUGGESTED,
    screen("❯ "),
    SUGGESTED,
  ]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.reads.length >= 12);
  expect(suggestionOf("s1")).toBe("run the tests");
  expect(t.last()?.suggestion).toBe("run the tests");
});

test("after ten minutes the watch slows down but keeps the suggestion while the Mac shows it", async () => {
  const t = setup([SUGGESTED]);
  await t.hook("UserPromptSubmit");
  await t.hook("Stop");
  await waitFor(() => t.waits.length >= 400);
  expect(t.waits.slice(0, 5)).toEqual([600, 900, 1500, 2500, 4000]);
  expect(t.waits).toContain(3_000);
  expect(t.waits.at(-1)).toBe(30_000);
  expect(t.last()?.suggestion).toBe("run the tests");
  expect(suggestionOf("s1")).toBe("run the tests");
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { phoneTypePending } from "../src/daemon/hooks.ts";
import {
  clearDraftKept,
  type DeliverOptions,
  DeliveryError,
  DraftInPrompt,
  deliver,
  type TypeOps,
} from "../src/daemon/inject.ts";
import { afterBreak, noKeySincePrompt, notePromptSubmitted, promptDraft } from "../src/daemon/promptLine.ts";
import { type HookEnv, Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { deliverQueued, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { parsePeek } from "../src/platform/darwin.ts";
import { platform } from "../src/platform/index.ts";
import type { TabView, TypingRoute } from "../src/platform/types.ts";
import { answerRequest, DraftTracker, type RequestContext } from "../src/shell/ptyShell.ts";
import { waitFor } from "./support/wait.ts";

// A phone message is always typed into its terminal, never sent through the inbox. When typing now could
// mix into what the person at the Mac is typing, it waits for a pause.

const RULE = "─".repeat(100);
/** What Claude Code 2.1.319 shows in tmux (`capture-pane -p`), with `prompt` in its input. */
const claudeScreen = (...prompt: string[]) =>
  [
    " ▐▛███▜▌   Claude Code v2.1.319",
    "",
    "⏺ Done. The tests pass.",
    "",
    "                                                                                  ● high · /effort",
    RULE,
    ...prompt,
    RULE,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
const EMPTY = claudeScreen("❯ ");
const PLACEHOLDER = claudeScreen('❯ Try "fix typecheck errors"');
const DRAFT = claudeScreen("❯ also check the signup");

describe("the prompt line (promptDraft)", () => {
  test("an empty prompt, or its dimmed suggestion, holds no draft", () => {
    expect(promptDraft(EMPTY)).toBeNull();
    expect(promptDraft(PLACEHOLDER)).toBeNull();
    expect(promptDraft(claudeScreen("❯"))).toBeNull();
  });

  test("WezTerm's escape form (charset designations, colon colours) reads like plain text", () => {
    const e = "\u001b";
    const reset = `${e}(B${e}[0m`;
    const wezRule = `${e}(B${e}[0;2;38:2::90:90:90m${RULE}${reset}`;
    const screen = (...prompt: string[]) =>
      [" Claude Code", "", wezRule, ...prompt, wezRule, "  ⏵⏵ bypass permissions on"].join("\n");
    // empty prompt with the inverse cursor
    expect(promptDraft(screen(`❯ ${e}(B${e}[0;7m ${reset}`))).toBeNull();
    // the dim suggestion, first letter under the cursor
    const dim = `${e}(B${e}[0;2m`;
    expect(promptDraft(screen(`❯ ${e}(B${e}[0;7mc${dim}ontinue, but use edit tool${reset}`))).toBeNull();
    expect(promptDraft(screen(`❯ ${dim}continue, but use edit tool${reset}`))).toBeNull();
    // a draft, in a colour with blue 2 (must not read as dim)
    expect(promptDraft(screen(`❯ ${e}(B${e}[0;38:2::10:20:2malso check the signup${reset}`))).toBe(
      "also check the signup",
    );
    expect(promptDraft(screen(`❯ ${e}(B${e}[0;38;2;10;20;2malso check${reset}`))).toBe("also check");
  });

  test("with escape codes, an all-dim prompt is a suggestion and normal text is a draft", () => {
    const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
    expect(promptDraft(claudeScreen(`❯ ${dim("continue, but use edit tool")}`))).toBeNull();
    // the cursor is drawn reversed over the suggestion's first letter
    expect(promptDraft(claudeScreen(`❯ \u001b[7mc\u001b[0m${dim("ontinue")}`))).toBeNull();
    expect(promptDraft(claudeScreen(`❯ also check the signup${dim(" now")}`))).toBe(
      "also check the signup now",
    );
    expect(promptDraft(claudeScreen("❯ \u001b[39mplain typing\u001b[0m"))).toBe("plain typing");
  });

  test("no key pressed since the prompt was submitted: its text is a suggestion", () => {
    expect(promptDraft(DRAFT, { noKeySincePrompt: true })).toBeNull();
    expect(promptDraft(DRAFT, { noKeySincePrompt: false })).toBe("also check the signup");
    notePromptSubmitted("k1", 10_000);
    // the last key (the Enter that submitted it) was 12 s ago, the prompt 10 s ago: none since
    expect(noKeySincePrompt("k1", 12, 20_000)).toBe(true);
    // a key 3 s ago is after the submit
    expect(noKeySincePrompt("k1", 3, 20_000)).toBe(false);
    expect(noKeySincePrompt("k1", null, 20_000)).toBe(false);
    expect(noKeySincePrompt("never-submitted", 999, 20_000)).toBe(false);
  });

  test("text in the prompt is a draft, over several lines too", () => {
    expect(promptDraft(DRAFT)).toBe("also check the signup");
    expect(promptDraft(claudeScreen("❯ hello draftline two", "  line three"))).toBe(
      "hello draftline two\nline three",
    );
    // Shell mode.
    expect(promptDraft(claudeScreen("! git status"))).toBe("git status");
  });

  test("the older box, with `>`", () => {
    const box = (inner: string) =>
      [
        "╭──────────────────────────╮",
        `│ > ${inner.padEnd(23)}│`,
        "╰──────────────────────────╯",
        "  ? for shortcuts",
      ].join("\n");
    expect(promptDraft(box(""))).toBeNull();
    expect(promptDraft(box("half a thought"))).toBe("half a thought");
  });

  test("nothing to read: no prompt line, a dialog, a bare shell", () => {
    expect(promptDraft("")).toBeNull();
    expect(promptDraft("me@mac ~ % ls\nREADME.md\nme@mac ~ % ")).toBeNull();
    // The folder-trust dialog has one rule and a `❯` menu: not a prompt.
    expect(
      promptDraft(
        [RULE, " Accessing workspace:", "", " ❯ No, exit", "   Yes, I trust this folder"].join("\n"),
      ),
    ).toBeNull();
    // Two rules with something else between them.
    expect(promptDraft([RULE, "  1. Yes", "  2. No", RULE].join("\n"))).toBeNull();
  });

  test("only the last prompt line counts, not a rule further up", () => {
    expect(promptDraft([RULE, "❯ old", RULE, "output", EMPTY].join("\n"))).toBeNull();
  });

  test("a clean break before the phone's text", () => {
    expect(afterBreak("from the phone")).toBe("\n\nfrom the phone");
  });
});

describe("the iTerm2 peek's answer (parsePeek)", () => {
  test("front or back, then the tab's text", () => {
    expect(parsePeek(`front\n${DRAFT}`)).toEqual({ front: true, screen: DRAFT });
    expect(parsePeek("back\n❯ ")).toEqual({ front: false, screen: "❯ " });
    expect(parsePeek("back")).toEqual({ front: false, screen: null });
    expect(parsePeek("not-found")).toBeNull();
    expect(parsePeek("no-app")).toBeNull();
    expect(parsePeek("")).toBeNull();
  });
});

/** A fake set of terminals: records what was typed where, and what it was asked. */
function fakeTerminals(init: {
  tab?: TabView | null;
  tmuxScreen?: string | null;
  pty?: () => { ok: true } | { ok: false; reason: "not_foreground" };
  /** Whether the tab or pane takes the stash key. */
  stash?: boolean;
}) {
  const state = { tab: init.tab ?? null, tmuxScreen: init.tmuxScreen ?? null };
  const typed: string[] = [];
  const ops: TypeOps = {
    pty: async (_s, _t, _p, text) => {
      const reply = init.pty ? init.pty() : { ok: true as const };
      if (reply.ok) typed.push(`pty:${text}`);
      return reply;
    },
    tmuxScreen: async () => state.tmuxScreen,
    tmux: async (_s, _p, text) => void typed.push(`tmux:${text}`),
    tmuxStash: async () => {
      typed.push("tmux:<stash>");
      if (init.stash !== false) state.tmuxScreen = EMPTY;
    },
    routes: (t) => (t === "iTerm.app" || !t ? ["iterm"] : []),
    ttyOf: async (pid) => (pid ? "/dev/ttys004" : null),
    peek: async (_r: TypingRoute) => state.tab,
    inFront: async () => true,
    type: async (route, _tty, text) => {
      typed.push(`${route}:${text}`);
      return true;
    },
    stash: async (route) => {
      if (init.stash === false) return false;
      typed.push(`${route}:<stash>`);
      if (state.tab) state.tab = { ...state.tab, screen: EMPTY };
      return true;
    },
    sleep: async () => {},
  };
  return { ops, typed, state };
}

/** A temporary inbox socket that records what Claude Code would receive. */
async function inbox(): Promise<{ path: string; got: string[]; server: Server }> {
  const path = join(mkdtempSync(join(tmpdir(), "relay-typed-")), "in.sock");
  const got: string[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
    });
    c.on("end", () => {
      for (const line of buf.trim().split("\n")) {
        const msg = JSON.parse(line);
        if (msg.type === "user") got.push(msg.message.content);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, got, server };
}

function setup(env: HookEnv) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const notices: string[] = [];
  events.subscribe((e: RelayEvent) => {
    if (e.type === "session.notice") notices.push(e.text);
  });
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env });
  const queue = new ReplyQueue(db, events, registry);
  clearDraftKept("s1");
  const session = () => registry.get("s1") as SessionRecord;
  return { db, events, registry, queue, notices, session };
}

const ITERM: HookEnv = { termProgram: "iTerm.app", claudePid: 4242 };
const opts = (more: Partial<DeliverOptions> = {}): DeliverOptions => ({
  userTypingNow: false,
  preferTyping: true,
  ...more,
});

describe("deliver: the phone's message goes in at once", () => {
  test("tab in front: typed at once, never the inbox", async () => {
    const box = await inbox();
    const s = setup({ ...ITERM, socket: box.path });
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    expect(await deliver(s.session(), "check the build", opts(), t.ops)).toEqual({ via: "iterm" });
    expect(t.typed).toEqual(["iterm:check the build"]);
    await Bun.sleep(30);
    expect(box.got).toEqual([]);
    box.server.close();
  });

  test("a draft in the prompt: stashed, the message typed, nothing waits", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: DRAFT } });
    expect(await deliver(s.session(), "deploy it", opts(), t.ops)).toEqual({ via: "iterm" });
    expect(t.typed).toEqual(["iterm:<stash>", "iterm:deploy it"]);
  });

  test("a stash that didn't empty the prompt: typed after a clean break, not run into the draft", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: DRAFT } });
    t.ops.stash = async (route) => {
      t.typed.push(`${route}:<stash>`);
      return true;
    };
    await deliver(s.session(), "deploy it", opts(), t.ops);
    expect(t.typed).toEqual(["iterm:<stash>", `iterm:${afterBreak("deploy it")}`]);
  });

  test("a tab that can't stash types the message after a clean break from the draft", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT }, stash: false });
    expect(await deliver(s.session(), "deploy it", opts(), t.ops)).toEqual({ via: "iterm" });
    expect(t.typed).toEqual([`iterm:${afterBreak("deploy it")}`]);
  });

  test("iTerm2: text with no key pressed since the prompt was submitted is a suggestion: typed, nothing stashed", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT } });
    let noKey = true;
    t.ops.noKeySincePrompt = () => noKey;
    expect(await deliver(s.session(), "deploy it", opts(), t.ops)).toEqual({ via: "iterm" });
    expect(t.typed).toEqual(["iterm:deploy it"]);
    // A key was pressed since: that text is typing, and is stashed.
    noKey = false;
    t.state.tab = { front: false, screen: DRAFT };
    await deliver(s.session(), "deploy it", opts(), t.ops);
    expect(t.typed.slice(1)).toEqual(["iterm:<stash>", "iterm:deploy it"]);
  });

  test("a draft put back after a message is still a draft for the next one, with no key pressed since", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: DRAFT } });
    let noKey = false;
    t.ops.noKeySincePrompt = () => noKey;
    await deliver(s.session(), "one", opts(), t.ops);
    noKey = true;
    t.state.tab = { front: false, screen: DRAFT };
    await deliver(s.session(), "two", opts(), t.ops);
    expect(t.typed).toEqual(["iterm:<stash>", "iterm:one", "iterm:<stash>", "iterm:two"]);
  });

  test("an unknown screen is typed at once", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: null } });
    expect(await deliver(s.session(), "x", opts(), t.ops)).toEqual({ via: "iterm" });
  });

  test("tmux: a draft is stashed, a dimmed suggestion is not, and typed text beside the cursor is", async () => {
    const s = setup({
      tmux: "/tmp/tmux-501/default,1,0",
      tmuxPane: "%3",
      claudePid: 4242,
      termProgram: "tmux",
    });
    const t = fakeTerminals({ tmuxScreen: EMPTY });
    expect(await deliver(s.session(), "x", opts(), t.ops)).toEqual({ via: "tmux" });
    expect(t.typed.splice(0)).toEqual(["tmux:x"]);
    t.state.tmuxScreen = DRAFT;
    await deliver(s.session(), "x", opts(), t.ops);
    expect(t.typed.splice(0)).toEqual(["tmux:<stash>", "tmux:x"]);
    t.state.tmuxScreen = claudeScreen(`❯ \u001b[7mc\u001b[27m\u001b[2montinue, but use edit tool\u001b[22m`);
    await deliver(s.session(), "x", opts(), t.ops);
    expect(t.typed.splice(0)).toEqual(["tmux:x"]);
    t.state.tmuxScreen = claudeScreen("❯ continue, but use edit tool\u001b[7m \u001b[27m");
    await deliver(s.session(), "x", opts(), t.ops);
    expect(t.typed.splice(0)).toEqual(["tmux:<stash>", "tmux:x"]);
    // The pane is gone: the next route gets its turn.
    t.state.tmuxScreen = null;
    await expect(deliver(s.session(), "x", opts(), t.ops)).rejects.toBeInstanceOf(DeliveryError);
  });

  test("a command for the session itself is refused while the prompt holds a draft", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: true, screen: DRAFT } });
    await expect(
      deliver(s.session(), "/model opus", opts({ terminalOnly: true }), t.ops),
    ).rejects.toBeInstanceOf(DraftInPrompt);
    expect(t.typed).toEqual([]);
  });

  test("relay shell (Zed): typed at once; the shell stashes a draft itself", async () => {
    const s = setup({ pty: "/tmp/pty.sock", ptyToken: "tok", claudePid: 4242, termProgram: "zed" });
    const t = fakeTerminals({});
    expect(await deliver(s.session(), "x", opts(), t.ops)).toEqual({ via: "pty" });
    expect(t.typed).toEqual(["pty:x"]);
  });

  test("relay shell with the agent not in front: the other routes (here the inbox)", async () => {
    const box = await inbox();
    const s = setup({
      pty: "/tmp/pty.sock",
      ptyToken: "tok",
      claudePid: 4242,
      termProgram: "zed",
      socket: box.path,
    });
    const t = fakeTerminals({ pty: () => ({ ok: false, reason: "not_foreground" }) });
    expect(await deliver(s.session(), "x", opts(), t.ops)).toEqual({ via: "socket" });
    box.server.close();
  });

  test("a session with no typing route (Warp) still uses the inbox", async () => {
    const box = await inbox();
    const s = setup({ termProgram: "WarpTerminal", claudePid: 4242, socket: box.path });
    const t = fakeTerminals({ tab: { front: true, screen: EMPTY } });
    expect(await deliver(s.session(), "from the phone", opts(), t.ops)).toEqual({ via: "socket" });
    await waitFor(() => box.got.length >= 1, 30_000, "the inbox line");
    expect(box.got).toHaveLength(1);
    expect(box.got[0]).toContain("from the phone");
    box.server.close();
  });

  test("an iTerm2 session whose tab Relay can't find (closed, iTerm2 not running) uses the inbox", async () => {
    const box = await inbox();
    const s = setup({ ...ITERM, socket: box.path });
    const t = fakeTerminals({ tab: null });
    expect(await deliver(s.session(), "x", opts(), t.ops)).toEqual({ via: "socket" });
    box.server.close();
  });
});

describe("the reply queue an older helper left behind", () => {
  test("a question open in the session: the reply isn't typed into it, and goes once it is answered", async () => {
    const s = setup(ITERM);
    const t = fakeTerminals({ tab: { front: false, screen: EMPTY } });
    s.queue.add("s1", "later", 1, "pause");
    let open = true;
    const deliverIt = deliverQueued({ preferTyping: true, hasOpenPrompt: () => open, typeOps: t.ops });
    await s.queue.drain(deliverIt, 10);
    expect(t.typed).toEqual([]);
    open = false;
    await s.queue.drain(deliverIt, 10);
    expect(t.typed).toEqual(["iterm:later"]);
  });

  test("one session's reply that can't be delivered doesn't hold another back", async () => {
    const s = setup(ITERM);
    s.registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    s.queue.add("s1", "a", 1, "pause");
    s.queue.add("s1", "b", 2, "pause");
    s.queue.add("s2", "c", 3, "pause");
    const sent: string[] = [];
    await s.queue.drain(async (session, text) => {
      if (session.id === "s1") throw new DeliveryError("no route");
      sent.push(text);
    }, 10);
    expect(sent).toEqual(["c"]);
    expect(s.queue.list()).toEqual([]);
    expect(s.notices).toEqual([
      "Your message to web-shop wasn't sent: no route.",
      "Your message to web-shop wasn't sent: no route.",
    ]);
  });

  test("a reply that waited for the unlock is typed now", async () => {
    const s = setup(ITERM);
    s.queue.add("s1", "later", 1, "unlock");
    const sent: string[] = [];
    await s.queue.drain(async (_session, text) => void sent.push(text), 10);
    expect(sent).toEqual(["later"]);
    expect(s.queue.list()).toEqual([]);
  });

  test("the session ended while its reply waited: dropped with its own notice", async () => {
    const s = setup(ITERM);
    s.queue.add("s1", "late", 1, "pause");
    s.registry.setStatus("s1", "ended");
    await s.queue.drain(async () => {}, 10);
    expect(s.queue.list()).toEqual([]);
    expect(s.notices).toEqual([
      "Your message to web-shop wasn't sent: the session ended before it could be typed in.",
    ]);
  });

  test("a reply queued before this version is still read from the database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "relay-typed-")), "relay.db");
    const old = openDb(path);
    old.exec(
      "DROP TABLE queued_replies; CREATE TABLE queued_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL); PRAGMA user_version = 12;",
    );
    old.query("INSERT INTO queued_replies (session_id, text, created_at) VALUES ('s1', 'kept', 5)").run();
    old.close();
    const db = openDb(path);
    const events = new EventLog(db);
    const queue = new ReplyQueue(db, events, new Registry(db, events));
    expect(queue.list().map((r) => [r.text, r.createdAt, r.waitsFor])).toEqual([["kept", 5, "unlock"]]);
  });
});

describe("relay shell: the phone's message goes in at once", () => {
  function ctx(over: Partial<RequestContext> = {}) {
    const written: string[] = [];
    let t = 100_000;
    const c: RequestContext = {
      token: "tok",
      shellPid: 1,
      isForeground: async () => true,
      hasDraft: () => false,
      pasteOn: () => true,
      write: (d) => void written.push(d),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      ...over,
    };
    return { c, written, advance: (ms: number) => (t += ms), now: () => t };
  }
  const req = (more: object = {}) => JSON.stringify({ token: "tok", pid: 7, text: "hi", ...more });

  test("a draft in the prompt: stashed, the message typed and sent, the draft counted again", async () => {
    const d = new DraftTracker();
    d.feed("fix the failing test in");
    const x = ctx({
      hasDraft: () => d.pending,
      sentEnter: () => d.feed("\r"),
      stashed: () => d.stash(),
      write: (b) => {
        d.feed(b);
        x.written.push(b);
      },
    });
    expect(await answerRequest(req(), x.c)).toEqual({ ok: true });
    expect(x.written).toEqual(["\x13", "\x1b[200~hi\x1b[201~", "\r"]);
    expect(d.pending).toBe(true);
  });

  test("a draft stashed, then a message sent behind it is stashed again", async () => {
    const d = new DraftTracker();
    d.feed("fix the failing test in");
    const x = ctx({ hasDraft: () => d.pending, sentEnter: () => d.feed("\r"), stashed: () => d.stash() });
    await answerRequest(req(), x.c);
    x.written.length = 0;
    await answerRequest(req(), x.c);
    expect(x.written).toEqual(["\x13", "\x1b[200~hi\x1b[201~", "\r"]);
  });

  test("keys pressed a moment ago make no difference: typed at once", async () => {
    const { c, written } = ctx();
    expect(await answerRequest(req(), c)).toEqual({ ok: true });
    expect(written).toEqual(["\x1b[200~hi\x1b[201~", "\r"]);
  });

  test("Claude quit before Enter: no Enter is written", async () => {
    let calls = 0;
    const x = ctx({ isForeground: async () => ++calls < 2 });
    expect(await answerRequest(req(), x.c)).toEqual({ ok: false, reason: "typed_not_sent" });
    expect(x.written).not.toContain("\r");
  });

  test("no draft: nothing stashed", async () => {
    const { c, written } = ctx();
    await answerRequest(req(), c);
    expect(written).not.toContain("\x13");
  });

  test("a key that answered a dialog stops counting as a draft once you stop typing", () => {
    let t = 1_000;
    const d = new DraftTracker(() => t);
    d.feed("1");
    expect(d.pending).toBe(true);
    t += DraftTracker.STALE_MS - 1;
    expect(d.pending).toBe(true);
    t += 1;
    expect(d.pending).toBe(false);
    // Typing again counts again.
    d.feed("fix");
    expect(d.pending).toBe(true);
  });

  test("a real draft you paused on for minutes is still a draft", () => {
    let t = 1_000;
    const d = new DraftTracker(() => t);
    d.feed("fix the failing test in");
    t += 10 * 60_000;
    expect(d.pending).toBe(true);
    t += DraftTracker.LONG_STALE_MS;
    expect(d.pending).toBe(false);
  });

  test("a lone Esc and a later Enter are separate keys: Enter sends the draft", () => {
    let t = 1_000;
    const d = new DraftTracker(() => t);
    d.feed("also update the docs");
    d.feed("\x1b");
    t += 5_000;
    d.feed("\r");
    expect(d.pending).toBe(false);
    d.feed("ab");
    d.feed("\x1b");
    t += 5_000;
    d.feed("c");
    expect(d.pending).toBe(true);
    d.feed("\x7f\x7f\x7f");
    expect(d.pending).toBe(false);
  });

  test("a slow Esc Esc still clears the draft; a lone Esc followed late by a letter does not", () => {
    let t = 1_000;
    const d = new DraftTracker(() => t);
    d.feed("hello world");
    d.feed("\x1b");
    t += 400;
    d.feed("\x1b");
    expect(d.pending).toBe(false);
    d.feed("hello world");
    d.feed("\x1b");
    t += 900;
    d.feed("\x1b");
    expect(d.pending).toBe(true);
    // The first Esc stood alone; the letter after 400 ms is typed text.
    d.feed("\x7f".repeat(20));
    d.feed("\x1b");
    t += 400;
    d.feed("x");
    expect(d.pending).toBe(true);
  });

  test("the draft follows what you type: Enter sends it, Ctrl+U, Ctrl+C and Esc Esc clear it", () => {
    const d = new DraftTracker();
    expect(d.pending).toBe(false);
    d.feed("fix th");
    expect(d.pending).toBe(true);
    d.feed("e test\r");
    expect(d.pending).toBe(false);
    d.feed("ab");
    d.feed("\x7f\x7f");
    expect(d.pending).toBe(false);
    for (const clear of ["\x15", "\x03", "\x1b\x1b"]) {
      d.feed("draft");
      d.feed(clear);
      expect(d.pending).toBe(false);
    }
    // Arrow keys don't type anything; Option+Enter is a new line, not a send.
    d.feed("\x1b[A\x1b[B\x1bOC");
    expect(d.pending).toBe(false);
    d.feed("line one\x1b\r");
    expect(d.pending).toBe(true);
    d.feed("\r");
    // A paste counts; an empty one doesn't.
    d.feed("\x1b[200~\x1b[201~");
    expect(d.pending).toBe(false);
    d.feed("\x1b[200~pasted\ntext\x1b[201~");
    expect(d.pending).toBe(true);
  });
});

describe("the helper's own key requests and the draft", () => {
  function setup() {
    let t = 100_000;
    const written: string[] = [];
    const d = new DraftTracker(() => t);
    const ctx: RequestContext = {
      token: "tok",
      shellPid: 1,
      isForeground: async () => true,
      hasDraft: () => d.pending,
      sentEnter: () => d.feed("\r"),
      pasteOn: () => true,
      write: (x: string) => void written.push(x),
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    };
    const ask = (r: object) => answerRequest(JSON.stringify({ token: "tok", pid: 7, ...r }), ctx);
    return { d, written, ask, advance: (ms: number) => (t += ms) };
  }

  test("an Enter key request leaves no draft behind", async () => {
    const { d, written, ask, advance } = setup();
    expect(await ask({ text: "first" })).toEqual({ ok: true });
    d.feed("and also");
    advance(4000);
    expect(await ask({ key: "enter" })).toEqual({ ok: true });
    expect(written.at(-1)).toBe("\r");
    advance(60_000);
    expect(d.pending).toBe(false);
    written.length = 0;
    expect(await ask({ text: "second" })).toEqual({ ok: true });
    expect(written[0]).toBe("\x1b[200~second\x1b[201~");
  });

  test("an Escape key request keeps the draft", async () => {
    const { d, ask } = setup();
    d.feed("typed");
    expect(await ask({ key: "escape" })).toEqual({ ok: true });
    expect(d.pending).toBe(true);
  });
});

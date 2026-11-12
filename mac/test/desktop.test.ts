import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { DeliveryError, WaitForUnlock } from "../src/daemon/inject.ts";
import { Registry, replyRouteOf, type SessionRecord } from "../src/daemon/registry.ts";
import { QUEUE_MAX_AGE_MS, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { desktopSessions, desktopTitle, waitForPrompt } from "../src/integrations/claudeDesktop.ts";

// Phone replies typed into the Claude desktop app, waiting for the unlock.

const tmp = () => mkdtempSync(join(tmpdir(), "relay-desktop-"));

describe("desktop app sessions", () => {
  test("titles come from the app's own session files, two folders down", () => {
    const dir = tmp();
    const put = (a: string, b: string, file: string, body: string) => {
      mkdirSync(join(dir, a, b), { recursive: true });
      writeFileSync(join(dir, a, b, file), body);
    };
    put(
      "acct",
      "org",
      "local_1.json",
      JSON.stringify({ cliSessionId: "s-1", title: "Fix login", isArchived: false }),
    );
    put(
      "acct",
      "org",
      "local_2.json",
      JSON.stringify({ cliSessionId: "s-2", title: "Old", isArchived: true }),
    );
    put("acct", "org", "local_3.json", "{ not json");
    put("acct", "org", "other.json", JSON.stringify({ cliSessionId: "s-9", title: "Not a session file" }));
    const sessions = desktopSessions(dir);
    expect(sessions.map((s) => s.cliSessionId).sort()).toEqual(["s-1", "s-2"]);
    expect(desktopTitle("s-1", sessions)).toBe("Fix login");
    // Archived sessions aren't in the sidebar.
    expect(desktopTitle("s-2", sessions)).toBeNull();
    expect(desktopTitle("terminal-session", sessions)).toBeNull();
    expect(desktopSessions(join(dir, "missing"))).toEqual([]);
  });

  test("a send is confirmed only by a user message with exactly that text in the transcript", async () => {
    const path = join(tmp(), "t.jsonl");
    const since = Date.parse("2026-11-04T10:00:00.000Z");
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      path,
      line({ type: "user", timestamp: "2026-11-04T09:00:00.000Z", message: { content: "fix the tests" } }),
    );
    // The same text, but from before the send: not this one.
    expect(await waitForPrompt(path, "fix the tests", since, 300)).toBe(false);
    setTimeout(() => {
      appendFileSync(
        path,
        line({ type: "assistant", timestamp: "2026-11-04T10:00:01.000Z", message: { content: [] } }),
      );
      appendFileSync(
        path,
        line({
          type: "user",
          timestamp: "2026-11-04T10:00:02.000Z",
          message: { content: [{ type: "text", text: "fix the tests" }] },
        }),
      );
    }, 150);
    expect(await waitForPrompt(path, "fix the tests", since, 3000)).toBe(true);
    expect(await waitForPrompt(join(tmp(), "missing.jsonl"), "x", since, 300)).toBe(false);
  });
});

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const notices: string[] = [];
  events.subscribe((e: RelayEvent) => {
    if (e.type === "session.notice") notices.push(e.text);
  });
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop" });
  const queue = new ReplyQueue(db, events, registry);
  return { db, events, registry, queue, notices };
}

describe("replies waiting for the unlock", () => {
  test("nothing goes out while locked; on unlock they go in the order sent", async () => {
    const { queue } = setup();
    queue.add("s1", "first", 1_000);
    queue.add("s1", "second", 2_000);
    const sent: string[] = [];
    const deliver = async (_s: SessionRecord, text: string) => {
      sent.push(text);
    };
    await queue.drain(true, deliver, 3_000);
    expect(sent).toEqual([]);
    expect(queue.list("s1")).toHaveLength(2);
    await queue.drain(false, deliver, 3_000);
    expect(sent).toEqual(["first", "second"]);
    expect(queue.list()).toEqual([]);
  });

  test("locked again mid-way: stops and keeps the rest, in order", async () => {
    const { queue } = setup();
    queue.add("s1", "a", 1);
    queue.add("s1", "b", 2);
    const deliver = async (_s: SessionRecord, text: string) => {
      if (text === "b") throw new WaitForUnlock("locked");
    };
    await queue.drain(false, deliver, 10);
    expect(queue.list().map((r) => r.text)).toEqual(["b"]);
  });

  test("dropped with a notice when the session ended, after a day, or when it can't be delivered", async () => {
    const { queue, registry, notices } = setup();
    registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    registry.setStatus("s2", "ended");
    queue.add("s2", "to an ended session", 1_000);
    queue.add("s1", "too old", 1_000);
    await queue.drain(false, async () => {}, 1_000 + QUEUE_MAX_AGE_MS + 1);
    expect(queue.list()).toEqual([]);
    expect(notices).toEqual([
      "Your message to api wasn't sent: the session ended before your Mac was unlocked.",
      "Your message to web-shop wasn't sent: your Mac stayed locked for a day.",
    ]);

    notices.length = 0;
    queue.add("s1", "unreachable", 5_000);
    await queue.drain(
      false,
      async () => {
        throw new DeliveryError("no inbox");
      },
      6_000,
    );
    expect(queue.list()).toEqual([]);
    expect(notices).toEqual(["Your message to web-shop wasn't sent: Relay couldn't reach it."]);
  });

  test("a session stuck in a slow delivery doesn't hold up another session's replies", async () => {
    const { registry, queue } = setup();
    registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    queue.add("s1", "slow", 1_000, "pause");
    queue.add("s2", "fast", 1_000, "pause");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sent: string[] = [];
    const deliver = async (_s: SessionRecord, text: string) => {
      if (text === "slow") await gate;
      sent.push(text);
    };
    const first = queue.drain(false, deliver, 2_000);
    await Bun.sleep(5);
    await queue.drain(false, deliver, 2_000);
    expect(sent).toEqual(["fast"]);
    release();
    await first;
    expect(sent).toEqual(["fast", "slow"]);
  });

  test("survives a helper restart (kept in the database)", () => {
    const { db, events, registry, queue } = setup();
    queue.add("s1", "kept", 1);
    expect(new ReplyQueue(db, events, registry).list().map((r) => r.text)).toEqual(["kept"]);
  });

  test("session.send queues behind replies already waiting, so the order holds", async () => {
    const { db, events, registry, queue } = setup();
    const rpc = createRpc({
      db,
      events,
      registry,
      replies: queue,
      broker: { hasOpen: () => false },
      config: { preferTyping: true },
    } as unknown as RpcDeps);
    queue.add("s1", "waiting", 1);
    const res = await rpc("session.send", { sessionId: "s1", text: "next" }, "phone");
    expect(res).toEqual({ result: { via: "queued" } });
    expect(queue.list("s1").map((r) => r.text)).toEqual(["waiting", "next"]);
  });
});

describe("Session.replyRoute", () => {
  const base = {
    status: "idle",
    terminal: null,
    ptySocket: null,
    tmuxPane: null,
    tmuxSocket: null,
    socketPath: null,
  };
  const s = (o: Partial<SessionRecord>) => ({ id: "x", ...base, ...o }) as unknown as SessionRecord;
  test("typed in a Relay terminal or tmux, labelled through the inbox, absent otherwise", () => {
    expect(replyRouteOf(s({ ptySocket: "/p.sock" }))).toEqual({ replyRoute: "typed" });
    expect(replyRouteOf(s({ tmuxPane: "%1", tmuxSocket: "/t" }))).toEqual({ replyRoute: "typed" });
    expect(replyRouteOf(s({ socketPath: "/inbox.sock" }))).toEqual({ replyRoute: "labelled" });
    expect(replyRouteOf(s({}))).toEqual({});
    expect(replyRouteOf(s({ status: "ended", ptySocket: "/p.sock" } as Partial<SessionRecord>))).toEqual({});
  });
});

describe("stale composer text", () => {
  test("the last user message in the transcript is what a stale composer shows; anything else is a draft", async () => {
    const { lastUserMessage } = await import("../src/integrations/claudeDesktop.ts");
    const path = join(tmp(), "t.jsonl");
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      path,
      line({ type: "user", message: { content: "first" } }) +
        line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) +
        line({
          type: "user",
          message: { content: [{ type: "text", text: "  Reply with only the word X  " }] },
        }) +
        line({ type: "assistant", message: { content: [] } }),
    );
    expect(await lastUserMessage(path)).toBe("Reply with only the word X");
    expect(await lastUserMessage(null)).toBeNull();
    expect(await lastUserMessage(join(tmp(), "none.jsonl"))).toBeNull();
  });
});

describe("asking for Accessibility again", () => {
  test("first time, after a day, or when the person is at the terminal; not more often", async () => {
    const { shouldAsk, ASK_AGAIN_MS } = await import("../src/integrations/claudeDesktop.ts");
    const day = ASK_AGAIN_MS;
    expect(shouldAsk(null, 1_000, false)).toBe(true);
    expect(shouldAsk(1_000, 1_000 + day - 1, false)).toBe(false);
    expect(shouldAsk(1_000, 1_000 + day, false)).toBe(true);
    // relay install / relay pair
    expect(shouldAsk(1_000, 1_001, true)).toBe(true);
  });
});

describe("stale composer text, older sends", () => {
  test("any recent sent message counts as stale, not only the last one", async () => {
    const { recentUserMessages } = await import("../src/integrations/claudeDesktop.ts");
    const path = join(tmp(), "t.jsonl");
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      path,
      line({ type: "user", message: { content: "sent by Relay earlier" } }) +
        line({ type: "assistant", message: { content: [] } }) +
        line({ type: "user", message: { content: "a later message through the inbox" } }),
    );
    const recent = await recentUserMessages(path);
    expect(recent).toEqual(["a later message through the inbox", "sent by Relay earlier"]);
    expect(recent.includes("sent by Relay earlier")).toBe(true);
    expect(recent.includes("a draft nobody sent")).toBe(false);
  });
});

describe("IDE extension sessions", () => {
  test("recognised by the transcript's entrypoint; recent answers identify the tab", async () => {
    const { isIdeSession, isIdeSessionSync, recentAnswerSnippets } = await import(
      "../src/integrations/ideExtension.ts"
    );
    const line = (o: object) => `${JSON.stringify(o)}\n`;
    const ide = join(tmp(), "ide.jsonl");
    writeFileSync(
      ide,
      line({ type: "user", entrypoint: "claude-vscode", message: { content: "Hi" } }) +
        line({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hi! What would you like to work on?\nMore" }] },
        }) +
        line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }) +
        line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }) +
        line({
          type: "assistant",
          message: { content: [{ type: "text", text: "Fixed the cart total rounding." }] },
        }),
    );
    const terminal = join(tmp(), "term.jsonl");
    writeFileSync(terminal, line({ type: "user", entrypoint: "cli", message: { content: "Hi" } }));
    expect(await isIdeSession(ide)).toBe(true);
    expect(isIdeSessionSync(ide)).toBe(true);
    expect(await isIdeSession(terminal)).toBe(false);
    expect(isIdeSessionSync(terminal)).toBe(false);
    expect(isIdeSessionSync(null)).toBe(false);
    // Newest first, first line only, and too-short answers ("Done.") don't identify a tab.
    expect(await recentAnswerSnippets(ide)).toEqual([
      "Fixed the cart total rounding.",
      "Hi! What would you like to work on?",
    ]);
    expect(await recentAnswerSnippets(null)).toEqual([]);
  });
});

describe("IDE context in prompts", () => {
  test("the extension's context blocks are left out of what the phone shows", async () => {
    const { withoutIdeContext } = await import("../src/daemon/render.ts");
    expect(
      withoutIdeContext(
        "<ide_opened_file>The user opened the file /x/a.csv in the IDE. This may or may not be related.</ide_opened_file>\nHi",
      ),
    ).toBe("Hi");
    expect(
      withoutIdeContext(
        "<ide_selection>The user selected lines 1-3:\nfoo()\n</ide_selection>\nwhy does this fail?",
      ),
    ).toBe("why does this fail?");
    // A title cut before the closing tag: nothing of the block is left.
    expect(withoutIdeContext("<ide_opened_file>The user opened the file /Users/me/Downloads/Notes_bu…")).toBe(
      "",
    );
    expect(withoutIdeContext("Fix <b>bold</b> handling")).toBe("Fix <b>bold</b> handling");
  });
});

test("replyFix points to Accessibility only where it would help", async () => {
  const { replyRouteOf } = await import("../src/daemon/registry.ts");
  const base = {
    id: "nobody",
    status: "idle",
    terminal: null,
    ptySocket: null,
    tmuxPane: null,
    tmuxSocket: null,
  };
  // A terminal session through the inbox (Terminal.app): labelled, and nothing to switch on.
  const r = replyRouteOf({ ...base, socketPath: "/inbox.sock", terminal: "Apple_Terminal" } as never);
  expect(r).toEqual({ replyRoute: "labelled" });
});

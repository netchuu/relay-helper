import { describe, expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { DeliveryError, deliver, type GuiOps, OpenEditorPanel, type TypeOps } from "../src/daemon/inject.ts";
import { Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { ReplyQueue } from "../src/daemon/replyQueue.ts";

function session(): SessionRecord {
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env: {} });
  return registry.get("s1") as SessionRecord;
}

const gui = (sendToIde: GuiOps["sendToIde"]): GuiOps => ({
  desktopReady: async () => false,
  sendToDesktop: async () => "failed",
  isIdeSession: () => true,
  axAllowed: () => true,
  sendToIde,
});
const ops = (g: GuiOps): TypeOps => ({
  pty: async () => ({ ok: false, reason: "not_foreground" }),
  tmuxScreen: async () => null,
  tmux: async () => {},
  routes: () => [],
  ttyOf: async () => null,
  peek: async () => null,
  type: async () => false,
  inFront: async () => true,
  sleep: async () => {},
  gui: g,
});
const opts = { userTypingNow: false, preferTyping: true };

describe("an editor chat with no visible Claude Code panel", () => {
  test("no tab and no inbox socket: fails with the plain reason", async () => {
    const err = await deliver(session(), "Что осталось?", opts, ops(gui(async () => "not-found"))).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(OpenEditorPanel);
    expect(err.message).toBe("Open the Claude Code panel in your editor on the Mac, then send again");
  });

  test("a locked screen with no inbox socket fails at once with a plain line", async () => {
    const err = await deliver(session(), "hi", opts, ops(gui(async () => "locked"))).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toBe("Unlock your Mac to send to the Claude app");
  });

  test("a message held by the old reason is retried at once and ends with that reason", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env: {} });
    const notices: string[] = [];
    events.subscribe?.((e: { type: string; text?: string }) => {
      if (e.type === "session.notice" && e.text) notices.push(e.text);
    });
    const queue = new ReplyQueue(db, events, registry);
    queue.add("s1", "Что осталось?", 1_000, "unlock");
    await queue.drain(async (s, text) => {
      await deliver(s, text, opts, ops(gui(async () => "not-found")));
    }, 2_000);
    expect(queue.list()).toEqual([]);
    expect(notices).toEqual([
      "Your message to web-shop wasn't sent: Open the Claude Code panel in your editor on the Mac, then send again.",
    ]);
  });
});

describe("an open panel that can't take the message right now", () => {
  for (const result of ["draft", "busy", "failed", "ambiguous"] as const) {
    test(`${result} with no inbox socket doesn't ask to open the panel`, async () => {
      const err = await deliver(session(), "hi", opts, ops(gui(async () => result))).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(OpenEditorPanel);
    });
  }

  test("Accessibility off doesn't ask to open the panel", async () => {
    const g = { ...gui(async () => "sent"), axAllowed: () => false };
    const err = await deliver(session(), "hi", opts, ops(g)).catch((e) => e);
    expect(err).not.toBeInstanceOf(OpenEditorPanel);
  });
});

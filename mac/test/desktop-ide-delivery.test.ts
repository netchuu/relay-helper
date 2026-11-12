// Replies typed into the Claude desktop app and IDE panels, edge cases: the unlock queue, session.send while locked,
// confirming a send in the transcript, IDE context, and the reply route. Nothing here touches Accessibility, a real app, or ~/.relay: the queue and session.send run on
// an in-memory database with a fake deliver or a temporary inbox socket; transcripts and session files live in
// temporary folders. No session here has an IDE or desktop transcript, so `deliver` never reaches the AX routes.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent } from "../../protocol/index.ts";
import { openDb, SCHEMA_VERSION } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { PHONE_PREFIX, WaitForUnlock } from "../src/daemon/inject.ts";
import { publicSession, Registry, replyRouteOf, type SessionRecord } from "../src/daemon/registry.ts";
import { withoutIdeContext } from "../src/daemon/render.ts";
import { QUEUE_MAX_AGE_MS, ReplyQueue } from "../src/daemon/replyQueue.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import {
  ASK_AGAIN_MS,
  desktopSessions,
  desktopTitle,
  recentUserMessages,
  shouldAsk,
  waitForPrompt,
} from "../src/integrations/claudeDesktop.ts";
import { isIdeSessionSync, recentAnswerSnippets } from "../src/integrations/ideExtension.ts";
import { platform } from "../src/platform/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "relay-dide-"));
const line = (o: object) => `${JSON.stringify(o)}\n`;
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const notices: { sessionId: string; text: string }[] = [];
  events.subscribe((e: RelayEvent) => {
    if (e.type === "session.notice") notices.push({ sessionId: e.sessionId, text: e.text });
  });
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop" });
  registry.touch("s2", { cwd: "/Users/me/Projects/api" });
  const queue = new ReplyQueue(db, events, registry);
  return { db, events, registry, queue, notices };
}

describe("queue: order and concurrency", () => {
  test("replies to two sessions go out in the order they were sent, across sessions", async () => {
    const { queue } = setup();
    queue.add("s1", "a1", 1);
    queue.add("s2", "b1", 2);
    queue.add("s1", "a2", 3);
    const sent: string[] = [];
    await queue.drain(false, async (s, t) => void sent.push(`${s.id}:${t}`), 10);
    expect(sent).toEqual(["s1:a1", "s2:b1", "s1:a2"]);
  });

  test("two overlapping drains deliver each reply once", async () => {
    const { queue } = setup();
    queue.add("s1", "one", 1);
    queue.add("s1", "two", 2);
    const sent: string[] = [];
    const slow = async (_s: SessionRecord, t: string) => {
      await Bun.sleep(30);
      sent.push(t);
    };
    await Promise.all([
      queue.drain(false, slow, 10),
      queue.drain(false, slow, 10),
      queue.drain(false, slow, 10),
    ]);
    expect(sent).toEqual(["one", "two"]);
    expect(queue.list()).toEqual([]);
  });

  test("a reply queued while a drain is running is kept, and goes out after the earlier ones", async () => {
    const { queue } = setup();
    queue.add("s1", "first", 1);
    const sent: string[] = [];
    await queue.drain(
      false,
      async (_s, t) => {
        if (t === "first") queue.add("s1", "late", 2);
        sent.push(t);
      },
      10,
    );
    // Not lost: either delivered now or still waiting for the next drain.
    const left = queue.list().map((r) => r.text);
    expect([...sent, ...left]).toEqual(["first", "late"]);
    await queue.drain(false, async (_s, t) => void sent.push(t), 10);
    expect(sent).toEqual(["first", "late"]);
  });

  test("locked again at the very first reply: nothing sent, nothing dropped, no notice", async () => {
    const { queue, notices } = setup();
    queue.add("s1", "a", 1);
    queue.add("s2", "b", 2);
    await queue.drain(
      false,
      async () => {
        throw new WaitForUnlock("locked");
      },
      10,
    );
    expect(queue.list().map((r) => r.text)).toEqual(["a", "b"]);
    expect(notices).toEqual([]);
  });

  test("one reply that fails is dropped alone; the next still goes out", async () => {
    const { queue, notices } = setup();
    queue.add("s1", "bad", 1);
    queue.add("s1", "good", 2);
    const sent: string[] = [];
    await queue.drain(
      false,
      async (_s, t) => {
        if (t === "bad") throw new Error("boom");
        sent.push(t);
      },
      10,
    );
    expect(sent).toEqual(["good"]);
    expect(notices.map((n) => n.text)).toEqual([
      "Your message to web-shop wasn't sent: Relay couldn't reach it.",
    ]);
  });
});

describe("queue: dropping", () => {
  test("exactly 24 h old still goes out; a millisecond more is dropped", async () => {
    const { queue, notices } = setup();
    queue.add("s1", "on the edge", 0);
    const sent: string[] = [];
    await queue.drain(false, async (_s, t) => void sent.push(t), QUEUE_MAX_AGE_MS);
    expect(sent).toEqual(["on the edge"]);
    queue.add("s1", "too late", 0);
    await queue.drain(false, async (_s, t) => void sent.push(t), QUEUE_MAX_AGE_MS + 1);
    expect(sent).toEqual(["on the edge"]);
    expect(notices.map((n) => n.text)).toEqual([
      "Your message to web-shop wasn't sent: your Mac stayed locked for a day.",
    ]);
  });

  test("a session the helper no longer knows: dropped, the notice names no session", async () => {
    const { queue, notices } = setup();
    queue.add("gone", "hello", 1);
    await queue.drain(false, async () => {}, 10);
    expect(queue.list()).toEqual([]);
    expect(notices).toEqual([
      {
        sessionId: "gone",
        text: "Your message to the session wasn't sent: the session ended before your Mac was unlocked.",
      },
    ]);
  });

  test("a session renamed from the phone while the reply waited: the notice uses the new name", async () => {
    const { queue, registry, notices } = setup();
    queue.add("s1", "hello", 1);
    registry.rename("s1", "Checkout");
    registry.setStatus("s1", "ended");
    await queue.drain(false, async () => {}, 10);
    expect(notices.map((n) => n.text)).toEqual([
      "Your message to Checkout wasn't sent: the session ended before your Mac was unlocked.",
    ]);
  });

  test("still locked: an old reply isn't dropped yet (the age is only checked on unlock)", async () => {
    const { queue, notices } = setup();
    queue.add("s1", "old", 0);
    await queue.drain(true, async () => {}, QUEUE_MAX_AGE_MS * 3);
    expect(queue.list()).toHaveLength(1);
    expect(notices).toEqual([]);
  });
});

describe("queue: database", () => {
  test("opening the same database again keeps waiting replies, and the schema is fully migrated", () => {
    const path = join(tmp(), "relay.db");
    const db1 = openDb(path);
    const r1 = new Registry(db1, new EventLog(db1));
    r1.touch("s1", { cwd: "/x" });
    new ReplyQueue(db1, new EventLog(db1), r1).add("s1", "kept", 1);
    db1.close();
    const db2 = openDb(path);
    const version = (db2.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version).toBe(SCHEMA_VERSION);
    const r2 = new Registry(db2, new EventLog(db2));
    expect(new ReplyQueue(db2, new EventLog(db2), r2).list().map((r) => r.text)).toEqual(["kept"]);
    db2.close();
  });
});

describe("session.send while locked", () => {
  const read = platform.presence.read;
  afterEach(() => {
    platform.presence.read = read;
  });
  const lockedReading = (locked: boolean | null) => {
    platform.presence.read = async () => ({ idleSeconds: 300, locked }) as Awaited<ReturnType<typeof read>>;
  };

  /** A temporary inbox socket that records what Claude Code would receive. */
  async function inbox(): Promise<{ path: string; got: string[]; server: Server }> {
    const path = join(tmp(), "in.sock");
    const got: string[] = [];
    const server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString();
      });
      c.on("end", () => {
        for (const l of buf.split("\n").filter(Boolean)) {
          const m = JSON.parse(l) as { type: string; message?: { content: string } };
          if (m.type === "user" && m.message) got.push(m.message.content);
        }
      });
    });
    await new Promise<void>((r) => server.listen(path, r));
    return { path, got, server };
  }

  function rpcFor(s: ReturnType<typeof setup>, withQueue = true) {
    return createRpc({
      db: s.db,
      events: s.events,
      registry: s.registry,
      ...(withQueue ? { replies: s.queue } : {}),
      broker: { hasOpen: () => false },
      config: { preferTyping: true },
    } as unknown as RpcDeps);
  }

  test("a session that isn't in the desktop app or an IDE isn't queued: the inbox takes it at once", async () => {
    lockedReading(true);
    const s = setup();
    const box = await inbox();
    s.db.query("UPDATE sessions SET socket_path = ? WHERE id = 's1'").run(box.path);
    const res = await rpcFor(s)("session.send", { sessionId: "s1", text: "hi from the phone" }, "phone");
    expect(res).toEqual({ result: { via: "socket" } });
    expect(s.queue.list()).toEqual([]);
    await Bun.sleep(50);
    expect(box.got).toEqual([`${PHONE_PREFIX}\nhi from the phone`]);
    box.server.close();
  });

  test("waiting replies for another session don't hold this one back", async () => {
    lockedReading(false);
    const s = setup();
    const box = await inbox();
    s.db.query("UPDATE sessions SET socket_path = ? WHERE id = 's1'").run(box.path);
    s.queue.add("s2", "for the other session", 1);
    const res = await rpcFor(s)("session.send", { sessionId: "s1", text: "now" }, "phone");
    expect(res).toEqual({ result: { via: "socket" } });
    expect(s.queue.list().map((r) => r.text)).toEqual(["for the other session"]);
    box.server.close();
  });

  test("an unknown lock state (null) isn't treated as locked", async () => {
    lockedReading(null);
    const s = setup();
    const box = await inbox();
    s.db.query("UPDATE sessions SET socket_path = ? WHERE id = 's1'").run(box.path);
    const res = await rpcFor(s)("session.send", { sessionId: "s1", text: "x" }, "phone");
    expect(res).toEqual({ result: { via: "socket" } });
    box.server.close();
  });

  test("an ended session with replies still waiting: not found, nothing more is queued", async () => {
    lockedReading(true);
    const s = setup();
    s.queue.add("s1", "waiting", 1);
    s.registry.setStatus("s1", "ended");
    const res = (await rpcFor(s)("session.send", { sessionId: "s1", text: "more" }, "phone")) as {
      error?: { code: string };
    };
    expect(res.error?.code).toBe("not_found");
    expect(s.queue.list().map((r) => r.text)).toEqual(["waiting"]);
  });

  test("no inbox and nothing else: unavailable, and nothing is queued", async () => {
    lockedReading(true);
    const s = setup();
    const res = (await rpcFor(s)("session.send", { sessionId: "s1", text: "x" }, "phone")) as {
      error?: { code: string };
    };
    expect(res.error?.code).toBe("unavailable");
    expect(s.queue.list()).toEqual([]);
  });
});

describe("transcript confirmation (waitForPrompt)", () => {
  const since = Date.parse("2026-11-04T10:00:00.000Z");

  test("a line still being written at the end doesn't hide the sent message before it", async () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(
      path,
      line({ type: "user", timestamp: iso(since + 500), message: { content: "ship it" } }) +
        '{"type":"user","timestamp":"2026-11-04T10:00:01',
    );
    expect(await waitForPrompt(path, "ship it", since, 300)).toBe(true);
  });

  test("tool results after the send (also type user) neither confirm it nor stop the search", async () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(
      path,
      line({
        type: "user",
        timestamp: iso(since + 100),
        message: { content: [{ type: "text", text: "run tests" }] },
      }) +
        line({
          type: "user",
          timestamp: iso(since + 900),
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "run tests" }] },
        }),
    );
    expect(await waitForPrompt(path, "run tests", since, 300)).toBe(true);
    const only = join(tmp(), "t.jsonl");
    writeFileSync(
      only,
      line({
        type: "user",
        timestamp: iso(since + 900),
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "run tests" }] },
      }),
    );
    expect(await waitForPrompt(only, "run tests", since, 300)).toBe(false);
  });

  test("emoji, other scripts and surrounding spaces match", async () => {
    const path = join(tmp(), "t.jsonl");
    const text = "Проверь это 🚀👨‍👩‍👧 ok";
    writeFileSync(path, line({ type: "user", timestamp: iso(since), message: { content: `  ${text}\n` } }));
    expect(await waitForPrompt(path, `${text} `, since, 300)).toBe(true);
  });

  test("a message written 2 s before the send counts (clock slack); 3 s before doesn't", async () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(path, line({ type: "user", timestamp: iso(since - 1999), message: { content: "go" } }));
    expect(await waitForPrompt(path, "go", since, 200)).toBe(true);
    writeFileSync(path, line({ type: "user", timestamp: iso(since - 3000), message: { content: "go" } }));
    expect(await waitForPrompt(path, "go", since, 200)).toBe(false);
  });

  test("in a transcript far over 256 KB, the message at the end is found", async () => {
    const path = join(tmp(), "t.jsonl");
    const filler = line({
      type: "assistant",
      timestamp: iso(since - 60_000),
      message: { content: [{ type: "text", text: "x".repeat(4000) }] },
    }).repeat(200);
    writeFileSync(
      path,
      filler + line({ type: "user", timestamp: iso(since + 10), message: { content: "end" } }),
    );
    expect(await waitForPrompt(path, "end", since, 300)).toBe(true);
  });
});

describe("recent user messages (stale composer text)", () => {
  test("tool results and empty messages aren't counted; newest first; string or blocks", async () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(
      path,
      line({ type: "user", message: { content: "first" } }) +
        line({ type: "user", message: { content: [{ type: "text", text: "second " }] } }) +
        line({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "x", content: "output" }] },
        }) +
        line({ type: "user", message: { content: "   " } }) +
        '{"type":"user","message":{"content":"half',
    );
    expect(await recentUserMessages(path)).toEqual(["second", "first"]);
    expect(await recentUserMessages(path, 1)).toEqual(["second"]);
    expect(await recentUserMessages(null)).toEqual([]);
    expect(await recentUserMessages(join(tmp(), "missing.jsonl"))).toEqual([]);
  });
});

describe("IDE sessions", () => {
  test("a 'not an IDE session' answer isn't cached: once the transcript says claude-vscode, it is one", () => {
    const path = join(tmp(), "t.jsonl");
    expect(isIdeSessionSync(path)).toBe(false); // no transcript yet (first reply)
    writeFileSync(path, line({ type: "user", entrypoint: "cli", message: { content: "x" } }));
    expect(isIdeSessionSync(path)).toBe(false);
    writeFileSync(path, line({ type: "user", entrypoint: "claude-vscode", message: { content: "x" } }));
    expect(isIdeSessionSync(path)).toBe(true);
    expect(isIdeSessionSync(null)).toBe(false);
  });

  test("the entrypoint quoted inside a message (escaped JSON) doesn't make a session an IDE one", () => {
    const path = join(tmp(), "t.jsonl");
    writeFileSync(
      path,
      line({
        type: "user",
        entrypoint: "cli",
        message: { content: 'grep \'"entrypoint":"claude-vscode"\'' },
      }),
    );
    expect(isIdeSessionSync(path)).toBe(false);
  });

  test("answer snippets: one line, at most 60 characters, no duplicates, thinking and tool calls left out", async () => {
    const path = join(tmp(), "t.jsonl");
    const long = `Here is a very long first line that goes well past sixty characters in total\nsecond`;
    writeFileSync(
      path,
      line({ type: "assistant", message: { content: [{ type: "text", text: long }] } }) +
        line({ type: "assistant", message: { content: [{ type: "text", text: long }] } }) +
        line({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "secret thoughts that are long enough" },
              { type: "tool_use", name: "Bash", input: {} },
            ],
          },
        }) +
        line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
    );
    expect(await recentAnswerSnippets(path)).toEqual([long.slice(0, 60)]);
    expect(await recentAnswerSnippets(null)).toEqual([]);
  });
});

describe("desktop app session files", () => {
  test("an unreadable file and a title that isn't text are skipped; archived copies don't shadow the live one", () => {
    const dir = tmp();
    mkdirSync(join(dir, "acct", "org"), { recursive: true });
    const put = (f: string, o: unknown) => writeFileSync(join(dir, "acct", "org", f), JSON.stringify(o));
    put("local_a.json", { cliSessionId: "dup", title: "Old copy", isArchived: true });
    put("local_b.json", { cliSessionId: "dup", title: "Live", isArchived: false });
    put("local_c.json", { cliSessionId: "n", title: 42 });
    put("local_d.json", { cliSessionId: "locked", title: "Hidden" });
    chmodSync(join(dir, "acct", "org", "local_d.json"), 0o000);
    writeFileSync(join(dir, "acct", "stray.json"), "{}"); // a file one level up, not a folder
    const sessions = desktopSessions(dir);
    expect(desktopTitle("dup", sessions)).toBe("Live");
    expect(desktopTitle("n", sessions)).toBeNull();
    if (process.getuid?.() !== 0) expect(desktopTitle("locked", sessions)).toBeNull();
    chmodSync(join(dir, "acct", "org", "local_d.json"), 0o600);
  });
});

describe("IDE context left out of what the phone shows", () => {
  test("several blocks, Windows line breaks, and code with < > inside a selection", () => {
    const prompt =
      "<ide_opened_file>The user opened /a.ts</ide_opened_file>\r\n" +
      "<ide_selection>if (a < b && c > d) { return <div/>; }</ide_selection>\r\n" +
      "Why does this fail?";
    expect(withoutIdeContext(prompt)).toBe("Why does this fail?");
  });

  test("a prompt that is only context becomes empty, and a session title made of it is no title", () => {
    expect(withoutIdeContext("<ide_opened_file>The user opened /a.ts</ide_opened_file>")).toBe("");
    // A title cut to one line mid-block, recorded before the context was left out.
    const s = setup();
    s.registry.setStatus("s1", "working", { title: "<ide_opened_file>The user opened /a.ts" });
    expect(publicSession(s.registry.get("s1") as SessionRecord).title).toBeNull();
  });

  test("ordinary angle brackets in the person's own text stay", () => {
    expect(withoutIdeContext("Use <T> in fn<T>() and a <b>bold</b> tag")).toBe(
      "Use <T> in fn<T>() and a <b>bold</b> tag",
    );
  });
});

describe("asking for Accessibility", () => {
  test("boundaries: exactly a day later asks; a millisecond earlier doesn't; forced always does", () => {
    expect(shouldAsk(0, ASK_AGAIN_MS, false)).toBe(true);
    expect(shouldAsk(0, ASK_AGAIN_MS - 1, false)).toBe(false);
    expect(shouldAsk(5_000, 0, false)).toBe(false); // clock went back: not a reason to nag
    expect(shouldAsk(5_000, 0, true)).toBe(true);
    expect(shouldAsk(null, 0, false)).toBe(true);
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
  const s = (o: Record<string, unknown>) =>
    ({
      id: "x-not-a-desktop-session",
      cwd: "/x",
      transcript: null,
      ...base,
      ...o,
    }) as unknown as SessionRecord;
  test("a Relay terminal wins over the inbox; tmux needs both pane and socket; ended has none", () => {
    expect(replyRouteOf(s({ ptySocket: "/p", socketPath: "/i" }))).toEqual({ replyRoute: "typed" });
    expect(replyRouteOf(s({ tmuxPane: "%1", socketPath: "/i" }))).toEqual({ replyRoute: "labelled" });
    expect(replyRouteOf(s({ status: "ended", socketPath: "/i" }))).toEqual({});
  });
});

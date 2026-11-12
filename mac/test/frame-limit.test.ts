import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELAY_FRAME_BYTES,
  REPLY_DATA_BYTES,
  RpcSchemas,
  SyncResult,
  TurnFullResult,
} from "../../protocol/index.ts";
import { createPairingCode } from "../src/daemon/auth.ts";
import { ClientSession } from "../src/daemon/clientSession.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { SentMessages } from "../src/daemon/sentMessages.ts";

// Nothing the helper sends may pass the relay's 256 KiB frame limit (the relay closes the Mac's whole link for it).

const bytes = (s: string) => Buffer.byteLength(s);

function helper() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const rpc = createRpc({
    db,
    events,
    registry,
    broker: { hasOpen: () => false },
    config: {},
  } as unknown as RpcDeps);
  return { db, events, rpc };
}

const emitBig = (events: EventLog, n: number, chars: number) =>
  // biome-ignore lint/suspicious/noExplicitAny: a test event of any size
  events.emit({ type: "session.removed", sessionId: `${n}:${"x".repeat(chars)}` } as any);

async function openSession(
  rpc: ReturnType<typeof helper>["rpc"],
  events: EventLog,
  db: ReturnType<typeof openDb>,
) {
  const sent: string[] = [];
  const session = new ClientSession(
    (t) => sent.push(t),
    { rpc, events, db },
    () => {},
  );
  const { code } = createPairingCode(db);
  await session.handle(JSON.stringify({ id: 1, method: "pair", params: { code, deviceName: "P" } }));
  sent.length = 0;
  return { session, sent };
}

describe("sync", () => {
  test("a replay over the size limit is cut, latestSeq is the last event sent, and the rest follows", async () => {
    const { events, rpc } = helper();
    for (let i = 0; i < 12; i++) emitBig(events, i, 40_000); // about 480 KB in all
    const seen: number[] = [];
    let since = 1;
    for (let round = 0; round < 10; round++) {
      const out = (await rpc("sync", { sinceSeq: since }, "p")) as { result: unknown };
      const res = SyncResult.parse(out.result);
      expect(bytes(JSON.stringify({ type: "rpc", id: 1, ...out }))).toBeLessThan(RELAY_FRAME_BYTES);
      seen.push(...res.events.map((e) => e.seq));
      if (!res.more) break;
      expect(res.events.length).toBeGreaterThan(0);
      expect(res.latestSeq).toBe(res.events.at(-1)?.seq ?? -1);
      since = res.latestSeq;
    }
    expect(seen).toEqual(Array.from({ length: 11 }, (_, i) => i + 2));
  });

  test("a replay cut at 1000 events says so and names the last seq sent", async () => {
    const { events, rpc } = helper();
    for (let i = 0; i < 1005; i++) emitBig(events, i, 1);
    const first = SyncResult.parse(((await rpc("sync", { sinceSeq: 1 }, "p")) as { result: unknown }).result);
    expect(first.more).toBe(true);
    expect(first.events).toHaveLength(1000);
    expect(first.latestSeq).toBe(1001);
    const rest = SyncResult.parse(
      ((await rpc("sync", { sinceSeq: first.latestSeq }, "p")) as { result: unknown }).result,
    );
    expect(rest.more).toBeUndefined();
    expect(rest.events.map((e) => e.seq)).toEqual([1002, 1003, 1004, 1005]);
    expect(rest.latestSeq).toBe(1005);
  });

  test("one event too big to ever fit is skipped, not allowed to block the rest", async () => {
    const { events, rpc } = helper();
    emitBig(events, 0, 10);
    emitBig(events, 1, REPLY_DATA_BYTES + 10);
    emitBig(events, 2, 10);
    const res = SyncResult.parse(((await rpc("sync", { sinceSeq: 1 }, "p")) as { result: unknown }).result);
    expect(res.events.map((e) => e.seq)).toEqual([3]);
    expect(res.latestSeq).toBe(3);
  });
});

describe("session.turns", () => {
  test("a page over the limit keeps the newest turns that fit", async () => {
    const { db, rpc } = helper();
    new Registry(db, new EventLog(db)).touch("s1", { cwd: "/x" });
    for (let i = 0; i < 30; i++)
      db.query(
        "INSERT INTO turns (id, session_id, prompt, summary, ended_at, started_at) VALUES (?, 's1', ?, 's', ?, ?)",
      ).run(`t${i}`, "p".repeat(20_000), 1000 + i, 1000 + i);
    const out = (await rpc(
      "session.turns",
      RpcSchemas["session.turns"].parse({ sessionId: "s1", limit: 30 }),
      "p",
    )) as {
      result: { id: string }[];
    };
    expect(bytes(JSON.stringify(out))).toBeLessThan(REPLY_DATA_BYTES + 1024);
    expect(out.result.length).toBeGreaterThan(3);
    expect(out.result.length).toBeLessThan(30);
    expect(out.result[0]?.id).toBe("t29");
  });
});

describe("session.turns with one huge prompt", () => {
  test("the only turn is kept with its prompt cut, and the reply fits", async () => {
    const { db, rpc } = helper();
    new Registry(db, new EventLog(db)).touch("s1", { cwd: "/x" });
    db.query(
      "INSERT INTO turns (id, session_id, prompt, summary, ended_at, started_at) VALUES ('big', 's1', ?, 's', 2000, 2000)",
    ).run("😀 prompt ".repeat(40_000));
    const out = (await rpc(
      "session.turns",
      RpcSchemas["session.turns"].parse({ sessionId: "s1", limit: 30 }),
      "p",
    )) as { result: { id: string; prompt: string }[] };
    expect(bytes(JSON.stringify(out))).toBeLessThan(REPLY_DATA_BYTES + 1024);
    expect(out.result.map((t) => t.id)).toEqual(["big"]);
    expect(out.result[0]?.prompt.endsWith("…")).toBe(true);
  });
});

describe("turn.full", () => {
  test("a text over the limit comes in pieces that add up to it; an old phone's call gets the first piece", async () => {
    const { db, rpc } = helper();
    const text = `${'héllo 😀 \n"q" '.repeat(60_000)}end`;
    db.query("INSERT INTO turns (id, session_id, full_text) VALUES ('t1', 's1', ?)").run(text);
    let offset = 0;
    let got = "";
    for (let i = 0; i < 50; i++) {
      const out = (await rpc("turn.full", RpcSchemas["turn.full"].parse({ turnId: "t1", offset }), "p")) as {
        result: unknown;
      };
      expect(bytes(JSON.stringify({ type: "rpc", id: 1, ...out }))).toBeLessThan(RELAY_FRAME_BYTES);
      const piece = TurnFullResult.parse(out.result);
      got += piece.text;
      if (!piece.more) break;
      offset = piece.nextOffset ?? -1;
    }
    expect(got).toBe(text);
    const old = TurnFullResult.parse(
      ((await rpc("turn.full", { turnId: "t1" }, "p")) as { result: unknown }).result,
    );
    expect(old.more).toBe(true);
    expect(text.startsWith(old.text)).toBe(true);
  });

  test("a short text is one piece with no paging fields", async () => {
    const { db, rpc } = helper();
    db.query("INSERT INTO turns (id, session_id, full_text) VALUES ('t1', 's1', 'short')").run();
    expect(await rpc("turn.full", { turnId: "t1" }, "p")).toEqual({ result: { text: "short" } });
  });
});

describe("ClientSession", () => {
  test("a result over the frame limit is answered with an error and the link stays", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const huge = async () => ({ result: "x".repeat(RELAY_FRAME_BYTES + 5) });
    const { session, sent } = await openSession(huge, events, db);
    await session.handle(JSON.stringify({ id: 7, method: "sessions.list", params: {} }));
    expect(sent).toHaveLength(1);
    expect(bytes(sent[0] ?? "")).toBeLessThan(RELAY_FRAME_BYTES);
    expect(JSON.parse(sent[0] ?? "")).toMatchObject({ type: "rpc", id: 7, error: { code: "unavailable" } });
  });

  test("an event over the limit is not sent; the next one is", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const { sent } = await openSession(async () => ({ result: null }), events, db);
    emitBig(events, 0, RELAY_FRAME_BYTES);
    emitBig(events, 1, 5);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("1:xxxxx");
  });
});

describe("sendIds across a restart", () => {
  test("a delivered message is still known after the helper restarts; a failed one is not", async () => {
    const db = openDb(":memory:");
    const before = new SentMessages(undefined, undefined, undefined, db);
    await before.track("s1", "ok", Promise.resolve({ via: "iterm" }));
    await before.track("s1", "bad", Promise.reject(new Error("no"))).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    const after = new SentMessages(undefined, undefined, undefined, db);
    expect(await after.get("s1", "ok")).toEqual({ via: "iterm" });
    expect(after.get("s1", "bad")).toBeUndefined();
    expect(after.get("s2", "ok")).toBeUndefined();
  });

  test("remembered ids expire with the ttl", async () => {
    const db = openDb(":memory:");
    let now = 1_000;
    const a = new SentMessages(100, 10, () => now, db);
    await a.track("s1", "x", Promise.resolve({ via: "tmux" }));
    await new Promise((r) => setTimeout(r, 0));
    now += 101;
    expect(new SentMessages(100, 10, () => now, db).get("s1", "x")).toBeUndefined();
  });
});

describe("paging fields in the protocol", () => {
  test("are optional, so a result without them (an older helper's) still parses", () => {
    expect(SyncResult.parse({ events: [], latestSeq: 3 }).more).toBeUndefined();
    expect(SyncResult.parse({ events: [], latestSeq: 3, more: true }).more).toBe(true);
    expect(TurnFullResult.parse({ text: "a" })).toEqual({ text: "a" });
    expect(TurnFullResult.parse({ text: "a", more: true, nextOffset: 1 }).nextOffset).toBe(1);
    expect(RpcSchemas["turn.full"].parse({ turnId: "t" }).offset).toBe(0);
  });
});

describe("turn-full.json fixture", () => {
  const fx = JSON.parse(
    readFileSync(join(import.meta.dir, "../../protocol/fixtures/turn-full.json"), "utf8"),
  );
  test("params carry an offset, and the first request defaults to 0", () => {
    expect(RpcSchemas["turn.full"].parse(fx.params).offset).toBe(1000);
    expect(RpcSchemas["turn.full"].parse(fx.paramsFirst).offset).toBe(0);
  });
  test("a middle piece has more and nextOffset, the last has neither", () => {
    const middle = TurnFullResult.parse(fx.middle);
    expect(middle.more).toBe(true);
    expect(middle.nextOffset).toBe(1000);
    const last = TurnFullResult.parse(fx.last);
    expect(last.more).toBeUndefined();
    expect(last.nextOffset).toBeUndefined();
  });
});

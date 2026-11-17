import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_FRAME_BYTES, SyncResult, TurnFullResult } from "../../protocol/index.ts";
import { createPairingCode, redeemPairingCode } from "../src/daemon/auth.ts";
import { ClientSession } from "../src/daemon/clientSession.ts";
import { openDb } from "../src/daemon/db.ts";
import {
  b64url,
  E2EError,
  loadOrCreateIdentity,
  MacChannel,
  PhoneChannel,
  PIECE,
  PIECE_BYTES,
  PieceReader,
  sealPieces,
} from "../src/daemon/e2e.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

/** Messages over one relay frame travel as piece frames, for a phone that announced it in hello. */

function pair() {
  const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "pieces-")), "identity.json"));
  const mac = new MacChannel(identity);
  const phone = new PhoneChannel(identity.boxPublic);
  const { reply } = mac.receive(phone.hello());
  if (!reply) throw new Error("no handshake reply");
  phone.receiveHandshake(reply);
  return { mac, phone };
}

const big = (n: number) => `${"héllo 📱 ".repeat(Math.ceil(n / 12))}end`;

describe("piece frames", () => {
  test("a message of several MB arrives whole, in frames the relay accepts", () => {
    const { mac, phone } = pair();
    const text = big(5_000_000);
    const frames = mac.sealMessage(text, true);
    expect(frames.length).toBeGreaterThan(30);
    for (const f of frames) expect(f.length + 4).toBeLessThanOrEqual(RELAY_FRAME_BYTES);
    const out = frames.map((f) => phone.openMessage(f)).filter((t) => t !== null);
    expect(out).toEqual([text]);
  });

  test("a small message is one piece, and frames of both kinds share one counter", () => {
    const { mac, phone } = pair();
    const old = mac.sealMessage("one", false);
    const piece = mac.sealMessage("two", true);
    const oldAgain = mac.sealMessage("three", false);
    expect([old.length, piece.length, oldAgain.length]).toEqual([1, 1, 1]);
    expect(piece[0]?.[0]).toBe(PIECE);
    expect([old, piece, oldAgain].map(([f]) => phone.openMessage(f as Uint8Array))).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("an empty message and one exactly a piece long come through", () => {
    const { mac, phone } = pair();
    for (const text of ["", "a".repeat(PIECE_BYTES), "a".repeat(PIECE_BYTES + 1)]) {
      const out = mac.sealMessage(text, true).map((f) => phone.openMessage(f));
      expect(out.at(-1)).toBe(text);
    }
  });

  test("a lost middle piece drops that message, not the next, and counts the frames lost", () => {
    const { mac, phone } = pair();
    const first = mac.sealMessage("a".repeat(PIECE_BYTES * 3), true);
    const second = mac.sealMessage("after", true);
    const seen = [first[0], first[2], ...second].map((f) => phone.openMessage(f as Uint8Array));
    expect(seen).toEqual([null, null, "after"]);
    expect(phone.takeLost()).toBe(1);
    expect(phone.takeLost()).toBe(0);
  });

  test("a lost last piece does not glue the next message onto the broken one", () => {
    const { mac, phone } = pair();
    const first = mac.sealMessage("a".repeat(PIECE_BYTES * 2), true);
    const second = mac.sealMessage("next", true);
    const seen = [first[0], ...second].map((f) => phone.openMessage(f as Uint8Array));
    expect(seen).toEqual([null, "next"]);
    expect(phone.takeLost()).toBe(1);
  });

  test("a piece that continues a message the phone never saw the start of is dropped", () => {
    const { mac, phone } = pair();
    const first = mac.sealMessage("a".repeat(PIECE_BYTES * 3), true);
    const seen = first.slice(1).map((f) => phone.openMessage(f));
    expect(seen).toEqual([null, null]);
    expect(phone.takeLost()).toBe(1);
  });

  test("a replayed or tampered piece is refused", () => {
    const { mac, phone } = pair();
    const [a, b] = mac.sealMessage("x".repeat(PIECE_BYTES + 5), true) as [Uint8Array, Uint8Array];
    phone.openMessage(a);
    expect(() => phone.openMessage(a)).toThrow(E2EError);
    const flipped = new Uint8Array(b);
    flipped[12] = (flipped[12] ?? 0) ^ 1;
    expect(() => phone.openMessage(flipped)).toThrow(E2EError);
    // The counter is in the frame header: changing it fails authentication too.
    const moved = new Uint8Array(b);
    moved[8] = (moved[8] ?? 0) + 1;
    expect(() => phone.openMessage(moved)).toThrow(E2EError);
  });

  test("a message past the size limit ends the channel", () => {
    const { mac, phone } = pair();
    const frames = mac.sealMessage("a".repeat(70 * 1024 * 1024), true);
    expect(() => frames.map((f) => phone.openMessage(f))).toThrow(E2EError);
  });

  test("the fixture's frames reassemble to its text", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "../../protocol/fixtures/e2e.json"), "utf8"),
    ) as {
      pieces: { firstCounter: number; text: string; frames: string[] };
      macToPhoneKey: string;
    };
    const key = new Uint8Array(Buffer.from(fixture.macToPhoneKey, "base64url"));
    const reader = new PieceReader(key);
    let next = BigInt(fixture.pieces.firstCounter);
    const out: (string | null)[] = [];
    for (const f of fixture.pieces.frames) {
      const got = reader.read(new Uint8Array(Buffer.from(f, "base64url")), next);
      out.push(got.text);
      next = got.next;
    }
    expect(out).toEqual([null, null, fixture.pieces.text]);
    expect(sealPieces(key, 2n, new TextEncoder().encode(fixture.pieces.text), 12).map(b64url)).toEqual(
      fixture.pieces.frames,
    );
  });
});

describe("a session with a phone that announced pieces", () => {
  function setup() {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const rpc = createRpc({
      db,
      events,
      registry,
      broker: { hasOpen: () => false, listOpen: () => [], listRecent: () => [] },
      config: {},
      presence: { get: () => ({ mode: "away" }) },
    } as unknown as RpcDeps);
    return { db, events, rpc };
  }

  async function open(announce: boolean) {
    const { db, events, rpc } = setup();
    const sent: { text: string; pieces: boolean }[] = [];
    const session = new ClientSession(
      (text, pieces) => sent.push({ text, pieces }),
      { rpc, events, db },
      () => {},
    );
    const paired = redeemPairingCode(db, createPairingCode(db).code, "P");
    const token = paired?.token ?? "";
    await session.handle(
      JSON.stringify({ id: 2, method: "hello", params: announce ? { token, pieces: true } : { token } }),
    );
    sent.length = 0;
    return { session, sent, db, events };
  }

  const emitBig = (events: EventLog, chars: number) =>
    // biome-ignore lint/suspicious/noExplicitAny: a test event of any size
    events.emit({ type: "session.removed", sessionId: "x".repeat(chars) } as any);

  test("an event of several MB is sent whole, as pieces", async () => {
    const { sent, events } = await open(true);
    emitBig(events, 3_000_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.pieces).toBe(true);
    expect(sent[0]?.text.length).toBeGreaterThan(3_000_000);
  });

  test("a phone that did not announce it still has its big event left out, in one frame", async () => {
    const { sent, events } = await open(false);
    emitBig(events, 3_000_000);
    expect(sent).toEqual([]);
    emitBig(events, 10);
    expect(sent.map((s) => s.pieces)).toEqual([false]);
  });

  test("a reply of several MB is sent whole; the old phone gets an error instead", async () => {
    for (const announce of [true, false]) {
      const { session, sent, db } = await open(announce);
      db.query(
        "INSERT INTO turns (id, session_id, prompt, full_text, summary, started_at, ended_at) VALUES ('t', 's', 'p', ?, 's', 1, 2)",
      ).run("z".repeat(3_000_000));
      await session.handle(JSON.stringify({ id: 3, method: "turn.full", params: { turnId: "t" } }));
      const reply = JSON.parse(sent.at(-1)?.text ?? "{}") as { result?: unknown };
      if (announce) expect(TurnFullResult.parse(reply.result).text).toHaveLength(3_000_000);
      else expect(TurnFullResult.parse(reply.result).more).toBe(true);
    }
  });

  test("a phone that takes pieces still gets sync pages of one reply's size", async () => {
    const { session, sent, events } = await open(true);
    for (let i = 0; i < 6; i++) emitBig(events, 90_000);
    await session.handle(JSON.stringify({ id: 4, method: "sync", params: { sinceSeq: 1 } }));
    const page = SyncResult.parse(JSON.parse(sent.at(-1)?.text ?? "{}").result);
    expect(page.events.length).toBeLessThan(6);
    expect(page.more).toBe(true);
  });

  test("sync sends an event over the page size alone instead of leaving it out", async () => {
    const { session, sent, events } = await open(true);
    emitBig(events, 10);
    emitBig(events, 5_000_000);
    emitBig(events, 10);
    await session.handle(JSON.stringify({ id: 4, method: "sync", params: { sinceSeq: 1 } }));
    const first = SyncResult.parse(JSON.parse(sent.at(-1)?.text ?? "{}").result);
    expect(first.events.map((e) => e.seq)).toEqual([2]);
    expect(first.more).toBe(true);
    await session.handle(JSON.stringify({ id: 5, method: "sync", params: { sinceSeq: first.latestSeq } }));
    const second = SyncResult.parse(JSON.parse(sent.at(-1)?.text ?? "{}").result);
    expect(second.events.map((e) => e.seq)).toEqual([3]);
    expect(second.more).toBeUndefined();
  });
});

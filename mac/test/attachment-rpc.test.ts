import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_BYTES,
  type AttachmentData,
  AttachmentRef,
  AttachmentUpload,
  RpcSchemas,
} from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { AttachmentStore, UPLOADS_PER_SESSION_MAX, words } from "../src/daemon/attachments.ts";
import { Broker } from "../src/daemon/broker.ts";
import { type DB, openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";

/**
 * The attachment calls as a phone makes them, through `createRpc` with a real attachment store and sessions started
 * by hooks: sizes at the edges of a chunk, damaged chunks, a file name that is a shell command, an upload that is
 * discarded or ended twice, uploads that interleave, a helper that restarts mid-upload, an older phone that doesn't
 * know the newer fields, and what the audit table keeps.
 */
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const sv of servers.splice(0)) sv.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLiveSteps();
});

const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const SID = "edge-session-1";

type Outcome<T> = { result?: T; error?: { code: string; message: string } };

function setup(
  opts: { attachments?: boolean; thumbnailer?: (src: string, out: string) => Promise<boolean> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "relay-att-rpc-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const dbPath = join(dir, "relay.db");
  const db: DB = openDb(dbPath);
  // The session's inbox: what a message sent to it is delivered to.
  const inbox = join(dir, "inbox.sock");
  const delivered: string[] = [];
  const server = createServer((c) => {
    let data = "";
    c.on("data", (d) => {
      data += d.toString();
    });
    c.on("end", () => {
      for (const line of data.trim().split("\n")) {
        const msg = JSON.parse(line);
        if (msg.type === "user") delivered.push(msg.message.content as string);
      }
    });
  });
  server.listen(inbox);
  servers.push(server);
  const attDir = join(dir, "attachments");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker: Broker = new Broker(db, events, () => {});
  const config = { previewChars: 600, preferTyping: false } as RelayConfig;
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = {
    noteLocalActivity: () => {},
    get: () => ({ mode: "auto", present: true, idleSeconds: 0, locked: false }),
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const makeStore = () =>
    opts.attachments === false
      ? undefined
      : new AttachmentStore(db, attDir, opts.thumbnailer ? { thumbnailer: opts.thumbnailer } : {});
  let attachments = makeStore();
  const makeRpc = () =>
    createRpc({ db, events, registry, broker, presence, config, steps, attachments } as unknown as RpcDeps);
  let rpc = makeRpc();
  const call = async <T>(method: string, params: object, actor = "device:d1"): Promise<Outcome<T>> =>
    (await rpc(method, params, actor)) as Outcome<T>;
  const hook = (event: string, sessionId: string) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: sessionId, cwd: dir, transcript_path: transcript },
        env: { socket: inbox, token: "tok" },
      } as HookEnvelope,
      new AbortController().signal,
    );
  const begin = (bytes: Uint8Array, p: Record<string, unknown> = {}) =>
    call<AttachmentUpload>("attachment.begin", {
      sessionId: SID,
      name: "photo.jpg",
      mime: "image/jpeg",
      size: bytes.length,
      sha256: sha(bytes),
      ...p,
    });
  const chunk = (id: string, index: number, data: string) =>
    call<{ received: number }>("attachment.chunk", { id, index, data });
  const slice = (bytes: Uint8Array, up: AttachmentUpload, i: number) =>
    b64(bytes.subarray(i * up.chunkSize, (i + 1) * up.chunkSize));
  /** begin, every chunk, end. */
  const put = async (bytes: Uint8Array, p: Record<string, unknown> = {}) => {
    const up = (await begin(bytes, p)).result as AttachmentUpload;
    for (let i = 0; i < up.chunks; i++) await chunk(up.id, i, slice(bytes, up, i));
    return { up, end: await call<AttachmentRef>("attachment.end", { id: up.id }) };
  };
  /** A helper that was restarted: the same database and folder, a store with no memory of the uploads. */
  const restart = () => {
    attachments = makeStore();
    rpc = makeRpc();
  };
  const audit = () =>
    (db.query("SELECT actor, action, detail FROM audit").all() as object[])
      .map((r) => JSON.stringify(r))
      .join("\n");
  return { dir, attDir, db: () => db, delivered, call, hook, begin, chunk, slice, put, restart, audit };
}

async function started(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.hook("SessionStart", SID);
  return s;
}

describe("sizes at the edges of a chunk", () => {
  test("0, 1, one chunk, one chunk and a byte, and two full chunks save and come back byte for byte", async () => {
    const s = await started();
    const C = ATTACHMENT_CHUNK_BYTES;
    for (const [size, chunks] of [
      [0, 0],
      [1, 1],
      [C - 1, 1],
      [C, 1],
      [C + 1, 2],
      [2 * C, 2],
      [2 * C + 1, 3],
    ] as const) {
      const bytes = randomBytes(size);
      const { up, end } = await s.put(bytes, { name: `f${size}.bin` });
      expect(up.chunks).toBe(chunks);
      expect(end.error).toBeUndefined();
      const ref = end.result as AttachmentRef;
      expect(ref.size).toBe(size);
      expect(readFileSync(ref.path).equals(bytes)).toBe(true);
      // Fetched back chunk by chunk (an empty file still has one, empty, chunk to fetch).
      const parts: Buffer[] = [];
      for (let i = 0; i < Math.max(1, chunks); i++) {
        const got = await s.call<AttachmentData>("attachment.get", { id: ref.id, index: i });
        expect(got.error).toBeUndefined();
        parts.push(Buffer.from((got.result as AttachmentData).data, "base64"));
      }
      expect(Buffer.concat(parts).equals(bytes)).toBe(true);
    }
  });

  test("a file of exactly 50 MB is accepted at begin and one byte more is refused before a chunk is sent", async () => {
    const s = await started();
    const ok = await s.begin(new Uint8Array(0), { size: ATTACHMENT_MAX_BYTES, sha256: "0".repeat(64) });
    expect(ok.result?.chunks).toBe(400);
    const big = await s.begin(new Uint8Array(0), {
      name: "big.mov",
      size: ATTACHMENT_MAX_BYTES + 1,
      sha256: "0".repeat(64),
    });
    expect(big.error).toEqual({ code: "bad_request", message: words.tooLarge("big.mov") });
  });

  test("an index one past the last chunk is damaged, in an empty file too, and the last chunk must be the short one", async () => {
    const s = await started();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 5);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    const damaged = { code: "bad_request", message: words.damaged("photo.jpg") };
    expect((await s.chunk(up.id, 2, b64(randomBytes(1)))).error).toEqual(damaged);
    // The last chunk sent with a full chunk's bytes, the first one cut short, and an empty string.
    expect((await s.chunk(up.id, 1, b64(randomBytes(ATTACHMENT_CHUNK_BYTES)))).error).toEqual(damaged);
    expect((await s.chunk(up.id, 0, b64(randomBytes(ATTACHMENT_CHUNK_BYTES - 1)))).error).toEqual(damaged);
    expect((await s.chunk(up.id, 0, "")).error).toEqual(damaged);
    const empty = (await s.begin(new Uint8Array(0), { name: "e.txt" })).result as AttachmentUpload;
    expect((await s.chunk(empty.id, 0, "")).error).toEqual({
      code: "bad_request",
      message: words.damaged("e.txt"),
    });
    // None of that counted as received.
    expect((await s.chunk(up.id, 1, s.slice(bytes, up, 1))).result?.received).toBe(1);
  });

  test("base64 with a line break, spaces, the URL alphabet or stray padding is damaged and writes nothing", async () => {
    const s = await started();
    const bytes = new Uint8Array(12).map((_, i) => [0xfb, 0xff, 0xbf][i % 3] as number);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    const good = b64(bytes);
    for (const bad of [
      `${good.slice(0, 8)}\n${good.slice(8)}`,
      ` ${good}`,
      `${good} `,
      good.replace(/\+|\//g, "-"),
      `${good}===`,
      `${"AAAA".repeat(2)}*`,
    ]) {
      const out = await s.chunk(up.id, 0, bad);
      expect(out.error?.message).toBe(words.damaged("photo.jpg"));
    }
    expect((await s.call("attachment.end", { id: up.id })).error?.message).toBe(words.missing("photo.jpg"));
    expect((await s.chunk(up.id, 0, good)).result?.received).toBe(1);
    expect((await s.call("attachment.end", { id: up.id })).error).toBeUndefined();
  });

  test("a hash in capitals is accepted and the file is kept under the same hash", async () => {
    const s = await started();
    const bytes = randomBytes(40);
    const { end } = await s.put(bytes, { sha256: sha(bytes).toUpperCase() });
    expect(end.error).toBeUndefined();
    const got = await s.call<AttachmentData>("attachment.get", { id: (end.result as AttachmentRef).id });
    expect(got.result?.sha256).toBe(sha(bytes));
  });

  test("a hash that is not 64 hex digits, a size with a fraction or below zero, and a missing field are refused by the schema", async () => {
    const s = await started();
    const bytes = randomBytes(4);
    for (const p of [
      { sha256: "abc" },
      { sha256: "g".repeat(64) },
      { sha256: `${sha(bytes)}0` },
      { size: 1.5 },
      { size: -1 },
      { size: "4" },
      { size: null },
      { name: 5 },
      { name: "a".repeat(1001) },
      { sessionId: undefined },
    ]) {
      const out = await s.begin(bytes, p);
      expect(out.error?.code).toBe("bad_request");
      expect(out.result).toBeUndefined();
    }
    // Nothing was started by any of them.
    expect(s.db().query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  });

  test("a chunk index that is negative, a fraction or text is refused by the schema", async () => {
    const s = await started();
    const up = (await s.begin(new Uint8Array(3))).result as AttachmentUpload;
    for (const index of [-1, 0.5, "0", null]) {
      expect((await s.call("attachment.chunk", { id: up.id, index, data: "AAAA" })).error?.code).toBe(
        "bad_request",
      );
    }
    expect((await s.call("attachment.chunk", { id: up.id, index: 0 })).error?.code).toBe("bad_request");
  });
});

describe("file names", () => {
  test("200 bytes in any script pass and 201 don't, counted after the name is put in NFC", async () => {
    const s = await started();
    const bytes = new Uint8Array(1);
    // 100 two-byte letters is 200 bytes; typed as e + combining acute (3 bytes each) they are still 200 as NFC.
    for (const name of [
      "é".repeat(100),
      "é".repeat(100),
      "я".repeat(100),
      `${"a".repeat(196)}.txt`,
      "📸".repeat(50),
    ]) {
      expect((await s.begin(bytes, { name })).error).toBeUndefined();
    }
    const tooLong = { code: "bad_request", message: words.longName };
    for (const name of [
      `${"é".repeat(100)}a`,
      "я".repeat(101),
      `${"a".repeat(197)}.txt`,
      `${"📸".repeat(50)}a`,
      "👨‍👩‍👧".repeat(12),
    ]) {
      expect((await s.begin(bytes, { name })).error).toEqual(tooLong);
    }
  });

  test("names made of every kind of invisible or reordering mark are refused, right-to-left letters are not", async () => {
    const s = await started();
    const bytes = new Uint8Array(1);
    const refused = { code: "bad_request", message: words.badName };
    for (const name of [
      "a\u007fb",
      "a\u0085b",
      "a‎b",
      "a‏b",
      "a؜b",
      "a‪b",
      "a‮b",
      "a⁦b",
      "a⁩b",
      "a b",
      "a b",
      "a\u0000b",
      "a\rb",
      "...",
      "a/",
      "/a",
      "a\\",
      "x/../y",
    ]) {
      expect((await s.begin(bytes, { name })).error).toEqual(refused);
    }
    for (const name of ["דוח שנתי.pdf", "تقرير.pdf", ".hidden", "-rf", "a.b.c", " x "]) {
      expect((await s.begin(bytes, { name })).error).toBeUndefined();
    }
    // A name of only spaces, tabs or non-breaking spaces is empty once trimmed.
    for (const name of ["", " ", " ", "　　"]) {
      expect((await s.begin(bytes, { name })).error).toEqual(refused);
    }
  });

  test("a name that looks like a shell command or markup is saved as plain characters inside the session's folder", async () => {
    const s = await started();
    const names = [
      "$(touch pwned).txt",
      "`id`.png",
      "a;b|c&d.txt",
      "<script>alert(1)<script>.html",
      'q"; rm -rf ~ #.txt',
      "-- --help.txt",
      "~root.txt",
      "*.txt",
      "{a,b}.txt",
      "a​b.txt",
      "100% off!.txt",
    ];
    for (const name of names) {
      const { end } = await s.put(randomBytes(3), { name });
      expect(end.error).toBeUndefined();
      const ref = end.result as AttachmentRef;
      expect(ref.name).toBe(name.normalize("NFC").trim());
      const saved = ref.path.slice(join(s.attDir, SID).length + 1);
      // One path segment, in the session's folder, made only of letters, digits and . _ -.
      expect(ref.path.startsWith(`${join(s.attDir, SID)}/`)).toBe(true);
      expect(saved).toMatch(/^[\p{L}\p{N}\p{M}._-]+$/u);
      expect(existsSync(ref.path)).toBe(true);
    }
  });

  test("a session id that isn't a safe folder name gets a folder of its own inside the attachments folder", async () => {
    const s = setup();
    const odd = "../../escape /id";
    await s.hook("SessionStart", odd);
    const { end } = await s.put(randomBytes(3), { sessionId: odd });
    expect(end.error).toBeUndefined();
    const ref = end.result as AttachmentRef;
    expect(ref.path.startsWith(`${s.attDir}/`)).toBe(true);
    expect(ref.path.slice(s.attDir.length + 1).split("/").length).toBe(2);
    expect(ref.path).not.toContain("..");
    expect(ref.path).not.toContain(" ");
  });

  test("a mime type that is not type/subtype is stored as application/octet-stream and can't reach a thumbnail", async () => {
    let thumbnails = 0;
    const s = await started({
      thumbnailer: async () => {
        thumbnails++;
        return false;
      },
    });
    for (const mime of ["image", "image/", "/png", "image/p ng", "x".repeat(255)]) {
      const { end } = await s.put(randomBytes(3), { mime });
      const ref = end.result as AttachmentRef;
      expect(ref.mime).toBe("application/octet-stream");
      const t = await s.call("attachment.get", { id: ref.id, thumbnail: true });
      expect(t.error?.message).toBe(words.noPreview);
    }
    expect(thumbnails).toBe(0);
    expect((await s.begin(new Uint8Array(1), { mime: "x".repeat(256) })).error?.code).toBe("bad_request");
  });
});

describe("sending", () => {
  test("ten different ids and a repeat of one of them are ten files, eleven different ones are refused", async () => {
    const s = await started();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++)
      ids.push(((await s.put(randomBytes(4), { name: `n${i}.png` })).end.result as AttachmentRef).id);
    const refused = { code: "bad_request", message: words.tooMany };
    expect((await s.call("session.send", { sessionId: SID, text: "", attachments: ids })).error).toEqual(
      refused,
    );
    const ten = ids.slice(0, 10);
    const out = await s.call("session.send", { sessionId: SID, text: "", attachments: [...ten, ten[0]] });
    expect(out.error).toBeUndefined();
  });

  test("an empty list with no text, a blank id, a list over 100 and an id that isn't text are refused with a sentence or the schema", async () => {
    const s = await started();
    expect((await s.call("session.send", { sessionId: SID, text: "", attachments: [] })).error).toEqual({
      code: "bad_request",
      message: words.empty,
    });
    expect((await s.call("session.send", { sessionId: SID, text: "", attachments: [""] })).error).toEqual({
      code: "not_found",
      message: words.unknown,
    });
    expect(
      (await s.call("session.send", { sessionId: SID, attachments: new Array(101).fill("a") })).error?.code,
    ).toBe("bad_request");
    expect((await s.call("session.send", { sessionId: SID, attachments: [1] })).error?.code).toBe(
      "bad_request",
    );
    expect((await s.call("session.send", { sessionId: SID, attachments: "abc" })).error?.code).toBe(
      "bad_request",
    );
  });

  test("a file removed from the disk behind the helper's back is refused at send and at get, and the other files still go", async () => {
    const s = await started();
    const a = (await s.put(randomBytes(4), { name: "a.png" })).end.result as AttachmentRef;
    const b = (await s.put(randomBytes(4), { name: "b.png" })).end.result as AttachmentRef;
    rmSync(a.path);
    expect(
      (await s.call("session.send", { sessionId: SID, text: "", attachments: [a.id, b.id] })).error,
    ).toEqual({
      code: "not_found",
      message: words.unknown,
    });
    expect((await s.call("attachment.get", { id: a.id })).error).toEqual({
      code: "not_found",
      message: words.gone,
    });
    expect(
      (await s.call("session.send", { sessionId: SID, text: "", attachments: [b.id] })).error,
    ).toBeUndefined();
  });

  test("a session that ended refuses its own earlier attachments, and begin; sending the same file to another session is refused", async () => {
    const s = await started();
    await s.hook("SessionStart", "edge-session-2");
    const a = (await s.put(randomBytes(4))).end.result as AttachmentRef;
    expect(
      (await s.call("session.send", { sessionId: "edge-session-2", text: "x", attachments: [a.id] })).error,
    ).toEqual({
      code: "not_found",
      message: words.unknown,
    });
    await s.hook("SessionEnd", SID);
    const ended = { code: "not_found", message: words.sessionGone };
    expect((await s.call("session.send", { sessionId: SID, text: "", attachments: [a.id] })).error).toEqual(
      ended,
    );
    expect((await s.begin(new Uint8Array(1))).error).toEqual(ended);
    expect((await s.begin(new Uint8Array(1), { sessionId: "never-existed" })).error).toEqual(ended);
  });
});

describe("state", () => {
  test("end twice, and discard twice, give the same answers; the saved file stays until it is discarded", async () => {
    const s = await started();
    const bytes = randomBytes(30);
    const { up, end } = await s.put(bytes);
    const ref = end.result as AttachmentRef;
    expect((await s.call("attachment.end", { id: up.id })).result).toEqual(ref);
    expect((await s.call("attachment.end", { id: up.id })).result).toEqual(ref);
    expect(existsSync(ref.path)).toBe(true);
    expect((await s.call("attachment.discard", { id: up.id })).result).toEqual({
      id: up.id,
      discarded: true,
    });
    expect((await s.call("attachment.discard", { id: up.id })).result).toEqual({
      id: up.id,
      discarded: false,
    });
    expect(existsSync(ref.path)).toBe(false);
    // After the discard: ending it again says it's gone, a late chunk changes nothing, and it can't be fetched or sent.
    expect((await s.call("attachment.end", { id: up.id })).error).toEqual({
      code: "not_found",
      message: words.gone,
    });
    expect((await s.chunk(up.id, 0, b64(bytes))).error).toBeUndefined();
    expect(existsSync(ref.path)).toBe(false);
    expect((await s.call("attachment.get", { id: up.id })).error?.message).toBe(words.gone);
    expect(
      (await s.call("session.send", { sessionId: SID, text: "", attachments: [up.id] })).error?.message,
    ).toBe(words.unknown);
  });

  test("a discarded upload that is still going: later chunks and end hear it was cancelled, and the same file can be sent again", async () => {
    const s = await started();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 10);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    await s.chunk(up.id, 0, s.slice(bytes, up, 0));
    expect(
      (await s.call<{ discarded: boolean }>("attachment.discard", { id: up.id })).result?.discarded,
    ).toBe(true);
    const cancelled = { code: "not_found", message: words.expired };
    expect((await s.chunk(up.id, 1, s.slice(bytes, up, 1))).error).toEqual(cancelled);
    expect((await s.call("attachment.end", { id: up.id })).error).toEqual(cancelled);
    expect((await s.put(bytes)).end.error).toBeUndefined();
  });

  test("an id nobody knows is expired for chunk and end, nothing to discard, and gone for get", async () => {
    const s = await started();
    const expired = { code: "not_found", message: words.expired };
    expect((await s.chunk("nope", 0, "AAAA")).error).toEqual(expired);
    expect((await s.call("attachment.end", { id: "nope" })).error).toEqual(expired);
    expect((await s.call("attachment.discard", { id: "nope" })).result).toEqual({
      id: "nope",
      discarded: false,
    });
    expect((await s.call("attachment.get", { id: "nope" })).error).toEqual({
      code: "not_found",
      message: words.gone,
    });
    expect((await s.call("attachment.get", { id: "nope", thumbnail: true })).error?.message).toBe(words.gone);
  });

  test("get past the last chunk is refused, the last one is short, and a fetch of an unfinished upload is gone", async () => {
    const s = await started();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 7);
    const ref = (await s.put(bytes)).end.result as AttachmentRef;
    const last = await s.call<AttachmentData>("attachment.get", { id: ref.id, index: 1 });
    expect(Buffer.from((last.result as AttachmentData).data, "base64").length).toBe(7);
    expect(last.result?.chunks).toBe(2);
    expect((await s.call("attachment.get", { id: ref.id, index: 2 })).error?.code).toBe("bad_request");
    expect((await s.call("attachment.get", { id: ref.id, index: -1 })).error?.code).toBe("bad_request");
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    expect((await s.call("attachment.get", { id: up.id })).error).toEqual({
      code: "not_found",
      message: words.gone,
    });
  });

  test("after a restart a saved file is still there to fetch, send and end again, and a half-sent upload says what's missing", async () => {
    const s = await started();
    const done = await s.put(randomBytes(20), { name: "done.png" });
    const bytes = randomBytes(2 * ATTACHMENT_CHUNK_BYTES + 3);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    await s.chunk(up.id, 0, s.slice(bytes, up, 0));
    s.restart();
    const ref = done.end.result as AttachmentRef;
    expect((await s.call("attachment.end", { id: ref.id })).result).toEqual(ref);
    expect((await s.call("attachment.get", { id: ref.id })).error).toBeUndefined();
    expect(
      (await s.call("session.send", { sessionId: SID, text: "hi", attachments: [ref.id] })).error,
    ).toBeUndefined();
    // The first chunk is on disk, the rest never came: short, so the phone is told to send the rest.
    expect((await s.call("attachment.end", { id: up.id })).error).toEqual({
      code: "conflict",
      message: words.missing("photo.jpg"),
    });
    await s.chunk(up.id, 1, s.slice(bytes, up, 1));
    await s.chunk(up.id, 2, s.slice(bytes, up, 2));
    const saved = await s.call<AttachmentRef>("attachment.end", { id: up.id });
    expect(readFileSync((saved.result as AttachmentRef).path).equals(bytes)).toBe(true);
  });

  test("a failed end leaves the upload open: the wrong bytes can be replaced under the same id", async () => {
    const s = await started();
    const bytes = randomBytes(50);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    await s.chunk(up.id, 0, b64(randomBytes(50)));
    expect((await s.call("attachment.end", { id: up.id })).error).toEqual({
      code: "conflict",
      message: words.badHash("photo.jpg"),
    });
    await s.chunk(up.id, 0, b64(bytes));
    const end = await s.call<AttachmentRef>("attachment.end", { id: up.id });
    expect(readFileSync((end.result as AttachmentRef).path).equals(bytes)).toBe(true);
  });

  test("the unfinished-upload limit is per session and ending an upload gives its place back", async () => {
    const s = await started();
    await s.hook("SessionStart", "edge-session-2");
    const bytes = new Uint8Array(1);
    const open: string[] = [];
    for (let i = 0; i < UPLOADS_PER_SESSION_MAX; i++)
      open.push(((await s.begin(bytes)).result as AttachmentUpload).id);
    const busy = { code: "conflict", message: words.busy };
    expect((await s.begin(bytes)).error).toEqual(busy);
    expect((await s.begin(bytes, { sessionId: "edge-session-2" })).error).toBeUndefined();
    await s.chunk(open[0] as string, 0, b64(bytes));
    await s.call("attachment.end", { id: open[0] });
    expect((await s.begin(bytes)).error).toBeUndefined();
    expect((await s.begin(bytes)).error).toEqual(busy);
    await s.call("attachment.discard", { id: open[1] });
    expect((await s.begin(bytes)).error).toBeUndefined();
  });
});

describe("thumbnails", () => {
  test("a tool that fails, throws or makes a file over one chunk gives 'no preview' and doesn't break the file", async () => {
    for (const thumbnailer of [
      async () => false,
      async () => {
        throw new Error("boom");
      },
      async (_src: string, out: string) => {
        writeFileSync(out, randomBytes(ATTACHMENT_CHUNK_BYTES + 1));
        return true;
      },
      async () => true,
    ]) {
      const s = await started({ thumbnailer });
      const ref = (await s.put(randomBytes(9), { name: "p.png", mime: "image/png" })).end
        .result as AttachmentRef;
      expect((await s.call("attachment.get", { id: ref.id, thumbnail: true })).error).toEqual({
        code: "unavailable",
        message: words.noPreview,
      });
      expect((await s.call("attachment.get", { id: ref.id })).error).toBeUndefined();
    }
  });

  test("a thumbnail of a non-image is refused without running the tool, whatever the file is called", async () => {
    let ran = 0;
    const s = await started({
      thumbnailer: async () => {
        ran++;
        return true;
      },
    });
    const ref = (await s.put(randomBytes(9), { name: "photo.jpg", mime: "application/pdf" })).end
      .result as AttachmentRef;
    expect((await s.call("attachment.get", { id: ref.id, thumbnail: true })).error?.message).toBe(
      words.noPreview,
    );
    expect(ran).toBe(0);
  });

  test("a thumbnail is a JPEG file with 0600 in a folder only the user can open, and goes with the file when it is discarded", async () => {
    const s = await started({
      thumbnailer: async (_src, out) => {
        writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return true;
      },
    });
    const ref = (await s.put(randomBytes(9), { name: "p.png", mime: "image/png" })).end
      .result as AttachmentRef;
    const t = await s.call<AttachmentData>("attachment.get", { id: ref.id, thumbnail: true });
    expect(t.result?.thumbnail).toBe(true);
    expect(t.result?.mime).toBe("image/jpeg");
    const thumb = join(s.attDir, ".thumbs", `${ref.id}.jpg`);
    expect(statSync(thumb).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.attDir, ".thumbs")).mode & 0o077).toBe(0);
    await s.call("attachment.discard", { id: ref.id });
    expect(existsSync(thumb)).toBe(false);
    expect((await s.call("attachment.get", { id: ref.id, thumbnail: true })).error?.message).toBe(words.gone);
  });
});

describe("two phones at once", () => {
  test("interleaved uploads of files with the same name keep their own bytes and their own paths", async () => {
    const s = await started();
    const A = randomBytes(2 * ATTACHMENT_CHUNK_BYTES + 11);
    const B = randomBytes(2 * ATTACHMENT_CHUNK_BYTES + 11);
    const [ua, ub] = await Promise.all([s.begin(A), s.begin(B)]);
    const a = ua.result as AttachmentUpload;
    const b = ub.result as AttachmentUpload;
    expect(a.id).not.toBe(b.id);
    const sends: Promise<unknown>[] = [];
    for (const i of [2, 1, 0]) {
      sends.push(s.chunk(b.id, i, s.slice(B, b, i)), s.chunk(a.id, i, s.slice(A, a, i)));
    }
    await Promise.all(sends);
    const [ea, eb] = await Promise.all([
      s.call<AttachmentRef>("attachment.end", { id: a.id }),
      s.call<AttachmentRef>("attachment.end", { id: b.id }),
    ]);
    const ra = ea.result as AttachmentRef;
    const rb = eb.result as AttachmentRef;
    expect(ra.path).not.toBe(rb.path);
    expect(readFileSync(ra.path).equals(A)).toBe(true);
    expect(readFileSync(rb.path).equals(B)).toBe(true);
  });

  test("the same chunk from two phones at once, and end from both, is one file and the same answer", async () => {
    const s = await started();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 1);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    const acks = await Promise.all(
      [0, 0, 1, 1].map((i) =>
        s.call<{ received: number }>(
          "attachment.chunk",
          { id: up.id, index: i, data: s.slice(bytes, up, i) },
          `device:d${i}`,
        ),
      ),
    );
    expect(acks.every((a) => a.error === undefined)).toBe(true);
    const ends = await Promise.all([
      s.call<AttachmentRef>("attachment.end", { id: up.id }, "device:d1"),
      s.call<AttachmentRef>("attachment.end", { id: up.id }, "device:d2"),
    ]);
    expect(ends[0]?.error).toBeUndefined();
    const first = ends[0]?.result as AttachmentRef;
    expect(ends[1]?.result).toEqual(ends[0]?.result as AttachmentRef);
    expect(readFileSync(first.path).equals(bytes)).toBe(true);
  });

  test("one phone discards while the other ends: either the file is saved and then discarded, or the upload is cancelled, never half", async () => {
    const s = await started();
    const bytes = randomBytes(64);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    await s.chunk(up.id, 0, b64(bytes));
    const [end, discard] = await Promise.all([
      s.call<AttachmentRef>("attachment.end", { id: up.id }, "device:d1"),
      s.call<{ discarded: boolean }>("attachment.discard", { id: up.id }, "device:d2"),
    ]);
    expect(discard.error).toBeUndefined();
    expect(discard.result?.discarded).toBe(true);
    const ref = end.result;
    expect(ref === undefined ? end.error?.message : "").toBe(ref === undefined ? words.expired : "");
    const left = [...new Bun.Glob("**/*").scanSync({ cwd: s.attDir, dot: true })].filter((f) =>
      statSync(join(s.attDir, f)).isFile(),
    );
    expect(left).toEqual([]);
  });

  test("a message that is being sent while its file is discarded either goes with the file or is refused whole", async () => {
    const s = await started();
    const a = (await s.put(randomBytes(8), { name: "a.png" })).end.result as AttachmentRef;
    const [send, discard] = await Promise.all([
      s.call("session.send", { sessionId: SID, text: "look", attachments: [a.id] }),
      s.call("attachment.discard", { id: a.id }),
    ]);
    expect(discard.error).toBeUndefined();
    if (send.error) expect(send.error.message).toBe(words.unknown);
  });
});

describe("older and newer phones", () => {
  test("a phone that sends only text, or fields the helper doesn't know, still works", async () => {
    const s = await started();
    expect(
      (await s.call("session.send", { sessionId: SID, text: "hello", futureField: { a: 1 } })).error,
    ).toBeUndefined();
    const bytes = randomBytes(5);
    const up = await s.begin(bytes, { futureField: true, compression: "gzip" });
    expect(up.error).toBeUndefined();
    const u = up.result as AttachmentUpload;
    expect(
      (await s.call("attachment.chunk", { id: u.id, index: 0, data: b64(bytes), crc: 1 })).error,
    ).toBeUndefined();
    const end = await s.call<AttachmentRef>("attachment.end", { id: u.id, extra: 1 });
    // get with no index and no thumbnail flag is the first chunk of the file.
    const got = await s.call<AttachmentData>("attachment.get", {
      id: (end.result as AttachmentRef).id,
      extra: [],
    });
    expect(got.result?.index).toBe(0);
    expect(got.result?.thumbnail).toBeUndefined();
    expect(Buffer.from((got.result as AttachmentData).data, "base64").equals(bytes)).toBe(true);
  });

  test("a begin without a mime type is a file of unknown type, and refs and results parse with the protocol's own schemas", async () => {
    const s = await started();
    const bytes = randomBytes(5);
    const { up, end } = await s.put(bytes, { mime: undefined, name: "notes" });
    expect(AttachmentUpload.safeParse(up).success).toBe(true);
    const ref = AttachmentRef.parse(end.result);
    expect(ref.mime).toBe("application/octet-stream");
    expect(ref.removed).toBeUndefined();
    await s.call("attachment.discard", { id: ref.id });
    // The row stays after a discard: a prompt that still holds the path lists a removed chip.
    const row = s.db().query("SELECT removed_at FROM attachments WHERE id = ?").get(ref.id) as {
      removed_at: number | null;
    };
    expect(row.removed_at).not.toBeNull();
    expect(RpcSchemas["session.send"].safeParse({ sessionId: SID }).data?.text).toBe("");
    expect(RpcSchemas["attachment.get"].safeParse({ id: "x" }).data).toEqual({
      id: "x",
      index: 0,
      thumbnail: false,
    });
  });

  test("a helper with no attachment store answers every attachment call, and a send with files, with the same plain sentence", async () => {
    const s = await started({ attachments: false });
    const unavailable = { code: "unavailable", message: "Files can't be sent to this computer." };
    expect((await s.begin(new Uint8Array(1))).error).toEqual(unavailable);
    expect((await s.chunk("x", 0, "AAAA")).error).toEqual(unavailable);
    expect((await s.call("attachment.end", { id: "x" })).error).toEqual(unavailable);
    expect((await s.call("attachment.discard", { id: "x" })).error).toEqual(unavailable);
    expect((await s.call("attachment.get", { id: "x" })).error).toEqual(unavailable);
    expect((await s.call("session.send", { sessionId: SID, text: "", attachments: ["x"] })).error).toEqual(
      unavailable,
    );
    // Plain messages are not affected.
    expect((await s.call("session.send", { sessionId: SID, text: "hi" })).error).toBeUndefined();
  });
});

describe("what is kept about a file", () => {
  test("the audit table has the session, upload id and size, but never a file's name, hash or the message text", async () => {
    const s = await started();
    const bytes = randomBytes(33);
    const name = "salary-negotiation-2026.pdf";
    const { up, end } = await s.put(bytes, { name });
    const ref = end.result as AttachmentRef;
    await s.call("session.send", {
      sessionId: SID,
      text: "my password is hunter2 <b>now</b>",
      attachments: [ref.id],
    });
    await s.call("attachment.discard", { id: up.id });
    const log = s.audit();
    expect(log).toContain("attachment.begin");
    expect(log).toContain("attachment.discard");
    expect(log).toContain(up.id);
    expect(log).not.toContain("salary");
    expect(log).not.toContain(sha(bytes));
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain(ref.path);
  });

  test("a refused upload leaves no row, no partial file and no audit entry", async () => {
    const s = await started();
    await s.begin(new Uint8Array(1), { name: "../x" });
    await s.begin(new Uint8Array(1), { name: "big", size: ATTACHMENT_MAX_BYTES + 1 });
    await s.begin(new Uint8Array(1), { sessionId: "nobody" });
    expect(s.db().query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(s.audit()).not.toContain("attachment.begin");
    expect(
      existsSync(join(s.attDir, ".partial"))
        ? Bun.spawnSync(["ls", join(s.attDir, ".partial")]).stdout.toString()
        : "",
    ).toBe("");
  });

  test("an upload in progress is private to the user: the partial file is 0600 and the folders 0700", async () => {
    const s = await started();
    const bytes = randomBytes(10);
    const up = (await s.begin(bytes)).result as AttachmentUpload;
    expect(statSync(join(s.attDir, ".partial", up.id)).mode & 0o777).toBe(0o600);
    expect(statSync(s.attDir).mode & 0o077).toBe(0);
    expect(statSync(join(s.attDir, ".partial")).mode & 0o077).toBe(0);
  });
});

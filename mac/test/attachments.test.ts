import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_KEEP_MS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_UPLOAD_TTL_MS,
  AttachmentChunkAck,
  AttachmentData,
  AttachmentDiscarded,
  AttachmentRef,
  AttachmentUpload,
  RelayEvent,
  RpcSchemas,
  Turn,
} from "../../protocol/index.ts";
import {
  AttachmentError,
  AttachmentStore,
  attachmentsInPrompt,
  checkMime,
  checkName,
  composeMessage,
  REMOVED_ROW_KEEP_MS,
  systemThumbnailer,
  UPLOADS_PER_SESSION_MAX,
  words,
} from "../src/daemon/attachments.ts";
import { type DB, openDb } from "../src/daemon/db.ts";

/**
 * Attachments sent from a phone, in the helper's store, without a daemon. Uploads in chunks (repeated, out of order,
 * after a restart), the checks on size, hash and name, the text typed into the session, the cleanup on a fake
 * clock, and fetching a file and a thumbnail back.
 */
const ROOT = join(process.env.RELAY_TEST_ROOT ?? "/tmp", `relay-att-${process.pid}`);
const SID = "4375b77a-1111-2222-3333-444455556666";
let db: DB;
let dir: string;
let clock = 1_800_000_000_000;
let n = 0;
const now = () => clock;
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function store(opts: ConstructorParameters<typeof AttachmentStore>[2] = {}) {
  return new AttachmentStore(db, dir, { now, ...opts });
}

/** Uploads `bytes` in order, each chunk once; returns the upload id. */
function upload(s: AttachmentStore, bytes: Uint8Array, name = "photo.jpg", sessionId = SID) {
  const up = s.begin({ sessionId, name, mime: "image/jpeg", size: bytes.length, sha256: sha(bytes) });
  for (let i = 0; i < up.chunks; i++)
    s.chunk({ id: up.id, index: i, data: b64(bytes.subarray(i * up.chunkSize, (i + 1) * up.chunkSize)) });
  return up;
}

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof AttachmentError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("not refused");
}

beforeEach(() => {
  const home = join(ROOT, String(n++));
  mkdirSync(home, { recursive: true });
  db = openDb(join(home, "relay.db"));
  dir = join(home, "attachments");
  clock = 1_800_000_000_000;
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("names, types and the typed text", () => {
  test("a path-traversal, slashed, control or bidi name is refused with a plain sentence", () => {
    for (const bad of [
      "../../.ssh/authorized_keys",
      "..",
      ".",
      "a/b.jpg",
      "a\\b.jpg",
      "x..y",
      "bad\u0000.jpg",
      "line\nbreak.txt",
      "tab\tname.txt",
      "evil‮gpj.exe",
      "iso⁦late.png",
      "mark‏.png",
      "sep .png",
      "",
      "   ",
    ]) {
      expect(() => checkName(bad)).toThrow(words.badName);
    }
    expect(() => checkName(`${"é".repeat(101)}.txt`)).toThrow(words.longName);
  });

  test("ordinary names pass, trimmed and NFC; the saved name has no spaces, quotes or brackets", () => {
    expect(checkName("IMG_1234.HEIC")).toEqual({ name: "IMG_1234.HEIC", saved: "IMG_1234.HEIC" });
    expect(checkName("  Cart totals (final).pdf ")).toEqual({
      name: "Cart totals (final).pdf",
      saved: "Cart_totals__final_.pdf",
    });
    expect(checkName("Café.txt").name).toBe("Café.txt");
    expect(checkName('say "hi".txt').saved).toBe("say__hi_.txt");
    expect(checkName("Photo 2026-11-10.jpg").saved).toBe("Photo_2026-11-10.jpg");
    expect(checkName("IMG_0676.HEIC").saved).toBe("IMG_0676.HEIC");
    expect(checkName("a [b] 'c' é.png").saved).toBe("a__b___c__é.png");
    expect(checkName("Photo 2026-11-10.jpg").name).toBe("Photo 2026-11-10.jpg");
    expect(checkName(".env").name).toBe(".env");
    expect(checkName("📸 Ура.jpg").name).toBe("📸 Ура.jpg");
  });

  test("a MIME type is kept when it looks like one", () => {
    expect(checkMime("image/HEIC")).toBe("image/heic");
    expect(checkMime("text/plain;charset=utf-8")).toBe("text/plain");
    expect(checkMime(undefined)).toBe("application/octet-stream");
    expect(checkMime("../../etc")).toBe("application/octet-stream");
    expect(checkMime("")).toBe("application/octet-stream");
  });

  const ref = (path: string) => ({ id: "x", name: "n", mime: "m", size: 1, path });
  test("the message, then each path on its own line, quoted when it has spaces", () => {
    expect(composeMessage("Why is this off?", [ref("/h/a.png"), ref("/h/b c.pdf")])).toBe(
      'Why is this off?\n/h/a.png\n"/h/b c.pdf"',
    );
    expect(composeMessage("", [ref("/h/a.png")])).toBe("/h/a.png");
    expect(composeMessage("  \n ", [ref("/h/a.png"), ref("/h/b.png")])).toBe("/h/a.png\n/h/b.png");
    // A message's own line breaks stay; trailing blank lines go.
    expect(composeMessage("one\ntwo\n\n", [ref("/h/a.png")])).toBe("one\ntwo\n/h/a.png");
  });
});

describe("uploading", () => {
  test("a file in chunks lands under <session>/ with 0600 in a 0700 folder, its hash checked", () => {
    const s = store();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES * 2 + 1234);
    const up = upload(s, bytes);
    expect(up.chunks).toBe(3);
    expect(AttachmentUpload.parse(up)).toEqual(up);
    const ref = AttachmentRef.parse(s.end({ id: up.id }));
    expect(ref).toEqual({
      id: up.id,
      name: "photo.jpg",
      mime: "image/jpeg",
      size: bytes.length,
      path: join(dir, SID, `${up.id.slice(0, 8)}-photo.jpg`),
    });
    expect(sha(readFileSync(ref.path))).toBe(sha(bytes));
    expect(statSync(ref.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, SID)).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Nothing left of the upload.
    expect(readdirSync(join(dir, ".partial"))).toEqual([]);
  });

  test("repeated and out-of-order chunks, a retried end, and a chunk after the end don't corrupt it", () => {
    const s = store();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES * 3);
    const up = s.begin({ sessionId: SID, name: "a.bin", size: bytes.length, sha256: sha(bytes) });
    const part = (i: number) =>
      b64(bytes.subarray(i * ATTACHMENT_CHUNK_BYTES, (i + 1) * ATTACHMENT_CHUNK_BYTES));
    expect(s.chunk({ id: up.id, index: 2, data: part(2) }).received).toBe(1);
    expect(s.chunk({ id: up.id, index: 0, data: part(0) }).received).toBe(2);
    expect(s.chunk({ id: up.id, index: 2, data: part(2) }).received).toBe(2);
    const ack = s.chunk({ id: up.id, index: 1, data: part(1) });
    expect(AttachmentChunkAck.parse(ack)).toEqual({ id: up.id, index: 1, received: 3 });
    s.chunk({ id: up.id, index: 0, data: part(0) });
    const first = s.end({ id: up.id });
    expect(s.end({ id: up.id })).toEqual(first);
    // A late retry of a chunk is acknowledged and changes nothing.
    expect(s.chunk({ id: up.id, index: 1, data: b64(randomBytes(ATTACHMENT_CHUNK_BYTES)) }).received).toBe(3);
    expect(sha(readFileSync(first.path))).toBe(sha(bytes));
    expect(s.forSend(SID, [up.id])).toEqual([first]);
  });

  test("a 50 MB file uploads in 400 chunks; 50 MB and 1 byte is refused before any of it is sent", () => {
    const s = store();
    const bytes = randomBytes(ATTACHMENT_MAX_BYTES);
    const up = upload(s, bytes, "video.mov");
    expect(up.chunks).toBe(400);
    const ref = s.end({ id: up.id });
    expect(statSync(ref.path).size).toBe(ATTACHMENT_MAX_BYTES);
    expect(sha(readFileSync(ref.path))).toBe(sha(bytes));
    expect(
      refusal(() =>
        s.begin({
          sessionId: SID,
          name: "video.mov",
          size: ATTACHMENT_MAX_BYTES + 1,
          sha256: "0".repeat(64),
        }),
      ),
    ).toEqual({ code: "bad_request", message: "video.mov is too large. Files can be up to 50 MB." });
  }, 30_000);

  test("a bad hash is refused and the upload can be sent again; a missing chunk is named as missing", () => {
    const s = store();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 10);
    const up = s.begin({ sessionId: SID, name: "x.png", size: bytes.length, sha256: sha(bytes) });
    const good = (i: number) =>
      b64(bytes.subarray(i * ATTACHMENT_CHUNK_BYTES, (i + 1) * ATTACHMENT_CHUNK_BYTES));
    s.chunk({ id: up.id, index: 0, data: good(0) });
    expect(refusal(() => s.end({ id: up.id }))).toEqual({
      code: "conflict",
      message: "Part of x.png didn't arrive. Send it again.",
    });
    s.chunk({ id: up.id, index: 1, data: b64(randomBytes(10)) });
    expect(refusal(() => s.end({ id: up.id }))).toEqual({
      code: "conflict",
      message: "x.png didn't arrive intact. Send it again.",
    });
    // Not saved, and not sendable.
    expect(existsSync(join(dir, SID))).toBe(false);
    expect(refusal(() => s.forSend(SID, [up.id])).message).toBe(words.notFinished("x.png"));
    // The phone sends the chunk again and it goes through.
    s.chunk({ id: up.id, index: 1, data: good(1) });
    expect(sha(readFileSync(s.end({ id: up.id }).path))).toBe(sha(bytes));
  });

  test("a damaged chunk (wrong length, not base64, past the end) is refused and writes nothing", () => {
    const s = store();
    const bytes = randomBytes(100);
    const up = s.begin({ sessionId: SID, name: "n.txt", size: 100, sha256: sha(bytes) });
    const damaged = { code: "bad_request", message: "Part of n.txt arrived damaged. Send it again." };
    expect(refusal(() => s.chunk({ id: up.id, index: 0, data: b64(randomBytes(99)) }))).toEqual(damaged);
    expect(refusal(() => s.chunk({ id: up.id, index: 0, data: "not base64!" }))).toEqual(damaged);
    expect(refusal(() => s.chunk({ id: up.id, index: 1, data: b64(bytes) }))).toEqual(damaged);
    expect(statSync(join(dir, ".partial", up.id)).size).toBe(0);
    s.chunk({ id: up.id, index: 0, data: b64(bytes) });
    expect(s.end({ id: up.id }).size).toBe(100);
  });

  test("an empty file has no chunks and still saves", () => {
    const s = store();
    const up = s.begin({ sessionId: SID, name: "empty.txt", size: 0, sha256: sha(new Uint8Array()) });
    expect(up.chunks).toBe(0);
    expect(statSync(s.end({ id: up.id }).path).size).toBe(0);
  });

  test("an unknown upload is refused as expired", () => {
    const s = store();
    expect(refusal(() => s.chunk({ id: "nope", index: 0, data: "" }))).toEqual({
      code: "not_found",
      message: words.expired,
    });
    expect(refusal(() => s.end({ id: "nope" })).message).toBe(words.expired);
  });

  test("after a helper restart the upload finishes on its size and hash", () => {
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 5);
    const first = store();
    const up = first.begin({ sessionId: SID, name: "r.bin", size: bytes.length, sha256: sha(bytes) });
    first.chunk({ id: up.id, index: 0, data: b64(bytes.subarray(0, ATTACHMENT_CHUNK_BYTES)) });
    const second = store();
    second.chunk({ id: up.id, index: 1, data: b64(bytes.subarray(ATTACHMENT_CHUNK_BYTES)) });
    expect(sha(readFileSync(second.end({ id: up.id }).path))).toBe(sha(bytes));
  });

  test("two photo.jpg files don't clash; too many open uploads in one session are refused", () => {
    const s = store();
    const a = s.end({ id: upload(s, randomBytes(10)).id });
    const b = s.end({ id: upload(s, randomBytes(10)).id });
    expect(a.path).not.toBe(b.path);
    expect(a.name).toBe(b.name);
    for (let i = 0; i < 20; i++) s.begin({ sessionId: "busy", name: "f", size: 1, sha256: "0".repeat(64) });
    expect(refusal(() => s.begin({ sessionId: "busy", name: "f", size: 1, sha256: "0".repeat(64) }))).toEqual(
      {
        code: "conflict",
        message: words.busy,
      },
    );
  });
});

describe("sending", () => {
  test("up to 10 attachments, in the order given, repeats once; an 11th is refused", () => {
    const s = store();
    const ids = Array.from(
      { length: 11 },
      (_, i) => s.end({ id: upload(s, randomBytes(8), `f${i}.txt`).id }).id,
    );
    expect(s.forSend(SID, ids.slice(0, 10)).map((r) => r.id)).toEqual(ids.slice(0, 10));
    expect(s.forSend(SID, [ids[1] as string, ids[0] as string, ids[1] as string]).map((r) => r.name)).toEqual(
      ["f1.txt", "f0.txt"],
    );
    expect(refusal(() => s.forSend(SID, ids))).toEqual({
      code: "bad_request",
      message: "You can attach up to 10 files to one message.",
    });
  });

  test("another session's attachment, or an unknown one, is refused", () => {
    const s = store();
    const other = s.end({ id: upload(s, randomBytes(8), "o.txt", "other-session").id });
    expect(refusal(() => s.forSend(SID, [other.id]))).toEqual({ code: "not_found", message: words.unknown });
    expect(refusal(() => s.forSend(SID, ["missing"]))).toEqual({ code: "not_found", message: words.unknown });
  });

  test("a prompt's attachments are found by their paths, in the order they appear", () => {
    const s = store();
    const a = s.end({ id: upload(s, randomBytes(8), "a.png").id });
    const b = s.end({ id: upload(s, randomBytes(8), "b c.pdf").id });
    const prompt = `📱 From the user, sent from their phone via Relay:\n${composeMessage("Look", [b, a])}`;
    expect(attachmentsInPrompt(db, SID, prompt)).toEqual([b, a]);
    expect(attachmentsInPrompt(db, SID, "no files here")).toBeUndefined();
    expect(attachmentsInPrompt(db, "other", prompt)).toBeUndefined();
    expect(attachmentsInPrompt(db, SID, null)).toBeUndefined();
  });
});

describe("discarding an attachment removed before Send", () => {
  test("a saved one is deleted with its thumbnail; its row stays, marked removed, and it can't be sent", async () => {
    const s = store({
      thumbnailer: async (_src, out) => {
        writeFileSync(out, "jpeg");
        return true;
      },
    });
    const ref = s.end({ id: upload(s, randomBytes(300), "picked.png").id });
    await s.get({ id: ref.id, index: 0, thumbnail: true });
    const thumb = join(dir, ".thumbs", `${ref.id}.jpg`);
    expect(existsSync(thumb)).toBe(true);
    expect(s.discard({ id: ref.id })).toEqual({ id: ref.id, discarded: true });
    expect(existsSync(ref.path)).toBe(false);
    expect(existsSync(thumb)).toBe(false);
    expect(refusal(() => s.forSend(SID, [ref.id])).message).toBe(words.unknown);
    expect(refusal(() => s.end({ id: ref.id })).message).toBe(words.gone);
    expect(attachmentsInPrompt(db, SID, ref.path)).toEqual([{ ...ref, removed: true }]);
    // Again: nothing left to do, and not an error.
    expect(s.discard({ id: ref.id })).toEqual({ id: ref.id, discarded: false });
    // The row goes with the others after 90 days, and the empty folder at the next sweep.
    s.sweep();
    expect(existsSync(join(dir, SID))).toBe(false);
  });

  test("an unfinished one stops: its partial file and row go, and later chunks hear it was cancelled", () => {
    const s = store();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 10);
    const up = s.begin({ sessionId: SID, name: "big.bin", size: bytes.length, sha256: sha(bytes) });
    s.chunk({ id: up.id, index: 0, data: b64(bytes.subarray(0, ATTACHMENT_CHUNK_BYTES)) });
    const partial = join(dir, ".partial", up.id);
    expect(existsSync(partial)).toBe(true);
    expect(s.discard({ id: up.id })).toEqual({ id: up.id, discarded: true });
    expect(existsSync(partial)).toBe(false);
    expect(db.query("SELECT 1 FROM attachments WHERE id = ?").get(up.id)).toBeNull();
    expect(
      refusal(() => s.chunk({ id: up.id, index: 1, data: b64(bytes.subarray(ATTACHMENT_CHUNK_BYTES)) }))
        .message,
    ).toBe(words.expired);
    expect(refusal(() => s.end({ id: up.id })).message).toBe(words.expired);
  });

  test("discarded uploads don't count toward the unfinished ones a session may have", () => {
    const s = store();
    const begin = () => s.begin({ sessionId: SID, name: "f.bin", size: 10, sha256: "0".repeat(64) });
    const ids = Array.from({ length: UPLOADS_PER_SESSION_MAX }, () => begin().id);
    expect(refusal(begin).message).toBe(words.busy);
    s.discard({ id: ids[0] as string });
    expect(begin().chunks).toBe(1);
  });

  test("an unknown id is nothing to discard, and other attachments are left alone", () => {
    const s = store();
    const kept = s.end({ id: upload(s, randomBytes(50), "kept.png").id });
    expect(s.discard({ id: "0000000000000000" })).toEqual({ id: "0000000000000000", discarded: false });
    expect(existsSync(kept.path)).toBe(true);
    expect(s.forSend(SID, [kept.id])).toEqual([kept]);
  });
});

describe("cleanup on a fake clock", () => {
  test("an unfinished upload is removed after an hour, not before", () => {
    const s = store();
    const up = s.begin({ sessionId: SID, name: "slow.bin", size: 10, sha256: "0".repeat(64) });
    const partial = join(dir, ".partial", up.id);
    clock += ATTACHMENT_UPLOAD_TTL_MS - 1;
    expect(s.sweep()).toEqual({ uploads: 0, files: 0 });
    expect(existsSync(partial)).toBe(true);
    clock += 2;
    expect(s.sweep().uploads).toBe(1);
    expect(existsSync(partial)).toBe(false);
    expect(refusal(() => s.chunk({ id: up.id, index: 0, data: b64(randomBytes(10)) })).message).toBe(
      words.expired,
    );
  });

  test("a saved attachment is removed after 7 days; the prompt still lists it as removed", () => {
    const s = store();
    const ref = s.end({ id: upload(s, randomBytes(64), "old.png").id });
    clock += ATTACHMENT_KEEP_MS - 1;
    s.sweep();
    expect(existsSync(ref.path)).toBe(true);
    clock += 2;
    expect(s.sweep().files).toBe(1);
    expect(existsSync(ref.path)).toBe(false);
    // The empty session folder goes too.
    expect(existsSync(join(dir, SID))).toBe(false);
    expect(attachmentsInPrompt(db, SID, ref.path)).toEqual([{ ...ref, removed: true }]);
    expect(refusal(() => s.forSend(SID, [ref.id])).message).toBe(words.unknown);
    expect(refusal(() => s.end({ id: ref.id })).message).toBe(words.gone);
    // Its row goes after 90 days.
    clock += REMOVED_ROW_KEEP_MS + 1;
    s.sweep();
    expect(attachmentsInPrompt(db, SID, ref.path)).toBeUndefined();
  });

  test("files nobody tracks are removed once they are as old", () => {
    const s = store();
    s.sweep(); // creates nothing, and doesn't fail without the folder
    mkdirSync(join(dir, ".partial"), { recursive: true });
    mkdirSync(join(dir, "lost-session"), { recursive: true });
    const partial = join(dir, ".partial", "deadbeefdeadbeef");
    const saved = join(dir, "lost-session", "deadbeef-x.txt");
    writeFileSync(partial, "x");
    writeFileSync(saved, "x");
    const at = (ms: number) => utimesSync(partial, ms / 1000, ms / 1000);
    at(clock - ATTACHMENT_UPLOAD_TTL_MS + 60_000);
    utimesSync(
      saved,
      (clock - ATTACHMENT_KEEP_MS + 60_000) / 1000,
      (clock - ATTACHMENT_KEEP_MS + 60_000) / 1000,
    );
    expect(s.sweep()).toEqual({ uploads: 0, files: 0 });
    clock += 120_000;
    expect(s.sweep()).toEqual({ uploads: 1, files: 1 });
    expect(existsSync(partial) || existsSync(saved) || existsSync(join(dir, "lost-session"))).toBe(false);
  });
});

describe("fetching back", () => {
  test("a file comes back in chunks that add up to it", async () => {
    const s = store();
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 77);
    const ref = s.end({ id: upload(s, bytes, "doc.pdf").id });
    const first = AttachmentData.parse(await s.get({ id: ref.id, index: 0, thumbnail: false }));
    expect(first.chunks).toBe(2);
    expect(first.sha256).toBe(sha(bytes));
    const second = await s.get({ id: ref.id, index: 1, thumbnail: false });
    const whole = Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]);
    expect(sha(whole)).toBe(sha(bytes));
    await expect(s.get({ id: ref.id, index: 2, thumbnail: false })).rejects.toThrow("There's no such part");
    await expect(s.get({ id: "nope", index: 0, thumbnail: false })).rejects.toThrow(words.gone);
  });

  test("a thumbnail of an image in one chunk, made once; none for a file that isn't an image", async () => {
    let made = 0;
    const s = store({
      thumbnailer: async (_src, out) => {
        made++;
        writeFileSync(out, "jpeg bytes");
        return true;
      },
    });
    const img = s.end({ id: upload(s, randomBytes(500), "pic.heic").id });
    const t = AttachmentData.parse(await s.get({ id: img.id, index: 0, thumbnail: true }));
    expect(t).toMatchObject({ mime: "image/jpeg", chunks: 1, thumbnail: true, size: 10, name: "pic.heic" });
    expect(Buffer.from(t.data, "base64").toString()).toBe("jpeg bytes");
    await s.get({ id: img.id, index: 0, thumbnail: true });
    expect(made).toBe(1);
    const up = s.begin({
      sessionId: SID,
      name: "a.txt",
      mime: "text/plain",
      size: 1,
      sha256: sha(Buffer.from("a")),
    });
    s.chunk({ id: up.id, index: 0, data: b64(Buffer.from("a")) });
    s.end({ id: up.id });
    await expect(s.get({ id: up.id, index: 0, thumbnail: true })).rejects.toThrow(words.noPreview);
    // An image the tool can't read.
    const broken = store({ thumbnailer: async () => false });
    const png = broken.end({ id: upload(broken, randomBytes(9), "b.png").id });
    await expect(broken.get({ id: png.id, index: 0, thumbnail: true })).rejects.toThrow(words.noPreview);
  });

  test.if(process.platform === "darwin")("sips makes a real thumbnail of a PNG", async () => {
    // A 1x1 red PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    const s = store({ thumbnailer: systemThumbnailer });
    const up = s.begin({
      sessionId: SID,
      name: "red.png",
      mime: "image/png",
      size: png.length,
      sha256: sha(png),
    });
    s.chunk({ id: up.id, index: 0, data: b64(png) });
    const ref = s.end({ id: up.id });
    const t = await s.get({ id: ref.id, index: 0, thumbnail: true });
    const jpeg = Buffer.from(t.data, "base64");
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(statSync(join(dir, ".thumbs", `${ref.id}.jpg`)).mode & 0o777).toBe(0o600);
  });
});

test("the fixture matches the schemas, and older turns and events still parse without attachments", () => {
  const f = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../protocol/fixtures/attachments.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  expect(f.limits).toEqual({
    attachmentsMax: 10,
    maxBytes: ATTACHMENT_MAX_BYTES,
    chunkBytes: ATTACHMENT_CHUNK_BYTES,
  });
  RpcSchemas["attachment.begin"].parse(f.begin?.params);
  AttachmentUpload.parse(f.begin?.result);
  RpcSchemas["attachment.chunk"].parse(f.chunk?.params);
  AttachmentRef.parse(f.end?.result);
  const discard = f.discard as Record<string, unknown>;
  RpcSchemas["attachment.discard"].parse(discard.params);
  expect(AttachmentDiscarded.parse(discard.result).discarded).toBe(true);
  expect(AttachmentDiscarded.parse(discard.resultNothing).discarded).toBe(false);
  const send = RpcSchemas["session.send"].parse(f.send?.paramsNoText);
  expect(send.text).toBe("");
  AttachmentData.parse(f.get?.result);
  AttachmentData.parse(f.get?.thumbnail);
  const events = z.array(RelayEvent).parse(f.events);
  const turn = Turn.parse(f.turn);
  expect(turn.attachments?.map((a) => a.name)).toEqual(["IMG_1234.HEIC", "Cart totals.pdf"]);
  expect(events[0]).toMatchObject({ type: "turn.started", attachments: turn.attachments });
  // The typed text is what composeMessage writes for those attachments.
  expect(composeMessage("Why is the total off here?", turn.attachments ?? [])).toBe(String(f.send?.typed));
  // An old app's session.send still parses and has no attachments.
  expect(RpcSchemas["session.send"].parse({ sessionId: "s", text: "hi" })).toEqual({
    sessionId: "s",
    text: "hi",
  });
});

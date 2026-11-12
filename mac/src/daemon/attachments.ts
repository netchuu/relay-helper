import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_KEEP_MS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_UPLOAD_TTL_MS,
  ATTACHMENTS_MAX,
  type AttachmentChunkAck,
  type AttachmentData,
  type AttachmentDiscarded,
  type AttachmentRef,
  type AttachmentUpload,
  type RpcError,
} from "../../../protocol/index.ts";
import { errMessage, log } from "../log.ts";
import type { DB } from "./db.ts";

/**
 * Photos and files sent from a phone. The phone uploads each one in chunks
 * (`attachment.begin` → `attachment.chunk`… → `attachment.end`), the helper saves it under
 * `<dir>/<session>/<id8>-<name>` (0600, folders 0700), and `session.send` types its path into the session after
 * the message. Unfinished uploads go after an hour, saved files after 7 days.
 */

/** A refusal with a plain sentence the phone can show. */
export class AttachmentError extends Error {
  constructor(
    readonly code: RpcError["code"],
    message: string,
  ) {
    super(message);
  }
}

/** The words the phones show (the same on both, since the helper writes them). */
export const words = {
  tooMany: `You can attach up to ${ATTACHMENTS_MAX} files to one message.`,
  tooLarge: (name: string) => `${name} is too large. Files can be up to 50 MB.`,
  badName: "This file's name can't be used. Rename the file and try again.",
  longName: "This file's name is too long. Rename the file and try again.",
  sessionGone: "This session has ended, so files can't be sent to it.",
  expired: "This upload took too long and was cancelled. Send the file again.",
  damaged: (name: string) => `Part of ${name} arrived damaged. Send it again.`,
  missing: (name: string) => `Part of ${name} didn't arrive. Send it again.`,
  badHash: (name: string) => `${name} didn't arrive intact. Send it again.`,
  busy: "Too many files are uploading at once. Wait for them to finish and try again.",
  notFinished: (name: string) => `${name} hasn't finished uploading.`,
  unknown: "One of the files is no longer on the computer. Attach it again.",
  gone: "This file is no longer on the computer.",
  noPreview: "There's no preview for this file.",
  empty: "Type a message or attach a file.",
} as const;

/** At most this many unfinished uploads per session (a phone that retried `attachment.begin` a few times). */
export const UPLOADS_PER_SESSION_MAX = 2 * ATTACHMENTS_MAX;
/** Rows of removed attachments are kept this long, so older prompts still show a chip. */
export const REMOVED_ROW_KEEP_MS = 90 * 86_400_000;
/** At most this many UTF-8 bytes in a file name (the file system allows 255, the id prefix takes 9). */
export const NAME_MAX_BYTES = 200;
/** Thumbnails fit in a box this many pixels wide and high. */
export const THUMBNAIL_PIXELS = 320;

const PARTIAL_DIR = ".partial";
const THUMBS_DIR = ".thumbs";

/** Makes a small JPEG of an image; false when it can't (not an image, no tool for it). */
export type Thumbnailer = (src: string, out: string) => Promise<boolean>;

interface Row {
  id: string;
  session_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string | null;
  created_at: number;
  finished_at: number | null;
  removed_at: number | null;
}

/**
 * The name the file is saved under after its id prefix, or an error. Refused: empty, a slash or backslash, "..",
 * control, line separator and bidi characters, more than NAME_MAX_BYTES. The saved name has only letters, digits,
 * ".", "_" and "-": every other character (a space, a quote, a bracket) becomes "_", so the path typed into the
 * session needs no quotes. Claude Code turns a bare path into "[Image #N]" but not a quoted one with spaces.
 */
export function checkName(raw: string): { name: string; saved: string } {
  const name = raw.normalize("NFC").trim();
  if (!name || name === "." || name.includes("..") || /[/\\]/.test(name)) throw badRequest(words.badName);
  // Control characters, line and paragraph separators, and the bidi marks, embeddings, overrides and isolates
  // that can make a name read differently from what it is.
  if (/[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]/u.test(name)) throw badRequest(words.badName);
  if (Buffer.byteLength(name, "utf8") > NAME_MAX_BYTES) throw badRequest(words.longName);
  return { name, saved: name.replace(/[^\p{L}\p{N}\p{M}._-]/gu, "_") };
}

/** "image/jpeg" as given, lowercased; anything that isn't type/subtype is "application/octet-stream". */
export function checkMime(raw: string | undefined): string {
  const mime = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

/** A path as it is typed after the message: quoted when it has spaces (the saved names have none; the folder may). */
export function typedPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** The text typed into the session: the message (if any), then each path on its own line. */
export function composeMessage(text: string, refs: AttachmentRef[]): string {
  const lines = text.trim() ? [text.replace(/\s+$/, "")] : [];
  for (const ref of refs) lines.push(typedPath(ref.path));
  return lines.join("\n");
}

function chunkCount(size: number): number {
  return Math.ceil(size / ATTACHMENT_CHUNK_BYTES);
}

function badRequest(message: string): AttachmentError {
  return new AttachmentError("bad_request", message);
}

function toRef(r: Row): AttachmentRef {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    path: r.path ?? "",
    ...(r.removed_at !== null ? { removed: true } : {}),
  };
}

/** A session id as a folder name: as it is when it is safe (Claude Code's are UUIDs), else hex of it. */
function sessionFolder(sessionId: string): string {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(sessionId) && !sessionId.includes("..")
    ? sessionId
    : Buffer.from(sessionId).toString("hex").slice(0, 128);
}

function tryUnlink(path: string | null): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function sha256File(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hasher.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hasher.digest("hex");
}

/** sips on macOS, ImageMagick elsewhere when installed. */
export const systemThumbnailer: Thumbnailer = async (src, out) => {
  const box = String(THUMBNAIL_PIXELS);
  const commands =
    process.platform === "darwin"
      ? [["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", box, src, "--out", out]]
      : [
          [
            "magick",
            `${src}[0]`,
            "-auto-orient",
            "-thumbnail",
            `${box}x${box}`,
            "-quality",
            "70",
            `jpg:${out}`,
          ],
          [
            "convert",
            `${src}[0]`,
            "-auto-orient",
            "-thumbnail",
            `${box}x${box}`,
            "-quality",
            "70",
            `jpg:${out}`,
          ],
        ];
  for (const cmd of commands) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), 15_000);
      const code = await proc.exited;
      clearTimeout(timer);
      if (code === 0 && existsSync(out) && statSync(out).size > 0) return true;
    } catch {
      // not installed; try the next one
    }
  }
  return false;
};

export class AttachmentStore {
  /**
   * Which chunks of each unfinished upload arrived. `complete` when this helper saw the upload from its begin; after
   * a restart it didn't, and `end` relies on the size and the hash alone.
   */
  private readonly received = new Map<string, { chunks: Set<number>; complete: boolean }>();
  private readonly now: () => number;
  private readonly thumbnailer: Thumbnailer;

  constructor(
    private readonly db: DB,
    readonly dir: string,
    opts: { now?: () => number; thumbnailer?: Thumbnailer } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.thumbnailer = opts.thumbnailer ?? systemThumbnailer;
  }

  private get partialDir(): string {
    return join(this.dir, PARTIAL_DIR);
  }

  private partialPath(id: string): string {
    return join(this.partialDir, id);
  }

  private thumbPath(id: string): string {
    return join(this.dir, THUMBS_DIR, `${id}.jpg`);
  }

  private row(id: string): Row | null {
    return this.db.query("SELECT * FROM attachments WHERE id = ?").get(id) as Row | null;
  }

  /** Starts an upload. The caller has checked the session is open. */
  begin(p: {
    sessionId: string;
    name: string;
    mime?: string;
    size: number;
    sha256: string;
  }): AttachmentUpload {
    const { name } = checkName(p.name);
    if (p.size > ATTACHMENT_MAX_BYTES) throw badRequest(words.tooLarge(name));
    const open = this.db
      .query("SELECT COUNT(*) AS n FROM attachments WHERE session_id = ? AND finished_at IS NULL")
      .get(p.sessionId) as { n: number };
    if (open.n >= UPLOADS_PER_SESSION_MAX) throw new AttachmentError("conflict", words.busy);
    const id = randomBytes(8).toString("hex");
    ensureDir(this.dir);
    ensureDir(this.partialDir);
    writeFileSync(this.partialPath(id), new Uint8Array(0), { mode: 0o600 });
    this.db
      .query(
        "INSERT INTO attachments (id, session_id, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, p.sessionId, name, checkMime(p.mime), p.size, p.sha256.toLowerCase(), this.now());
    this.received.set(id, { chunks: new Set(), complete: true });
    return { id, chunkSize: ATTACHMENT_CHUNK_BYTES, chunks: chunkCount(p.size) };
  }

  /** Writes one chunk at its place in the file; the same chunk again writes the same bytes. */
  chunk(p: { id: string; index: number; data: string }): AttachmentChunkAck {
    const r = this.row(p.id);
    if (!r) throw new AttachmentError("not_found", words.expired);
    const chunks = chunkCount(r.size);
    // A retried chunk after the upload finished: nothing left to write.
    if (r.finished_at !== null) return { id: r.id, index: p.index, received: chunks };
    const expected = Math.min(ATTACHMENT_CHUNK_BYTES, r.size - p.index * ATTACHMENT_CHUNK_BYTES);
    if (p.index >= chunks || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) throw badRequest(words.damaged(r.name));
    const bytes = Buffer.from(p.data, "base64");
    if (bytes.length !== expected) throw badRequest(words.damaged(r.name));
    const path = this.partialPath(r.id);
    if (!existsSync(path)) throw new AttachmentError("not_found", words.expired);
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, bytes, 0, bytes.length, p.index * ATTACHMENT_CHUNK_BYTES);
    } finally {
      closeSync(fd);
    }
    let got = this.received.get(r.id);
    if (!got) {
      got = { chunks: new Set(), complete: false };
      this.received.set(r.id, got);
    }
    got.chunks.add(p.index);
    return { id: r.id, index: p.index, received: got.chunks.size };
  }

  /** Checks the size and hash and saves the file. Again after it succeeded: the same result. */
  end(p: { id: string }): AttachmentRef {
    const r = this.row(p.id);
    if (!r) throw new AttachmentError("not_found", words.expired);
    if (r.finished_at !== null) {
      if (r.removed_at !== null) throw new AttachmentError("not_found", words.gone);
      return toRef(r);
    }
    const partial = this.partialPath(r.id);
    if (!existsSync(partial)) throw new AttachmentError("not_found", words.expired);
    const got = this.received.get(r.id);
    const chunks = chunkCount(r.size);
    // Chunks missing for sure (this helper saw the whole upload), or the file is short of the size.
    if ((got?.complete && got.chunks.size < chunks) || statSync(partial).size !== r.size)
      throw new AttachmentError("conflict", words.missing(r.name));
    if (sha256File(partial) !== r.sha256) throw new AttachmentError("conflict", words.badHash(r.name));
    const folder = join(this.dir, sessionFolder(r.session_id));
    ensureDir(this.dir);
    ensureDir(folder);
    const { saved } = checkName(r.name);
    let path = join(folder, `${r.id.slice(0, 8)}-${saved}`);
    if (existsSync(path)) path = join(folder, `${r.id}-${saved}`);
    renameSync(partial, path);
    chmodSync(path, 0o600);
    this.db
      .query("UPDATE attachments SET path = ?, finished_at = ? WHERE id = ?")
      .run(path, this.now(), r.id);
    this.received.delete(r.id);
    return toRef({ ...r, path, finished_at: this.now() });
  }

  /**
   * An attachment the phone removed before sending it: an unfinished upload is dropped (its partial file and
   * row), a saved file and its thumbnail are deleted and the row marked removed, as `sweep` does after 7 days, so a
   * prompt that has its path still shows a chip. Unknown or already removed: nothing to do, not an error.
   */
  discard(p: { id: string }): AttachmentDiscarded {
    const r = this.row(p.id);
    if (!r || r.removed_at !== null) return { id: p.id, discarded: false };
    if (r.finished_at === null) {
      tryUnlink(this.partialPath(r.id));
      this.received.delete(r.id);
      this.db.query("DELETE FROM attachments WHERE id = ?").run(r.id);
    } else {
      tryUnlink(r.path);
      tryUnlink(this.thumbPath(r.id));
      this.db.query("UPDATE attachments SET removed_at = ? WHERE id = ?").run(this.now(), r.id);
    }
    return { id: r.id, discarded: true };
  }

  /**
   * The saved attachments for `session.send`, in the order given (repeats once). Refused: more than ATTACHMENTS_MAX,
   * one that isn't this session's, unfinished, or removed.
   */
  forSend(sessionId: string, ids: string[]): AttachmentRef[] {
    const unique = [...new Set(ids)];
    if (unique.length > ATTACHMENTS_MAX) throw badRequest(words.tooMany);
    return unique.map((id) => {
      const r = this.row(id);
      if (!r || r.session_id !== sessionId) throw new AttachmentError("not_found", words.unknown);
      if (r.finished_at === null) throw new AttachmentError("conflict", words.notFinished(r.name));
      if (r.removed_at !== null || !r.path || !existsSync(r.path))
        throw new AttachmentError("not_found", words.unknown);
      return toRef(r);
    });
  }

  /** A chunk of a saved attachment, or a thumbnail of an image. */
  async get(p: { id: string; index: number; thumbnail: boolean }): Promise<AttachmentData> {
    const r = this.row(p.id);
    if (!r || r.finished_at === null || r.removed_at !== null || !r.path || !existsSync(r.path))
      throw new AttachmentError("not_found", words.gone);
    if (p.thumbnail) {
      if (!r.mime.startsWith("image/")) throw new AttachmentError("unavailable", words.noPreview);
      const out = this.thumbPath(r.id);
      if (!existsSync(out)) {
        ensureDir(join(this.dir, THUMBS_DIR));
        const made = await this.thumbnailer(r.path, out).catch((err) => {
          log.warn("thumbnail failed", { err: errMessage(err) });
          return false;
        });
        if (!made || !existsSync(out)) throw new AttachmentError("unavailable", words.noPreview);
        chmodSync(out, 0o600);
      }
      const bytes = readFileSync(out);
      if (bytes.length > ATTACHMENT_CHUNK_BYTES) throw new AttachmentError("unavailable", words.noPreview);
      return {
        id: r.id,
        name: r.name,
        mime: "image/jpeg",
        size: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        chunkSize: ATTACHMENT_CHUNK_BYTES,
        chunks: 1,
        index: 0,
        data: bytes.toString("base64"),
        thumbnail: true,
      };
    }
    const chunks = Math.max(1, chunkCount(r.size));
    if (p.index >= chunks) throw badRequest("There's no such part of this file.");
    const fd = openSync(r.path, "r");
    let data: Buffer;
    try {
      const length = Math.max(
        0,
        Math.min(ATTACHMENT_CHUNK_BYTES, fstatSync(fd).size - p.index * ATTACHMENT_CHUNK_BYTES),
      );
      data = Buffer.alloc(length);
      if (length) readSync(fd, data, 0, length, p.index * ATTACHMENT_CHUNK_BYTES);
    } finally {
      closeSync(fd);
    }
    return {
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      sha256: r.sha256,
      chunkSize: ATTACHMENT_CHUNK_BYTES,
      chunks,
      index: p.index,
      data: data.toString("base64"),
    };
  }

  /**
   * Removes unfinished uploads older than an hour and saved attachments older than 7 days (their rows stay,
   * marked removed, for 90 days), and files nobody tracks that are as old.
   */
  sweep(): { uploads: number; files: number } {
    const now = this.now();
    let uploads = 0;
    let files = 0;
    const stale = this.db
      .query("SELECT id FROM attachments WHERE finished_at IS NULL AND created_at < ?")
      .all(now - ATTACHMENT_UPLOAD_TTL_MS) as { id: string }[];
    for (const { id } of stale) {
      tryUnlink(this.partialPath(id));
      this.received.delete(id);
      this.db.query("DELETE FROM attachments WHERE id = ?").run(id);
      uploads++;
    }
    const old = this.db
      .query(
        "SELECT id, path FROM attachments WHERE finished_at IS NOT NULL AND removed_at IS NULL AND finished_at < ?",
      )
      .all(now - ATTACHMENT_KEEP_MS) as { id: string; path: string | null }[];
    for (const { id, path } of old) {
      tryUnlink(path);
      tryUnlink(this.thumbPath(id));
      this.db.query("UPDATE attachments SET removed_at = ? WHERE id = ?").run(now, id);
      files++;
    }
    this.db
      .query("DELETE FROM attachments WHERE removed_at IS NOT NULL AND removed_at < ?")
      .run(now - REMOVED_ROW_KEEP_MS);
    const swept = this.sweepUntracked(now);
    return { uploads: uploads + swept.uploads, files: files + swept.files };
  }

  /** Files left behind by a lost database or a crash between the rename and the row update. */
  private sweepUntracked(now: number): { uploads: number; files: number } {
    let uploads = 0;
    let files = 0;
    if (!existsSync(this.dir)) return { uploads, files };
    const tracked = (path: string) =>
      this.db.query("SELECT 1 FROM attachments WHERE path = ? AND removed_at IS NULL").get(path) !== null;
    const isOpenUpload = (id: string) =>
      this.db.query("SELECT 1 FROM attachments WHERE id = ? AND finished_at IS NULL").get(id) !== null;
    const age = (path: string) => {
      try {
        return now - statSync(path).mtimeMs;
      } catch {
        return 0;
      }
    };
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(this.dir, entry.name);
      for (const file of readdirSync(folder)) {
        const path = join(folder, file);
        if (entry.name === PARTIAL_DIR) {
          if (!isOpenUpload(file) && age(path) > ATTACHMENT_UPLOAD_TTL_MS) {
            tryUnlink(path);
            uploads++;
          }
        } else if (entry.name === THUMBS_DIR) {
          const id = file.replace(/\.jpg$/, "");
          const live = this.db.query("SELECT 1 FROM attachments WHERE id = ? AND removed_at IS NULL").get(id);
          if (!live && age(path) > ATTACHMENT_UPLOAD_TTL_MS) tryUnlink(path);
        } else if (!tracked(path) && age(path) > ATTACHMENT_KEEP_MS) {
          tryUnlink(path);
          files++;
        }
      }
      if (entry.name !== PARTIAL_DIR && entry.name !== THUMBS_DIR) {
        try {
          if (readdirSync(folder).length === 0) rmdirSync(folder);
        } catch {
          // not empty or already gone
        }
      }
    }
    return { uploads, files };
  }
}

/**
 * The attachments whose paths are in a prompt, in the order they appear there; undefined when none. Reads the
 * database only, so turns recorded anywhere (hooks, the transcript, a stopped turn) can carry them.
 */
export function attachmentsInPrompt(
  db: DB,
  sessionId: string,
  prompt: string | null | undefined,
): AttachmentRef[] | undefined {
  if (!prompt?.includes("/attachments/")) return undefined;
  let rows: Row[];
  try {
    rows = db
      .query(
        "SELECT * FROM attachments WHERE session_id = ? AND path IS NOT NULL AND finished_at IS NOT NULL",
      )
      .all(sessionId) as Row[];
  } catch {
    return undefined; // a database from before attachments
  }
  const found = rows
    .map((r) => ({ r, at: prompt.indexOf(r.path as string) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => toRef(x.r));
  return found.length ? found : undefined;
}

/** `{attachments}` for a Turn or turn.started, or nothing. */
export function attachmentFields(
  db: DB,
  sessionId: string,
  prompt: string | null | undefined,
): { attachments?: AttachmentRef[] } {
  const attachments = attachmentsInPrompt(db, sessionId, prompt);
  return attachments ? { attachments } : {};
}

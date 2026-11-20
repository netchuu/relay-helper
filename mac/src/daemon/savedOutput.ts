import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";

/** How much of the file's end is read, whatever its size. */
export const SAVED_OUTPUT_TAIL_BYTES = 64 * 1024;

const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * The end of the file Claude Code saved a long output in (`<transcript's folder>/<session>/tool-results/<name>.txt`),
 * or null. The transcript names the file, so only one that resolves to that folder is opened.
 */
export async function savedOutputEnd(transcriptPath: string, file: string): Promise<string | null> {
  try {
    if (!isAbsolute(file) || extname(file) !== ".txt" || file.split(sep).includes("..")) return null;
    const folder = join(
      await realpath(dirname(transcriptPath)),
      basename(transcriptPath, ".jsonl"),
      "tool-results",
    );
    const real = await realpath(file);
    if (dirname(real) !== folder || extname(real) !== ".txt") return null;
    // Opening a pipe would wait for its writer.
    if (!(await lstat(real)).isFile()) return null;
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0) return null;
      const from = Math.max(0, stat.size - SAVED_OUTPUT_TAIL_BYTES);
      const bytes = Buffer.alloc(stat.size - from);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, from + read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
      return wholeLines(bytes.subarray(0, read), from > 0);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Bytes that start mid-file lose their first line and a private key's end: redaction can't know a secret by its rest. */
function wholeLines(bytes: Buffer, cut: boolean): string | null {
  if (!cut) return bytes.toString("utf8");
  const firstBreak = bytes.indexOf(0x0a);
  if (firstBreak < 0) return null;
  const text = bytes.subarray(firstBreak + 1).toString("utf8");
  let keyEnd = -1;
  for (const m of text.matchAll(KEY_END)) keyEnd = m.index + m[0].length;
  return keyEnd < 0 ? text : text.slice(keyEnd);
}

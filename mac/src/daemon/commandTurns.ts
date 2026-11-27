import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { commandText, parseCommandEcho, parseCommandPrinted, type TimelineEntry } from "./timeline.ts";

/** A slash command Claude Code ran without the model: its echo in the transcript and what it printed. */
export interface LocalCommand {
  name: string;
  args?: string;
  /** What it printed, raw; absent when nothing followed the echo. */
  output?: string;
  /** The transcript entries it was read from. */
  uuids: string[];
  at: number;
}

interface Cursor {
  path: string;
  offset: number;
  partial: Buffer;
  /** An echo still waiting for its output. */
  echo: { command: LocalCommand; since: number; inTurn: boolean } | null;
}

function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Commands that other mechanisms already answer: a model turn, a compaction, the end of the session. */
const NOT_LOCAL = new Set(["compact", "exit", "quit", "clear", "reset", "new"]);

/**
 * Reads the command echoes a session's transcript gains. A cursor starts at the end of the file when a session
 * is first seen, so what was there before is never replayed.
 */
export class LocalCommandReader {
  private readonly cursors = new Map<string, Cursor>();

  /**
   * The commands completed since the last call. An echo whose output hasn't come is held for `graceMs`: a read
   * between the two lines mustn't split them, and a prompt command's echo is followed by its model turn instead.
   */
  scan(sessionId: string, path: string, graceMs: number, now = Date.now(), inTurn = false): LocalCommand[] {
    const cursor = this.cursorFor(sessionId, path);
    const out: LocalCommand[] = [];
    for (const line of this.newLines(cursor)) {
      let entry: TimelineEntry | null;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry) continue;
      const text = commandText(entry);
      const echo = parseCommandEcho(text);
      const printed = echo ? null : parseCommandPrinted(text);
      if (printed !== null && cursor.echo && cursor.echo.command.output === undefined) {
        cursor.echo.command.output = printed;
        if (entry.uuid) cursor.echo.command.uuids.push(entry.uuid);
        if (!cursor.echo.inTurn) out.push(cursor.echo.command);
        cursor.echo = null;
        continue;
      }
      if (echo) {
        // A second echo means the first printed nothing.
        if (cursor.echo && !cursor.echo.inTurn) out.push(cursor.echo.command);
        const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
        cursor.echo = {
          command: {
            ...echo,
            uuids: entry.uuid ? [entry.uuid] : [],
            at: Number.isNaN(at) ? now : at,
          },
          since: now,
          inTurn,
        };
      }
    }
    if (cursor.echo && now - cursor.echo.since >= graceMs) {
      if (!cursor.echo.inTurn) out.push(cursor.echo.command);
      cursor.echo = null;
    }
    return out.filter((c) => !NOT_LOCAL.has(c.name));
  }

  /** The echo still waiting for output, given up now (a model turn is about to begin): it printed nothing. */
  flush(sessionId: string): LocalCommand[] {
    const cursor = this.cursors.get(sessionId);
    const held = cursor?.echo;
    if (!cursor || !held) return [];
    cursor.echo = null;
    return held.inTurn || NOT_LOCAL.has(held.command.name) ? [] : [held.command];
  }

  forget(sessionId: string): void {
    this.cursors.delete(sessionId);
  }

  /** Starts the session's cursor at the end of the file now, if it has none: later lines are new. */
  open(sessionId: string, path: string): void {
    this.cursorFor(sessionId, path);
  }

  private cursorFor(sessionId: string, path: string): Cursor {
    const known = this.cursors.get(sessionId);
    if (known && sameFile(known.path, path)) return known;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // not written yet: everything in it will be new
    }
    const cursor: Cursor = { path, offset: size, partial: Buffer.alloc(0), echo: null };
    this.cursors.set(sessionId, cursor);
    return cursor;
  }

  private newLines(cursor: Cursor): string[] {
    let size: number;
    try {
      size = statSync(cursor.path).size;
    } catch {
      return [];
    }
    if (size < cursor.offset) {
      cursor.offset = 0;
      cursor.partial = Buffer.alloc(0);
    }
    if (size === cursor.offset) return [];
    const buf = Buffer.alloc(size - cursor.offset);
    let fd: number | null = null;
    try {
      fd = openSync(cursor.path, "r");
      const n = readSync(fd, buf, 0, buf.length, cursor.offset);
      cursor.offset += n;
      const all = Buffer.concat([cursor.partial, buf.subarray(0, n)]);
      const end = all.lastIndexOf(10);
      cursor.partial = end === -1 ? all : all.subarray(end + 1);
      return end === -1 ? [] : all.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}

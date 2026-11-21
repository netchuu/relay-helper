// One phone-started chat: runs the command in a pty of its own, detached so it outlives the daemon.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../atomicWrite.ts";
import { type SavedProcess, startTimeOf } from "../platform/processIdentity.ts";
import { answerRequest, DraftTracker, PasteModeTracker, RequestReader } from "./ptyShell.ts";
import { ScreenText } from "./screenText.ts";

export const HOST_COLS = 120;
export const HOST_ROWS = 40;
/** What an attached window writes to say its size changed: `ESC ] relay;resize;<cols>;<rows> BEL`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequence is what this matches
export const RESIZE_OSC = /\x1b\]relay;resize;(\d{2,4});(\d{1,4})\x07/g;
/** An attached terminal that falls this far behind is dropped; the chat itself goes on. */
const MAX_BACKLOG = 8_000_000;

/** What a host writes about itself, for the daemon that started it. */
export interface HostState {
  socket: string;
  token: string;
  /** The command's own process id. */
  pid: number;
  hostPid: number;
  /** When the host process started (ms), to tell it from a process that got its pid later. */
  hostStart?: number | null;
  /** Set once the command has ended: its last screen, so a refusal at startup can be read. */
  exited?: { code: number; screen: string };
}

/** A Unix socket in the data folder; a named pipe on Windows. */
export function hostSocketPath(dir: string, id: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\relay-host-${id}` : join(dir, `h-${id}.sock`);
}

/** The chat id a host's socket belongs to; null for any other socket (a `relay shell` tab's). */
export function hostIdOf(socket: string): string | null {
  return /(?:[/\\]h-|relay-host-)([0-9a-f]{8})(?:\.sock)?$/.exec(socket)?.[1] ?? null;
}

export function hostStatePath(dir: string, id: string): string {
  return join(dir, `h-${id}.json`);
}

export function readHostState(dir: string, id: string): HostState | null {
  try {
    return JSON.parse(readFileSync(hostStatePath(dir, id), "utf8")) as HostState;
  } catch {
    return null;
  }
}

/** What to check `state.hostPid` against: its start time, or for an older record when the file was written. */
export function hostSaved(dir: string, id: string, state: HostState): SavedProcess {
  if (state.hostStart != null) return { start: state.hostStart };
  try {
    return { savedAt: statSync(hostStatePath(dir, id)).mtimeMs };
  } catch {
    return {};
  }
}

/** The requests besides typing: the screen, letting go of the exit record, the terminal's size, and attaching. */
export type HostOp =
  | { op: "screen" }
  | { op: "release" }
  | { op: "resize"; cols: number; rows: number }
  | { op: "attach"; cols: number; rows: number };

/** A valid `attach` request: its window size. "auth" for a wrong token, null for anything else. */
export function parseAttach(line: string, token: string): { cols: number; rows: number } | "auth" | null {
  let req: { op?: unknown; token?: unknown; cols?: unknown; rows?: unknown } | null;
  try {
    req = JSON.parse(line);
  } catch {
    return null;
  }
  if (!req || typeof req !== "object" || req.op !== "attach") return null;
  if (req.token !== token) return "auth";
  const { cols, rows } = req;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if ((cols as number) < 20 || (cols as number) > 1000 || (rows as number) < 5 || (rows as number) > 1000)
    return null;
  return { cols: cols as number, rows: rows as number };
}

/** Terminals attached to the chat: the chat takes the newest one's size, and the one before it back on detach. */
export class Attachers<T> {
  private readonly list: { key: T; cols: number; rows: number }[] = [];
  constructor(private base: { cols: number; rows: number }) {}

  get count(): number {
    return this.list.length;
  }

  keys(): T[] {
    return this.list.map((a) => a.key);
  }

  /** The size the chat should have now. */
  add(key: T, cols: number, rows: number): { cols: number; rows: number } {
    if (this.list.length === 0) this.base = this.current;
    this.list.push({ key, cols, rows });
    return { cols, rows };
  }

  /** A window changed size. */
  update(key: T, cols: number, rows: number): { cols: number; rows: number } | null {
    const item = this.list.find((a) => a.key === key);
    if (!item || cols < 20 || cols > 1000 || rows < 5 || rows > 1000) return null;
    item.cols = cols;
    item.rows = rows;
    return this.list[this.list.length - 1] === item ? { cols, rows } : null;
  }

  remove(key: T): { cols: number; rows: number } | null {
    const i = this.list.findIndex((a) => a.key === key);
    if (i < 0) return null;
    const wasNewest = i === this.list.length - 1;
    this.list.splice(i, 1);
    return wasNewest ? this.current : null;
  }

  private get current(): { cols: number; rows: number } {
    const last = this.list[this.list.length - 1];
    return last ? { cols: last.cols, rows: last.rows } : this.base;
  }

  /** Records the size the chat has when nobody is attached. */
  setBase(cols: number, rows: number): void {
    if (this.list.length === 0) this.base = { cols, rows };
  }
}

export type HostReply = { ok: true; screen?: string } | { ok: false; reason: string };

export interface HostContext {
  token: string;
  screen(): string;
  release(): void;
  resize(cols: number, rows: number): void;
  /** Answers a typing request. */
  type(line: string): Promise<unknown>;
}

/** One request line: an `op`, or a typing request the shell protocol knows. */
export async function answerHostRequest(line: string, ctx: HostContext): Promise<unknown> {
  let req: { op?: unknown; token?: unknown; cols?: unknown; rows?: unknown } | null;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, reason: "bad_request" };
  }
  if (!req || typeof req !== "object") return { ok: false, reason: "bad_request" };
  if (req.op === undefined) return ctx.type(line);
  if (req.token !== ctx.token) return { ok: false, reason: "auth" };
  if (req.op === "screen") return { ok: true, screen: ctx.screen() };
  if (req.op === "release") {
    ctx.release();
    return { ok: true };
  }
  if (req.op === "resize" && Number.isInteger(req.cols) && Number.isInteger(req.rows)) {
    const [cols, rows] = [req.cols as number, req.rows as number];
    if (cols < 20 || cols > 1000 || rows < 5 || rows > 1000) return { ok: false, reason: "bad_request" };
    ctx.resize(cols, rows);
    return { ok: true };
  }
  return { ok: false, reason: "bad_request" };
}

interface Terminal {
  write(d: string | Uint8Array): void;
  resize(c: number, r: number): void;
  close(): void;
}

/** `relay host --dir <data dir> --id <id> --cwd <folder> -- <command…>`; returns the command's exit code. */
export async function runHost(args: string[]): Promise<number> {
  const sep = args.indexOf("--");
  const flags = sep === -1 ? args : args.slice(0, sep);
  const cmd = sep === -1 ? [] : args.slice(sep + 1);
  const flag = (name: string) => flags[flags.indexOf(name) + 1];
  const dir = flag("--dir");
  const id = flag("--id");
  const cwd = flag("--cwd");
  if (!dir || !id || !cwd || cmd.length === 0) {
    console.error("usage: relay host --dir <dir> --id <id> --cwd <folder> -- <command…>");
    return 2;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = hostSocketPath(dir, id);
  const statePath = hostStatePath(dir, id);
  rmSync(socketPath, { force: true });
  const token = randomBytes(16).toString("hex");
  const paste = new PasteModeTracker();
  const draft = new DraftTracker();
  const screen = new ScreenText(HOST_ROWS);
  let released = false;
  let lastAttachInput = 0;
  const attached = new Attachers<Socket>({ cols: HOST_COLS, rows: HOST_ROWS });

  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
    RELAY_PTY: socketPath,
    RELAY_PTY_TOKEN: token,
  };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd,
      env,
      terminal: {
        cols: HOST_COLS,
        rows: HOST_ROWS,
        data(_t: unknown, data: Uint8Array) {
          paste.feed(data);
          screen.feed(data);
          for (const sock of attached.keys()) {
            if (sock.writableLength > MAX_BACKLOG) sock.destroy();
            else sock.write(data);
          }
        },
      },
    } as Parameters<typeof Bun.spawn>[1]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeState({
      socket: socketPath,
      token,
      pid: 0,
      hostPid: process.pid,
      hostStart: startTimeOf(process.pid),
      exited: { code: 127, screen: message },
    });
    return 127;
  }
  const term = (proc as unknown as { terminal: Terminal }).terminal;

  function writeState(state: HostState): void {
    writeFileAtomic(statePath, JSON.stringify(state), 0o600);
  }

  // Claude Code redraws on a size change only, so an attach at the size it already has nudges it.
  let size = { cols: HOST_COLS, rows: HOST_ROWS };
  function applySize(cols: number, rows: number, nudge = false): void {
    const same = cols === size.cols && rows === size.rows;
    size = { cols, rows };
    screen.rows = rows;
    if (nudge && same) {
      term.resize(cols, rows - 1);
      setTimeout(() => term.resize(size.cols, size.rows), 50);
    } else term.resize(cols, rows);
  }

  const ctx: HostContext = {
    token,
    screen: () => screen.text(),
    release: () => {
      released = true;
    },
    resize: (cols, rows) => {
      applySize(cols, rows);
      attached.setBase(cols, rows);
    },
    type: (line) =>
      answerRequest(line, {
        token,
        shellPid: proc.pid,
        // Nothing sits between Relay and Claude Code here: there is no shell prompt to type into by mistake.
        isForeground: async () => proc.exitCode === null,
        lastInput: () => lastAttachInput,
        hasDraft: () => draft.pending,
        sentEnter: () => draft.feed("\r"),
        pasteOn: () => paste.on,
        write: (d) => {
          draft.feed(d);
          term.write(d);
        },
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
      }),
  };

  const server: Server = createServer((sock: Socket) => {
    const reader = new RequestReader();
    let attachedHere = false;
    sock.on("error", () => {});
    sock.on("close", () => {
      if (!attachedHere) return;
      const back = attached.remove(sock);
      if (back) applySize(back.cols, back.rows);
    });
    sock.on("data", async (chunk: Buffer) => {
      if (attachedHere) {
        // The attached window's size changes arrive in the input stream as an OSC the client writes itself.
        let keys = chunk.toString("latin1");
        for (const m of keys.matchAll(RESIZE_OSC)) {
          const next = attached.update(sock, Number(m[1]), Number(m[2]));
          if (next) applySize(next.cols, next.rows);
        }
        keys = keys.replace(RESIZE_OSC, "");
        if (keys === "") return;
        lastAttachInput = Date.now();
        const bytes = Buffer.from(keys, "latin1");
        draft.feed(bytes);
        term.write(bytes);
        return;
      }
      const line = reader.push(chunk);
      if (line === null) return;
      if (line === "overflow") return void sock.end();
      const wants = parseAttach(line, token);
      if (wants && wants !== "auth") {
        attachedHere = true;
        const next = attached.add(sock, wants.cols, wants.rows);
        sock.write(`${JSON.stringify({ ok: true })}\n`);
        applySize(next.cols, next.rows, true);
        return;
      }
      sock.end(`${JSON.stringify(await answerHostRequest(line, ctx))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  writeState({
    socket: socketPath,
    token,
    pid: proc.pid,
    hostPid: process.pid,
    hostStart: startTimeOf(process.pid),
  });

  // Closing the chat from outside ends Claude Code, and with it this host, leaving no record.
  for (const sig of ["SIGHUP", "SIGTERM"] as const)
    process.on(sig, () => {
      released = true;
      proc.kill(sig);
    });

  const code = await proc.exited;
  const last = screen.text();
  server.close();
  rmSync(socketPath, { force: true });
  term.close();
  // A start that Claude Code refused keeps its words until the daemon has read them.
  if (released) rmSync(statePath, { force: true });
  else
    writeState({
      socket: socketPath,
      token,
      pid: proc.pid,
      hostPid: process.pid,
      hostStart: startTimeOf(process.pid),
      exited: { code, screen: last },
    });
  return code;
}

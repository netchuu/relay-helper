// One phone-started chat: runs the command in a pty of its own, detached so it outlives the daemon.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../atomicWrite.ts";
import { answerRequest, DraftTracker, PasteModeTracker, RequestReader } from "./ptyShell.ts";
import { ScreenText } from "./screenText.ts";

export const HOST_COLS = 120;
export const HOST_ROWS = 40;

/** What a host writes about itself, for the daemon that started it. */
export interface HostState {
  socket: string;
  token: string;
  /** The command's own process id. */
  pid: number;
  hostPid: number;
  /** Set once the command has ended: its last screen, so a refusal at startup can be read. */
  exited?: { code: number; screen: string };
}

/** A Unix socket in the data folder; a named pipe on Windows. */
export function hostSocketPath(dir: string, id: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\relay-host-${id}` : join(dir, `h-${id}.sock`);
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

/** The requests besides typing: the screen, letting go of the exit record, and the terminal's size. */
export type HostOp = { op: "screen" } | { op: "release" } | { op: "resize"; cols: number; rows: number };

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
      exited: { code: 127, screen: message },
    });
    return 127;
  }
  const term = (proc as unknown as { terminal: Terminal }).terminal;

  function writeState(state: HostState): void {
    writeFileAtomic(statePath, JSON.stringify(state), 0o600);
  }

  const ctx: HostContext = {
    token,
    screen: () => screen.text(),
    release: () => {
      released = true;
    },
    resize: (cols, rows) => {
      term.resize(cols, rows);
      screen.rows = rows;
    },
    type: (line) =>
      answerRequest(line, {
        token,
        shellPid: proc.pid,
        // Nothing sits between Relay and Claude Code here: there is no shell prompt to type into by mistake.
        isForeground: async () => proc.exitCode === null,
        lastInput: () => 0,
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
    sock.on("error", () => {});
    sock.on("data", async (chunk: Buffer) => {
      const line = reader.push(chunk);
      if (line === null) return;
      if (line === "overflow") return void sock.end();
      sock.end(`${JSON.stringify(await answerHostRequest(line, ctx))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (process.platform !== "win32") chmodSync(socketPath, 0o600);
  writeState({ socket: socketPath, token, pid: proc.pid, hostPid: process.pid });

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
      exited: { code, screen: last },
    });
  return code;
}

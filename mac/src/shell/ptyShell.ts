/** `relay shell`: runs your login shell in a pty with a private socket for typing phone replies into the tab. */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { relayHome } from "../home.ts";
import { cleanTypedText } from "./typedText.ts";

export interface TypeRequest {
  token: string;
  /** Text to type, then Enter. Absent in a key request. */
  text?: string;
  /** A key to press instead of typing. Carries no `text`, so an older `relay shell` answers `bad_request`. */
  key?: "escape" | "enter" | "up" | "down";
  /** The agent process the reply is for; Relay only types while it is in the foreground of this tab. */
  pid: number;
  /** Sent by every helper that types at once; one that omits it is from before and gets the same treatment. */
  force?: boolean;
}

export type TypeReply =
  | { ok: true }
  | { ok: false; reason: "auth" | "not_foreground" | "typing" | "draft" | "bad_request" | "typed_not_sent" };

/** The shell to run: $SHELL, else the platform default. */
export function userShell(env: Record<string, string | undefined> = process.env): string {
  return env.SHELL?.startsWith("/") ? env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** Bytes to write: the cleaned text (one bracketed paste when on, so newlines don't submit), then Enter. */
export function typedBytes(text: string, bracketedPaste: boolean): { body: string; enter: string } {
  const clean = cleanTypedText(text);
  if (bracketedPaste) return { body: `\x1b[200~${clean}\x1b[201~`, enter: "\r" };
  // Without bracketed paste a newline would submit, so keep it on one line.
  return { body: clean.replace(/\n+/g, " "), enter: "\r" };
}

/** Ctrl+S: Claude Code puts the prompt's draft aside, and brings it back when the next message is sent. */
const STASH = "\x13";

/** What a key request writes into the tab: the key alone, no Enter. */
export const KEY_BYTES: Record<NonNullable<TypeRequest["key"]>, string> = {
  escape: "\x1b",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
};

export interface RequestContext {
  token: string;
  shellPid: number;
  isForeground(pid: number, shellPid: number): Promise<boolean>;
  /** Whether you typed something into the agent's prompt that isn't sent yet (DraftTracker). */
  hasDraft?(): boolean;
  /** The helper pressed Enter itself: whatever was in the prompt went with it, so no draft is left. */
  sentEnter?(): void;
  /** The draft was stashed; the returned function marks it back once Claude Code has restored it. */
  stashed?(): () => void;
  pasteOn(): boolean;
  write(data: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Answers one request on the tab's socket: type text (then Enter), or press a key. */
export async function answerRequest(line: string, ctx: RequestContext): Promise<TypeReply> {
  let req: TypeRequest;
  try {
    req = JSON.parse(line);
  } catch {
    return { ok: false, reason: "bad_request" };
  }
  if (!req || typeof req !== "object") return { ok: false, reason: "bad_request" };
  if (req.token !== ctx.token) return { ok: false, reason: "auth" };
  if (!Number.isInteger(req.pid)) return { ok: false, reason: "bad_request" };
  const key = req.key !== undefined && req.text === undefined ? KEY_BYTES[req.key] : undefined;
  if (key === undefined && typeof req.text !== "string") return { ok: false, reason: "bad_request" };
  // Never type into a bare shell prompt or another program: only into the agent, in front.
  if (!(await ctx.isForeground(req.pid, ctx.shellPid))) return { ok: false, reason: "not_foreground" };
  if (key !== undefined) {
    // A stop you asked for: no waiting for a quiet moment, and Esc doesn't mix into what you type.
    ctx.write(key);
    // Enter sends whatever sits in the prompt; one Esc doesn't clear it.
    if (req.key === "enter") ctx.sentEnter?.();
    return { ok: true };
  }
  // The phone's message goes in now. A draft is stashed (Ctrl+S) and Claude Code brings it back after the send.
  const draft = ctx.hasDraft?.() === true;
  const restore = draft ? ctx.stashed?.() : undefined;
  if (draft) {
    ctx.write(STASH);
    await ctx.sleep(150);
  }
  const text = req.text as string;
  const { body, enter } = typedBytes(text, ctx.pasteOn());
  ctx.write(body);
  await ctx.sleep(150);
  // Enter is what runs a command: check once more that the agent is still in front. The text is already typed.
  if (!(await ctx.isForeground(req.pid, ctx.shellPid))) return { ok: false, reason: "typed_not_sent" };
  ctx.write(enter);
  ctx.sentEnter?.();
  restore?.();
  return { ok: true };
}

/** Tracks whether the agent's prompt holds a draft: text typed since the last Enter; Ctrl+C, Ctrl+U, Esc Esc clear it. */
export class DraftTracker {
  /** A short run of keys (up to SHORT_CHARS) idle this long stops counting: it may have answered a dialog. */
  static readonly STALE_MS = 20_000;
  static readonly SHORT_CHARS = 3;
  /** A longer draft is real text you paused on: it stays for this long (an abandoned tab eventually frees up). */
  static readonly LONG_STALE_MS = 6 * 60 * 60_000;
  /** An Esc that the next key follows later than this is a key press of its own, not the start of a sequence. */
  static readonly ESC_MS = 250;
  /** The window for a second Esc, at the pace of a person pressing Esc twice. */
  static readonly ESC_ESC_MS = 800;
  private chars = 0;
  private lastFed = 0;

  constructor(private readonly now: () => number = Date.now) {}
  private esc = false;
  private seq = false;
  private ss3 = false;
  private pasting = false;
  private pasteTail = "";

  feed(chunk: Uint8Array | string): void {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const at = this.now();
    // A lone Esc: the next key came much later, so it isn't Option+Enter or Alt+key; it stands alone.
    // A second Esc (Esc Esc clears the draft) may come much later than Enter or a letter, so it gets a longer window.
    const window = text.startsWith("\x1b") ? DraftTracker.ESC_ESC_MS : DraftTracker.ESC_MS;
    if (this.esc && at - this.lastFed > window) this.esc = false;
    this.lastFed = at;
    for (const ch of text) {
      if (this.pasting) {
        this.pasteTail = (this.pasteTail + ch).slice(-6);
        if (this.pasteTail === "\x1b[201~") {
          // The end marker's "[201~" was counted as it came in.
          this.chars = Math.max(0, this.chars - 5);
          this.pasting = false;
          this.pasteTail = "";
        } else if (ch !== "\x1b") this.chars++;
        continue;
      }
      if (this.ss3) {
        this.ss3 = false; // ESC O x: an arrow or function key
        continue;
      }
      if (this.seq) {
        // CSI: parameters until a final byte; "200~" starts a paste.
        this.pasteTail += ch;
        if (ch >= "@" && ch <= "~") {
          if (this.pasteTail === "200~") this.pasting = true;
          this.seq = false;
          this.pasteTail = "";
        }
        continue;
      }
      if (this.esc) {
        this.esc = false;
        if (ch === "[") {
          this.seq = true;
          this.pasteTail = "";
          continue;
        }
        if (ch === "\x1b") {
          this.chars = 0; // Esc Esc clears the prompt
          continue;
        }
        if (ch === "O") this.ss3 = true;
        // Option+Enter (ESC CR) is a new line in the draft, not a send; Alt+key types nothing.
        continue;
      }
      if (ch === "\x1b") this.esc = true;
      else if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\x15") this.chars = 0;
      else if (ch === "\x7f" || ch === "\b") this.chars = Math.max(0, this.chars - 1);
      else if (ch >= " ") this.chars++;
    }
  }

  /** The draft is stashed: none is left in the prompt. The returned function marks it back once it is restored. */
  stash(): () => void {
    const chars = this.chars;
    this.chars = 0;
    return () => {
      this.chars = chars;
      this.lastFed = this.now();
    };
  }

  get pending(): boolean {
    const limit = this.chars <= DraftTracker.SHORT_CHARS ? DraftTracker.STALE_MS : DraftTracker.LONG_STALE_MS;
    if (this.chars > 0 && this.now() - this.lastFed >= limit) this.chars = 0;
    return this.chars > 0;
  }
}

/** Tracks whether the program in the tab has bracketed paste on, from its output (sequences may split). */
export class PasteModeTracker {
  on = false;
  private tail = "";

  feed(chunk: Uint8Array | string): void {
    const text = this.tail + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1"));
    const on = text.lastIndexOf("\x1b[?2004h");
    const off = text.lastIndexOf("\x1b[?2004l");
    if (on !== -1 || off !== -1) this.on = on > off;
    this.tail = text.slice(-7);
  }
}

/** Collects one request line from socket chunks, decoding as a stream (a chunk can split a character). */
export class RequestReader {
  static readonly MAX_CHARS = 1_000_000;
  private readonly decoder = new TextDecoder("utf-8");
  private buf = "";

  /** Feeds a chunk. Returns the request line once its newline arrived, "overflow" when it grows too big, else null. */
  push(chunk: Uint8Array): string | "overflow" | null {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const nl = this.buf.indexOf("\n");
    if (nl === -1) return this.buf.length > RequestReader.MAX_CHARS ? "overflow" : null;
    const line = this.buf.slice(0, nl);
    this.buf = "";
    return line;
  }
}

export async function runShell(args: string[]): Promise<number> {
  const shell = userShell();
  // Zed passes extra arguments for tasks (`-c <command>`), and a non-interactive start has no terminal:
  // both go straight to the real shell.
  if (args.length > 0 || !process.stdin.isTTY || !process.stdout.isTTY) return passThrough([shell, ...args]);
  try {
    return await runInPty(shell);
  } catch {
    return passThrough([shell, "-l"]);
  }
}

async function passThrough(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  return await proc.exited;
}

async function runInPty(shell: string): Promise<number> {
  const dir = join(relayHome(), "pty");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = join(dir, `${process.pid}.sock`);
  rmSync(socketPath, { force: true });
  const token = randomBytes(16).toString("hex");
  const paste = new PasteModeTracker();
  const draft = new DraftTracker();

  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const proc = Bun.spawn([shell, "-l"], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_PTY: socketPath, RELAY_PTY_TOKEN: token },
    terminal: {
      ...size(),
      data(_t: unknown, data: Uint8Array) {
        paste.feed(data);
        process.stdout.write(data);
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  const term = (
    proc as unknown as {
      terminal: { write(d: string | Uint8Array): void; resize(c: number, r: number): void };
    }
  ).terminal;

  process.stdin.setRawMode(true);
  process.stdin.on("data", (d: Buffer) => {
    draft.feed(d);
    term.write(d);
  });
  process.stdin.resume();
  process.on("SIGWINCH", () => {
    const s = size();
    term.resize(s.cols, s.rows);
  });
  // The tab closed: pass it on to the shell, which ends everything running in it.
  for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, () => proc.kill(sig));

  const server = Bun.listen<{ reader: RequestReader }>({
    unix: socketPath,
    socket: {
      open(sock) {
        sock.data = { reader: new RequestReader() };
      },
      async data(sock, chunk) {
        const line = sock.data.reader.push(chunk);
        if (line === null) return;
        if (line === "overflow") {
          sock.end();
          return;
        }
        const reply = await answerRequest(line, {
          token,
          shellPid: proc.pid,
          isForeground,
          hasDraft: () => draft.pending,
          sentEnter: () => draft.feed("\r"),
          stashed: () => draft.stash(),
          pasteOn: () => paste.on,
          write: (d) => term.write(d),
          sleep: (ms) => Bun.sleep(ms),
          now: () => Date.now(),
        });
        sock.end(`${JSON.stringify(reply)}\n`);
      },
    },
  });
  chmodSync(socketPath, 0o600);

  const code = await proc.exited;
  server.stop(true);
  rmSync(socketPath, { force: true });
  try {
    process.stdin.setRawMode(false);
  } catch {
    // the terminal is already gone
  }
  return code;
}

/** True when `pid`'s process group is the foreground group of the terminal the shell runs in. */
export async function isForeground(pid: number, shellPid: number): Promise<boolean> {
  // Loaded here: config.ts costs more start-up time than `relay wrap` can spare.
  const { CHILD_PATH } = await import("../config.ts");
  const out = Bun.spawn(["ps", "-o", "pid=,pgid=,tpgid=", "-p", `${shellPid},${pid}`], {
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const text = await new Response(out.stdout).text();
  await out.exited;
  const rows = new Map<number, { group: number; fg: number }>();
  for (const m of text.matchAll(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s*$/gm))
    rows.set(Number(m[1]), { group: Number(m[2]), fg: Number(m[3]) });
  const fg = rows.get(shellPid)?.fg;
  const group = rows.get(pid)?.group;
  return fg !== undefined && fg > 0 && fg === group;
}

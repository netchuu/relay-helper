/**
 * `relay shell`: the program Zed's terminal starts (see ../integrations/zed.ts). It runs your normal
 * login shell inside a pseudo-terminal that Relay owns and passes everything through untouched, so the
 * tab looks and behaves exactly as before. What it adds: a private socket the helper can use to type a
 * reply from the phone into this tab, as if you typed it. Claude Code then sees ordinary keyboard input
 * (no "another session" label, never held in bypass mode).
 *
 * Nothing here is specific to Claude: any agent CLI started in this tab can receive typed replies.
 *
 * Fail open: if anything goes wrong before the pseudo-terminal is up, the real shell runs directly.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CHILD_PATH, paths } from "../config.ts";
import { cleanTypedText } from "./typedText.ts";

/** How long the tab must be quiet before Relay types into it, and the longest it waits for that. */
export const QUIET_MS = 2000;
const MAX_WAIT_MS = 15_000;

export interface TypeRequest {
  token: string;
  /** Text to type, then Enter. Absent in a key request. */
  text?: string;
  /**
   * A key to press instead of typing (Esc stops Claude's turn: session.interrupt). Key requests carry no
   * `text` on purpose: a `relay shell` from before keys existed answers `bad_request` instead of typing an
   * empty line and Enter.
   */
  key?: "escape" | "enter";
  /** The agent process the reply is for; Relay only types while it is in the foreground of this tab. */
  pid: number;
  /**
   * The message waited long enough for a pause (the helper's TYPE_ANYWAY_MS): type it now, without waiting for a
   * quiet moment, and after a clean break when the prompt holds a draft.
   */
  force?: boolean;
}

export type TypeReply =
  | { ok: true }
  | { ok: false; reason: "auth" | "not_foreground" | "typing" | "draft" | "bad_request" };

/** The shell to run: $SHELL, else the platform default. */
export function userShell(env: Record<string, string | undefined> = process.env): string {
  return env.SHELL?.startsWith("/") ? env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/**
 * Bytes to write so the text lands in the agent's input box. Control characters are dropped first
 * (./typedText.ts). With bracketed paste on (Claude Code turns it on), the text goes in as one paste, so
 * newlines don't submit early; Enter follows separately.
 */
export function typedBytes(text: string, bracketedPaste: boolean): { body: string; enter: string } {
  const clean = cleanTypedText(text);
  if (bracketedPaste) return { body: `\x1b[200~${clean}\x1b[201~`, enter: "\r" };
  // Without bracketed paste a newline would submit, so keep it on one line.
  return { body: clean.replace(/\n+/g, " "), enter: "\r" };
}

/** What a key request writes into the tab: the key alone, no Enter. */
export const KEY_BYTES: Record<NonNullable<TypeRequest["key"]>, string> = { escape: "\x1b", enter: "\r" };

export interface RequestContext {
  token: string;
  shellPid: number;
  isForeground(pid: number, shellPid: number): Promise<boolean>;
  /** When you last typed in this tab (ms). */
  lastInput(): number;
  /** Whether you typed something into the agent's prompt that isn't sent yet (DraftTracker). */
  hasDraft?(): boolean;
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
    return { ok: true };
  }
  const force = req.force === true;
  if (!force) {
    // Don't mix into what you're typing in this tab: wait for a quiet moment.
    const started = ctx.now();
    while (ctx.now() - ctx.lastInput() < QUIET_MS) {
      if (ctx.now() - started > MAX_WAIT_MS) return { ok: false, reason: "typing" };
      await ctx.sleep(250);
    }
    // Nor into a draft you left in the prompt: the helper waits for it to be sent or cleared.
    if (ctx.hasDraft?.()) return { ok: false, reason: "draft" };
  }
  const text = req.text as string;
  const { body, enter } = typedBytes(ctx.hasDraft?.() ? `\n\n${text}` : text, ctx.pasteOn());
  ctx.write(body);
  await ctx.sleep(150);
  ctx.write(enter);
  return { ok: true };
}

/**
 * Follows what you type into this tab closely enough to tell whether the agent's prompt holds a draft: text typed
 * or pasted since the last Enter, minus what you deleted. Ctrl+C, Ctrl+U and Esc Esc clear it, as in Claude Code.
 * Arrow keys and other sequences don't count; text recalled from history isn't seen.
 */
export class DraftTracker {
  /**
   * A short run of keys (up to SHORT_CHARS, like `1`, `y`, `yes` with no Enter) that stopped this long ago no longer
   * counts as a draft. The tracker can't see the screen, so a key that answered a dialog looks like draft text; it
   * must not block phone messages for good.
   */
  static readonly STALE_MS = 20_000;
  static readonly SHORT_CHARS = 3;
  /** A longer draft is real text you paused on: it stays for this long (an abandoned tab eventually frees up). */
  static readonly LONG_STALE_MS = 6 * 60 * 60_000;
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
    this.lastFed = this.now();
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
  const dir = join(paths.home, "pty");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = join(dir, `${process.pid}.sock`);
  rmSync(socketPath, { force: true });
  const token = randomBytes(16).toString("hex");
  const paste = new PasteModeTracker();
  const draft = new DraftTracker();
  let lastInput = 0;

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
    lastInput = Date.now();
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

  const server = Bun.listen<{ buf: string }>({
    unix: socketPath,
    socket: {
      open(sock) {
        sock.data = { buf: "" };
      },
      async data(sock, chunk) {
        sock.data.buf += Buffer.from(chunk).toString("utf8");
        const nl = sock.data.buf.indexOf("\n");
        if (nl === -1) {
          if (sock.data.buf.length > 1_000_000) sock.end();
          return;
        }
        const line = sock.data.buf.slice(0, nl);
        sock.data.buf = "";
        const reply = await answerRequest(line, {
          token,
          shellPid: proc.pid,
          isForeground,
          lastInput: () => lastInput,
          hasDraft: () => draft.pending,
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
  const read = async (field: string, p: number) => {
    const out = Bun.spawn(["ps", "-o", `${field}=`, "-p", String(p)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: CHILD_PATH },
    });
    const text = (await new Response(out.stdout).text()).trim();
    await out.exited;
    return text ? Number(text) : NaN;
  };
  const [fg, group] = await Promise.all([read("tpgid", shellPid), read("pgid", pid)]);
  return Number.isFinite(fg) && fg > 0 && fg === group;
}

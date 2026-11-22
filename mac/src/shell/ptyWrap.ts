/** `relay wrap -- <claude args…>`: runs Claude Code in a pty Relay owns, in the terminal it was started from. */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { constants } from "node:os";
import { basename, join } from "node:path";
import { relayHome } from "../home.ts";
import { answerHostRequest, hostIdOf } from "./ptyHost.ts";
import { answerRequest, DraftTracker, PasteModeTracker, RequestReader } from "./ptyShell.ts";
import { ScreenText } from "./screenText.ts";

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: escape sequences are what these match
const CSI_REPORT = /\x1b\[(?:[?>=]?[\d;:]*[Rcyntx]|[IO]|<[\d;]*[Mm])/g;
const STRING_REPORT = /\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const MODE_SEQ = /\x1b\[\?([\d;]+)([hl])/g;
const KITTY_SEQ = /\x1b\[([<>])(\d*)u/g;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: escape sequences are what these match

/** What you actually typed in a chunk of terminal input: replies to queries, focus and mouse reports removed. */
export function typedPart(chunk: string): string {
  return chunk.replace(STRING_REPORT, "").replace(CSI_REPORT, "");
}

const RESET_MODES = new Set([
  "25",
  "47",
  "1000",
  "1002",
  "1003",
  "1004",
  "1005",
  "1006",
  "1015",
  "1047",
  "1049",
  "2004",
]);

/** Follows the terminal modes the program turned on, so the window can be given back as it was if it dies. */
export class TerminalModes {
  private readonly on = new Set<string>();
  private cursorHidden = false;
  private kitty = 0;
  private tail = "";

  feed(chunk: Uint8Array | string): void {
    const text = this.tail + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1"));
    for (const m of text.matchAll(MODE_SEQ)) {
      for (const mode of (m[1] as string).split(";")) {
        if (mode === "25") this.cursorHidden = m[2] === "l";
        else if (RESET_MODES.has(mode)) m[2] === "h" ? this.on.add(mode) : this.on.delete(mode);
      }
    }
    for (const m of text.matchAll(KITTY_SEQ)) {
      if (m[1] === ">") this.kitty++;
      else this.kitty = Math.max(0, this.kitty - (m[2] ? Number(m[2]) : 1));
    }
    const esc = text.lastIndexOf("\x1b");
    this.tail = esc !== -1 && text.length - esc < 16 ? text.slice(esc) : "";
  }

  /** The sequences that undo what is still on. Empty when the program left everything as it found it. */
  undo(): string {
    let out = "";
    if (this.kitty > 0) out += `\x1b[<${this.kitty}u`;
    for (const mode of this.on) out += `\x1b[?${mode}l`;
    if (this.cursorHidden) out += "\x1b[?25h";
    return out;
  }
}

/** Where the real Claude Code is: `--claude <path>`, else `RELAY_CLAUDE_BIN`, else the first `claude` on PATH. */
export function parseWrapArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): { claude: string | null; rest: string[] } {
  let claude: string | null = null;
  let i = 0;
  if (args[0] === "--claude") {
    claude = args[1] ?? null;
    i = 2;
  }
  if (args[i] === "--") i++;
  claude ??= env.RELAY_CLAUDE_BIN || Bun.which("claude", { PATH: env.PATH ?? "" });
  return { claude, rest: args.slice(i) };
}

/** Already inside a Relay terminal (a wrap, a host): a second pty would only get in the way. */
export function insideRelayPty(env: Record<string, string | undefined> = process.env): boolean {
  const socket = env.RELAY_PTY;
  return !!socket && (hostIdOf(socket) !== null || basename(socket).startsWith("w-"));
}

function exitCodeOf(proc: { exitCode: number | null; signalCode?: string | number | null }): number {
  if (proc.exitCode !== null) return proc.exitCode;
  const n =
    typeof proc.signalCode === "number"
      ? proc.signalCode
      : constants.signals[proc.signalCode as keyof typeof constants.signals];
  return 128 + (n ?? 1);
}

/** `relay wrap`; returns Claude Code's exit code. */
export async function runWrap(args: string[]): Promise<number> {
  const { claude, rest } = parseWrapArgs(args);
  if (!claude) {
    console.error("relay wrap: Claude Code isn't installed (no `claude` on PATH).");
    return 127;
  }
  const cmd = [claude, ...rest];
  if (!process.stdin.isTTY || !process.stdout.isTTY || insideRelayPty()) return passThrough(cmd);
  try {
    return await runInPty(cmd);
  } catch {
    // Relay must never be the reason `claude` doesn't start.
    return passThrough(cmd);
  }
}

async function passThrough(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  const forward = (sig: NodeJS.Signals) => () => proc.kill(sig);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(sig, forward(sig));
  return await proc.exited;
}

const SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGQUIT"];

async function runInPty(cmd: string[]): Promise<number> {
  const dir = join(relayHome(), "pty");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = join(dir, `w-${process.pid}.sock`);
  rmSync(socketPath, { force: true });
  const token = randomBytes(16).toString("hex");
  const paste = new PasteModeTracker();
  const draft = new DraftTracker();
  const modes = new TerminalModes();
  const screen = new ScreenText(process.stdout.rows || 24);
  // Parsed when asked for, so a long redraw isn't slowed by it; only the last PENDING_MAX bytes are kept.
  let unread: Uint8Array[] = [];
  let unreadBytes = 0;
  const PENDING_MAX = 2_000_000;
  const screenText = () => {
    for (const chunk of unread) screen.feed(chunk);
    unread = [];
    unreadBytes = 0;
    return screen.text();
  };
  let lastInput = 0;

  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_PTY: socketPath, RELAY_PTY_TOKEN: token },
    terminal: {
      ...size(),
      data(_t: unknown, data: Uint8Array) {
        paste.feed(data);
        unread.push(data.slice());
        unreadBytes += data.length;
        while (unreadBytes > PENDING_MAX && unread.length > 1)
          unreadBytes -= (unread.shift() as Uint8Array).length;
        modes.feed(data);
        process.stdout.write(data);
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  const term = (
    proc as unknown as {
      terminal: { write(d: string | Uint8Array): void; resize(c: number, r: number): void; close(): void };
    }
  ).terminal;

  const stdin = process.stdin;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      stdin.setRawMode(false);
    } catch {
      // the terminal is already gone
    }
    try {
      const undo = modes.undo();
      if (undo) process.stdout.write(undo);
    } catch {
      // nobody left to read it
    }
  };
  const raw = () => {
    stdin.setRawMode(true);
    restored = false;
  };
  raw();
  stdin.on("data", (d: Buffer) => {
    const typed = typedPart(d.toString("latin1"));
    if (typed !== "") {
      lastInput = Date.now();
      draft.feed(Buffer.from(typed, "latin1"));
    }
    term.write(d);
    if (d.includes(0x1a)) void suspendIfStopped();
  });
  stdin.resume();
  // Gone when the outer terminal closes: nothing more to read.
  stdin.on("end", () => proc.kill("SIGHUP"));

  const resize = () => {
    const s = size();
    screen.rows = s.rows;
    term.resize(s.cols, s.rows);
  };
  process.on("SIGWINCH", resize);
  for (const sig of [...SIGNALS, "SIGTERM"] as NodeJS.Signals[])
    process.on(sig, () => {
      proc.kill(sig);
      // A program that ignores the hangup is stopped for good after a moment.
      if (sig === "SIGHUP" || sig === "SIGTERM") setTimeout(() => proc.kill("SIGKILL"), 3000).unref();
    });

  // Claude Code suspends itself on Ctrl-Z. The shell around us only sees this process, so it stops too.
  let suspended = false;
  async function suspendIfStopped(): Promise<void> {
    for (let i = 0; i < 10 && proc.exitCode === null; i++) {
      await Bun.sleep(40);
      if (await isStopped(proc.pid)) return stopSelf();
    }
  }
  function stopSelf(): void {
    if (suspended) return;
    suspended = true;
    restore();
    process.kill(process.pid, "SIGSTOP");
  }
  process.on("SIGTSTP", () => {
    proc.kill("SIGTSTP");
    stopSelf();
  });
  process.on("SIGCONT", () => {
    if (!suspended) return;
    suspended = false;
    raw();
    // proc.kill("SIGCONT") doesn't reach a stopped child.
    process.kill(proc.pid, "SIGCONT");
    resize();
  });

  const server = createServer((sock: Socket) => {
    const reader = new RequestReader();
    sock.on("error", () => {});
    sock.on("data", async (chunk: Buffer) => {
      const line = reader.push(chunk);
      if (line === null) return;
      if (line === "overflow") return void sock.end();
      const reply = await answerHostRequest(line, {
        token,
        screen: screenText,
        release: () => {},
        resize: () => {},
        type: (req) =>
          answerRequest(req, {
            token,
            shellPid: proc.pid,
            // Nothing sits between Relay and Claude Code: it is in front while it runs.
            isForeground: async () => proc.exitCode === null,
            lastInput: () => lastInput,
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
      });
      sock.end(`${JSON.stringify(reply)}\n`);
    });
  });
  // Without a socket Claude Code still runs, just without the route.
  await new Promise<void>((resolve) => {
    server.once("error", () => resolve());
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  const onCrash = () => {
    restore();
    proc.kill("SIGHUP");
    rmSync(socketPath, { force: true });
  };
  process.on("uncaughtException", (err) => {
    onCrash();
    console.error(err);
    process.exit(1);
  });
  process.on("exit", () => {
    restore();
    rmSync(socketPath, { force: true });
  });

  await proc.exited;
  server.close();
  rmSync(socketPath, { force: true });
  term.close();
  stdin.pause();
  restore();
  return exitCodeOf(proc);
}

async function isStopped(pid: number): Promise<boolean> {
  try {
    const out = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/bin:/usr/bin" },
    });
    const text = await new Response(out.stdout).text();
    await out.exited;
    return text.trim().startsWith("T");
  } catch {
    return false;
  }
}

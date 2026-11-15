/**
 * relay-hook: the command Claude Code runs for every Relay hook event.
 *
 * Contract: FAIL OPEN. If the daemon is not running or anything goes wrong, print nothing and exit 0,
 * so Claude Code behaves exactly as if Relay were not installed. Keep this file dependency-free: it is
 * compiled to a standalone binary and its startup time is paid on every hook event.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BLOCKING_EVENTS = new Set(["PermissionRequest"]);
const NON_BLOCKING_TIMEOUT_MS = 5000;

const STDOUT_FLUSH_TIMEOUT_MS = 10_000;

/**
 * Write the reply and wait until it is flushed. Exiting right after `write` cuts a large reply at the
 * pipe's buffer (64 KiB) when the reader is a Node process or a shell. A reader that never reads or
 * has closed the pipe must not hang Claude Code: give up after a timeout or on any error.
 */
function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STDOUT_FLUSH_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    process.stdout.on("error", done);
    try {
      process.stdout.write(text, done);
    } catch {
      done();
    }
  });
}

async function main(): Promise<void> {
  // The daemon's own Claude processes (manager agent, summaries) must not report to themselves.
  if (process.env.RELAY_INTERNAL === "1") return;

  const stdin = await Bun.stdin.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return;
  }
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const home = process.env.RELAY_HOME ?? join(homedir(), ".relay");
  const env = process.env;
  const pid = Number(env.CLAUDE_PID ?? process.ppid);

  const body = JSON.stringify({
    payload,
    env: {
      socket: env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
      token: env.CLAUDE_CODE_MESSAGING_TOKEN ?? null,
      termProgram: env.TERM_PROGRAM ?? null,
      tmux: env.TMUX ?? null,
      tmuxPane: env.TMUX_PANE ?? null,
      // WezTerm and kitty name the pane Claude Code runs in; kitty sets the socket only with remote control on.
      weztermPane: env.WEZTERM_PANE ?? null,
      weztermSocket: env.WEZTERM_UNIX_SOCKET ?? null,
      kittyListenOn: env.KITTY_LISTEN_ON ?? null,
      kittyWindowId: env.KITTY_WINDOW_ID ?? null,
      claudePid: Number.isFinite(pid) && pid > 1 ? pid : null,
      entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
      // Set by `relay shell` (Zed's terminal): lets the helper type replies into this tab.
      pty: env.RELAY_PTY ?? null,
      ptyToken: env.RELAY_PTY_TOKEN ?? null,
    },
  });

  try {
    const res = await fetch("http://relay/hook", {
      method: "POST",
      unix: join(home, "hook.sock"),
      headers: { "content-type": "application/json" },
      body,
      // A prompt can stay open for hours: no client timeout for blocking events (Claude Code's own
      // hook timeout still applies). Bun's fetch has a default timeout unless disabled explicitly.
      ...(BLOCKING_EVENTS.has(event)
        ? { timeout: false }
        : { signal: AbortSignal.timeout(NON_BLOCKING_TIMEOUT_MS) }),
    } as BunFetchRequestInit);
    if (!res.ok) return;
    const reply = (await res.json()) as { stdout?: string };
    if (reply.stdout) await writeStdout(reply.stdout);
  } catch (err) {
    // ENOENT/ECONNREFUSED just means the daemon is not running; anything else is worth a trace.
    const message = err instanceof Error ? err.message : String(err);
    if (!/ENOENT|ECONNREFUSED|No such file|Was there a typo|FailedToOpenSocket/i.test(message)) {
      try {
        appendFileSync(join(home, "hook-errors.log"), `${new Date().toISOString()} ${event} ${message}\n`);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * `relay-hook statusline`: Claude Code's status line command (usage-left). Sends the JSON it was given to the
 * daemon, then runs the status line the person had before Relay (saved in statusline.json by `relay install`) with
 * the same input and prints its output unchanged. Same contract as the hooks: fail open.
 */
async function statusLine(): Promise<void> {
  const stdin = await Bun.stdin.text();
  const home = process.env.RELAY_HOME ?? join(homedir(), ".relay");
  if (process.env.RELAY_INTERNAL !== "1") {
    try {
      await fetch("http://relay/statusline", {
        method: "POST",
        unix: join(home, "hook.sock"),
        headers: { "content-type": "application/json" },
        body: stdin,
        signal: AbortSignal.timeout(1000),
      } as BunFetchRequestInit);
    } catch {
      // The daemon isn't running: the status line still works.
    }
  }
  let previous: string | null = null;
  try {
    const saved = JSON.parse(readFileSync(join(home, "statusline.json"), "utf8")) as {
      previous?: { command?: unknown };
    };
    if (typeof saved.previous?.command === "string") previous = saved.previous.command;
  } catch {
    // Nothing saved: Relay's own status line is empty.
  }
  if (!previous) return;
  const child = Bun.spawn(["/bin/sh", "-c", previous], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "inherit",
  });
  await writeStdout(await new Response(child.stdout).text());
  await child.exited;
}

await (process.argv[2] === "statusline" ? statusLine() : main()).catch(() => {});
process.exit(0);

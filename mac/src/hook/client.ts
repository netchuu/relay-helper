/**
 * relay-hook: the command Claude Code runs for every Relay hook event.
 *
 * Contract: FAIL OPEN. If the daemon is not running or anything goes wrong, print nothing and exit 0,
 * so Claude Code behaves exactly as if Relay were not installed. Keep this file dependency-free: it is
 * compiled to a standalone binary and its startup time is paid on every hook event.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BLOCKING_EVENTS = new Set(["PermissionRequest"]);
const NON_BLOCKING_TIMEOUT_MS = 5000;

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
    if (reply.stdout) process.stdout.write(reply.stdout);
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

await main().catch(() => {});
process.exit(0);

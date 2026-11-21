import { statSync } from "node:fs";
import type { SessionDirectory } from "../../../protocol/index.ts";
import { CHILD_PATH } from "../config.ts";
import { errMessage, log } from "../log.ts";
import type { DB } from "./db.ts";
import { notePhoneLaunch } from "./hooks.ts";
import { promptTextRead } from "./promptLine.ts";
import type { Registry } from "./registry.ts";
import { head } from "./text.ts";
import type { TerminalLauncher } from "./tmuxStart.ts";

/** How long a session started in a terminal may take to show its prompt. */
export const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;

/**
 * Starting a Claude Code session from the phone: `sessions.directories` lists the folders past sessions ran in,
 * `session.start` runs `claude --bg` in one of them, with a first message or empty.
 */

export class StartError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "unavailable",
    message: string,
    /** Set when `claude --bg` already ran and exited 0: Claude Code has the message, so the start is audited. */
    readonly launched?: { shortId?: string },
  ) {
    super(message);
  }
}

/** The longest the launch may take (`claude --bg` returns at once; this is for a stuck one). */
const START_TIMEOUT_MS = 30_000;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Past sessions' folders (ended ones too), one entry per folder, most recently used first. With `existing` (the
 * default) folders that are gone from the disk are left out.
 */
export function sessionDirectories(
  db: DB,
  { existing = true, exists = isDirectory }: { existing?: boolean; exists?: (path: string) => boolean } = {},
): SessionDirectory[] {
  const rows = db
    .query("SELECT cwd, project, updated_at FROM sessions ORDER BY updated_at DESC, started_at DESC")
    .all() as { cwd: string; project: string; updated_at: number }[];
  const seen = new Set<string>();
  const out: SessionDirectory[] = [];
  for (const r of rows) {
    if (!r.cwd || seen.has(r.cwd)) continue;
    seen.add(r.cwd);
    if (existing && !exists(r.cwd)) continue;
    out.push({ path: r.cwd, project: r.project, lastUsedAt: r.updated_at });
  }
  return out;
}

/** The command that starts the session: no permission flag of any kind, and the message after `--` as one argument. */
export function startCommand(claudeBin: string, text?: string): string[] {
  return text === undefined ? [claudeBin, "--bg"] : [claudeBin, "--bg", "--", text];
}

/**
 * `internal` marks the lookups the helper makes itself (relay-hook ignores those). The `--bg` launch is not marked:
 * the session, and any background service it starts, must keep reporting through the hooks, and they inherit this
 * environment.
 */
async function runClaude(
  cmd: string[],
  cwd: string,
  internal = false,
): Promise<{ out: string; err: string; code: number }> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: CHILD_PATH };
  if (internal) env.RELAY_INTERNAL = "1";
  else delete env.RELAY_INTERNAL;
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const timer = setTimeout(() => proc.kill(), START_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { out, err, code };
}

interface AgentEntry {
  id?: string;
  sessionId?: string;
  cwd?: string;
  name?: string;
}

/** The new session's full id and name, from the short id `claude --bg` printed. */
async function findSession(
  claudeBin: string,
  cwd: string,
  printed: string,
): Promise<{ sessionId: string; name: string | null } | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const { out, code } = await runClaude([claudeBin, "agents", "--json", "--all"], cwd, true);
      if (code === 0) {
        const list = JSON.parse(out) as AgentEntry[];
        const hit = list.find((a) => a.sessionId && (a.id === printed || a.sessionId.startsWith(printed)));
        if (hit?.sessionId) return { sessionId: hit.sessionId, name: hit.name ?? null };
      }
    } catch (err) {
      log.warn("session.start: claude agents failed", { err: errMessage(err) });
    }
    await Bun.sleep(300);
  }
  return null;
}

/** Claude Code's own words for why it refused, one short line (nothing of the message). */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return head(line.trim(), 200);
}

/** The command for a session in a terminal: its id is chosen here, so no lookup is needed afterwards. */
export function terminalCommand(claudeBin: string, sessionId: string, text?: string): string[] {
  // Panes get the server's environment: the lookups' marker must not be in it, and the PATH is the helper's.
  const env = ["env", "-u", "RELAY_INTERNAL", `PATH=${CHILD_PATH}`];
  return text === undefined
    ? [...env, claudeBin, "--session-id", sessionId]
    : [...env, claudeBin, "--session-id", sessionId, "--", text];
}

/**
 * Starts the session in a pane the helper can type into, so the phone's messages arrive as typed input. Returns
 * once the prompt is showing, so the first message from the phone never meets a session that isn't ready.
 */
async function startInTerminal(
  opts: StartOptions,
  terminal: TerminalLauncher,
  claudeBin: string,
  cwd: string,
): Promise<{ sessionId: string; name: string | null }> {
  const sessionId = crypto.randomUUID();
  const launch = opts.text === undefined ? null : notePhoneLaunch(cwd, opts.text);
  let pane: Awaited<ReturnType<TerminalLauncher["launch"]>>;
  try {
    pane = await terminal.launch(
      terminalCommand(claudeBin, sessionId, opts.text),
      cwd,
      `relay-${sessionId.slice(0, 8)}`,
    );
  } catch (err) {
    launch?.abort();
    log.warn("session.start: launch failed", { err: errMessage(err) });
    throw new StartError("unavailable", "Claude Code couldn't be started.");
  }
  const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  for (;;) {
    const seen = await terminal.look(pane).catch(() => null);
    if (seen && !seen.exited && promptTextRead(seen.screen) !== undefined) break;
    if (!seen || seen.exited) {
      launch?.abort();
      const why = seen ? firstLine(seen.screen) : "";
      log.warn("session.start: claude exited", { why });
      await terminal.close(pane).catch(() => {});
      throw new StartError(
        "unavailable",
        why ? `Claude Code couldn't start: ${why}` : "Claude Code couldn't be started.",
      );
    }
    if (Date.now() >= deadline) {
      // With a first message Claude Code has it already, so the session stays; without one nothing is lost.
      if (opts.text === undefined) {
        await terminal.close(pane).catch(() => {});
        throw new StartError("unavailable", "Claude Code didn't get ready in time.");
      }
      break;
    }
    await Bun.sleep(opts.pollMs ?? READY_POLL_MS);
  }
  await terminal.release(pane).catch(() => {});
  launch?.done(sessionId);
  const { created } = opts.registry.touch(sessionId, {
    cwd,
    kind: "interactive",
    env: { tmux: `${pane.socket},${pane.pid},0`, tmuxPane: pane.pane, claudePid: pane.pid },
  });
  if (created) opts.registry.publish(sessionId);
  if (opts.name) opts.registry.rename(sessionId, opts.name);
  return { sessionId, name: opts.name ?? null };
}

interface StartOptions {
  db: DB;
  registry: Registry;
  claudeBin: string | null | undefined;
  directory: string;
  /** Left out: the session starts empty. */
  text?: string;
  /** The phone's name for the session. */
  name?: string | null;
  /** Starts the session in a pane the helper types into; without it (no tmux) `claude --bg` runs it. */
  terminal?: TerminalLauncher | null;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export async function startSession(opts: StartOptions): Promise<{ sessionId: string; name: string | null }> {
  if (opts.text !== undefined && !opts.text.trim())
    throw new StartError("bad_request", "Write a first message to start a session.");
  if (!opts.claudeBin) throw new StartError("unavailable", "Claude Code wasn't found on this computer.");
  // Only a folder the helper would list itself, never an arbitrary path.
  const known = sessionDirectories(opts.db, { existing: false }).find((d) => d.path === opts.directory);
  if (!known) throw new StartError("not_found", "That folder isn't one of your past chats' folders.");
  if (!isDirectory(known.path))
    throw new StartError("not_found", "That folder no longer exists on this computer.");

  if (opts.terminal) return await startInTerminal(opts, opts.terminal, opts.claudeBin, known.path);

  // The first message is the phone's, not typing at the Mac: its hook may come before the session id is known.
  const launch = opts.text === undefined ? null : notePhoneLaunch(known.path, opts.text);
  let res: Awaited<ReturnType<typeof runClaude>>;
  try {
    res = await runClaude(startCommand(opts.claudeBin, opts.text), known.path);
  } catch (err) {
    launch?.abort();
    log.warn("session.start: launch failed", { err: errMessage(err) });
    throw new StartError("unavailable", "Claude Code couldn't be started.");
  }
  if (res.code !== 0) {
    launch?.abort();
    const why = firstLine(res.err) || firstLine(res.out);
    log.warn("session.start: claude exited", { code: res.code, why });
    throw new StartError(
      "unavailable",
      why ? `Claude Code couldn't start: ${why}` : "Claude Code couldn't be started.",
    );
  }
  const printed = /\b([0-9a-f]{8})\b/.exec(`${res.out}\n${res.err}`)?.[1];
  const found = printed ? await findSession(opts.claudeBin, known.path, printed) : null;
  if (!found) {
    // Claude Code did start it: the session's first message is still the phone's, not typing at the Mac.
    launch?.keep();
    throw new StartError("unavailable", "Claude Code started, but the new session wasn't found.", {
      ...(printed ? { shortId: printed } : {}),
    });
  }
  launch?.done(found.sessionId);
  const { created } = opts.registry.touch(found.sessionId, {
    cwd: known.path,
    name: found.name,
    kind: "background",
  });
  if (created) opts.registry.publish(found.sessionId);
  if (opts.name) opts.registry.rename(found.sessionId, opts.name);
  return found;
}

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type {
  BackgroundTask,
  Session,
  SessionKind,
  SessionStatus,
  TurnStep,
} from "../../../protocol/index.ts";
import { CHILD_PATH } from "../config.ts";
import { axAllowed, desktopTitle } from "../integrations/claudeDesktop.ts";
import { isIdeSessionSync } from "../integrations/ideExtension.ts";
import { errMessage, log } from "../log.ts";
import { backgroundOf } from "./background.ts";
import type { DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import { withoutIdeContext } from "./render.ts";
import { liveStep } from "./steps.ts";
import { transcriptLastActivity, transcriptPathFor } from "./transcript.ts";

/** A "busy" session that hasn't written to its transcript for this long counts as idle (left open). */
export const STALE_MS = 30 * 60_000;

interface SessionRow {
  id: string;
  name: string | null;
  custom_name: string | null;
  pinned_at: number | null;
  cwd: string;
  project: string;
  branch: string | null;
  kind: string;
  status: string;
  title: string | null;
  pid: number | null;
  terminal: string | null;
  tmux_pane: string | null;
  tmux_socket: string | null;
  socket_path: string | null;
  socket_token: string | null;
  pty_socket: string | null;
  pty_token: string | null;
  transcript: string | null;
  started_at: number;
  updated_at: number;
  ended_at: number | null;
  last_summary: string | null;
}

export interface SessionRecord extends Session {
  pid: number | null;
  tmuxPane: string | null;
  tmuxSocket: string | null;
  socketPath: string | null;
  socketToken: string | null;
  /** `relay shell`'s socket and token when the session runs in one (Zed's terminal). */
  ptySocket: string | null;
  ptyToken: string | null;
  transcript: string | null;
}

/** What the hook client reports about the Claude Code process it runs under. */
export interface HookEnv {
  socket?: string | null;
  token?: string | null;
  termProgram?: string | null;
  tmux?: string | null;
  tmuxPane?: string | null;
  claudePid?: number | null;
  entrypoint?: string | null;
  pty?: string | null;
  ptyToken?: string | null;
}

/**
 * Where Claude Code 2.1.316 binds a session's inbox socket, `<dir>/<pid>.sock`: under $XDG_RUNTIME_DIR when
 * it's set (Linux logins: /run/user/<uid>), otherwise the temp directory ($CLAUDE_CODE_TMPDIR or /tmp), with
 * a per-user `cc-socks-<uid>` variant. Read from the Linux binary; on the Mac it's /tmp/cc-socks.
 * Hooks report the real path, so this only matters for sessions found by `claude agents`.
 */
export function socketDirs(env: Record<string, string | undefined>, uid: number | undefined): string[] {
  const dirs = [
    env.XDG_RUNTIME_DIR && `${env.XDG_RUNTIME_DIR}/cc-socks`,
    uid !== undefined && `/run/user/${uid}/cc-socks`,
    env.CLAUDE_CODE_TMPDIR && `${env.CLAUDE_CODE_TMPDIR}/cc-socks`,
    "/tmp/cc-socks",
    uid !== undefined && `/tmp/cc-socks-${uid}`,
  ];
  return [...new Set(dirs.filter((d): d is string => Boolean(d)))];
}

export function defaultSocketPath(pid: number | null): string | null {
  if (!pid) return null;
  for (const dir of socketDirs(process.env, process.getuid?.())) {
    const p = `${dir}/${pid}.sock`;
    if (existsSync(p)) return p;
  }
  return null;
}

function toRecord(r: SessionRow): SessionRecord {
  const socketPath = r.socket_path ?? defaultSocketPath(r.pid);
  return {
    id: r.id,
    // A phone's name wins over Claude Code's everywhere (sync, events, push titles, CLI); Claude Code's stays
    // visible as originalName.
    name: r.custom_name ?? r.name,
    ...(r.custom_name ? { originalName: r.name } : {}),
    ...(r.pinned_at != null ? { pinnedAt: r.pinned_at } : {}),
    cwd: r.cwd,
    project: r.project,
    branch: r.branch,
    kind: (["interactive", "background"].includes(r.kind) ? r.kind : "unknown") as SessionKind,
    status: r.status as SessionStatus,
    title: r.title,
    terminal: r.terminal,
    canReceive: r.status !== "ended" && Boolean(socketPath || r.pty_socket || (r.tmux_pane && r.tmux_socket)),
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    lastSummary: r.last_summary,
    pid: r.pid,
    tmuxPane: r.tmux_pane,
    tmuxSocket: r.tmux_socket,
    socketPath,
    socketToken: r.socket_token,
    ptySocket: r.pty_socket ?? null,
    ptyToken: r.pty_token ?? null,
    transcript: r.transcript,
  };
}

/** The public view sent to clients: never includes socket tokens or local paths beyond cwd. */
export function publicSession(s: SessionRecord): Session {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    project: s.project,
    branch: s.branch,
    kind: s.kind,
    status: s.status,
    // Titles taken from an IDE prompt before its context was left out: what's left, or none.
    title: s.title === null ? null : withoutIdeContext(s.title) || null,
    terminal: s.terminal,
    canReceive: s.canReceive,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    lastSummary: s.lastSummary,
    ...(s.originalName !== undefined ? { originalName: s.originalName } : {}),
    ...(s.pinnedAt != null ? { pinnedAt: s.pinnedAt } : {}),
    ...stepOf(s),
    // An ended session runs nothing (its list is cleared right after this upsert goes out).
    ...(s.status === "ended" ? {} : backgroundField(s.id)),
    ...replyRouteOf(s),
  };
}

/**
 * How a reply sent now would arrive (desktop-ide-delivery): "typed" as the person's own input, or "labelled"
 * through the inbox. Absent when the session can't take replies at all.
 */
export function replyRouteOf(s: SessionRecord): {
  replyRoute?: "typed" | "labelled";
  replyFix?: "accessibility";
} {
  if (s.status === "ended") return {};
  if (s.ptySocket || (s.tmuxPane && s.tmuxSocket)) return { replyRoute: "typed" };
  if (process.platform !== "darwin") return s.socketPath ? { replyRoute: "labelled" } : {};
  if (s.terminal === "iTerm.app") return { replyRoute: "typed" };
  // The Claude desktop app and the editor extension: typed with Accessibility, which the phone can point to.
  const appSession = desktopTitle(s.id) !== null || isIdeSessionSync(transcriptPathFor(s));
  if (appSession && axAllowed()) return { replyRoute: "typed" };
  if (!s.socketPath) return {};
  return appSession ? { replyRoute: "labelled", replyFix: "accessibility" } : { replyRoute: "labelled" };
}

/** What still runs in the background (background-work); left out when nothing does. */
function backgroundField(id: string): { background?: BackgroundTask[] } {
  const tasks = backgroundOf(id);
  return tasks.length ? { background: tasks.map((t) => ({ ...t })) } : {};
}

/** The live step while the session works (turn-steps), so a phone that connects mid-turn sees it. */
function stepOf(s: SessionRecord): { step?: TurnStep } {
  if (s.status !== "working" && s.status !== "waiting") return {};
  const step = liveStep(s.id);
  return step ? { step } : {};
}

/** Pinned sessions first, newest pin first, like the phones; the rest keep their order. */
export function pinnedFirst<T extends Pick<Session, "pinnedAt">>(list: T[]): T[] {
  return [
    ...list.filter((s) => s.pinnedAt != null).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    ...list.filter((s) => s.pinnedAt == null),
  ];
}

export class Registry {
  constructor(
    private readonly db: DB,
    private readonly events: EventLog,
  ) {}

  get(id: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    return row ? toRecord(row) : null;
  }

  list(includeEnded = false): SessionRecord[] {
    const rows = this.db
      .query(
        includeEnded
          ? "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200"
          : "SELECT * FROM sessions WHERE status != 'ended' ORDER BY updated_at DESC",
      )
      .all() as SessionRow[];
    return rows.map(toRecord);
  }

  /** Creates or refreshes a session from any hook event. Returns the record and whether it is new. */
  touch(
    id: string,
    fields: { cwd?: string; transcript?: string; env?: HookEnv; name?: string | null; kind?: SessionKind },
    /** False for bookkeeping (the periodic reconcile), so "updated 20 s ago" means real activity. */
    activity = true,
  ): { session: SessionRecord; created: boolean } {
    const now = Date.now();
    const existing = this.get(id);
    const env = fields.env ?? {};
    const tmuxSocket = env.tmux ? (env.tmux.split(",")[0] ?? null) : null;
    if (!existing) {
      const cwd = fields.cwd ?? process.env.HOME ?? "/";
      this.db
        .query(
          `INSERT INTO sessions (id, name, cwd, project, kind, status, pid, terminal, tmux_pane, tmux_socket,
             socket_path, socket_token, pty_socket, pty_token, transcript, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fields.name ?? null,
          cwd,
          basename(cwd) || cwd,
          fields.kind ??
            (env.entrypoint === "sdk-ts" || env.entrypoint === "sdk-py" ? "background" : "unknown"),
          env.claudePid ?? null,
          env.termProgram ?? null,
          env.tmuxPane ?? null,
          tmuxSocket,
          env.socket ?? null,
          env.token ?? null,
          env.pty ?? null,
          env.ptyToken ?? null,
          fields.transcript ?? null,
          now,
          now,
        );
      void this.refreshGit(id, cwd);
      return { session: this.get(id) as SessionRecord, created: true };
    }
    // Only overwrite connection details when the hook actually reported them.
    this.db
      .query(
        `UPDATE sessions SET
           cwd = COALESCE(?, cwd),
           transcript = COALESCE(?, transcript),
           name = COALESCE(?, name),
           pid = COALESCE(?, pid),
           terminal = COALESCE(?, terminal),
           tmux_pane = COALESCE(?, tmux_pane),
           tmux_socket = COALESCE(?, tmux_socket),
           socket_path = COALESCE(?, socket_path),
           socket_token = COALESCE(?, socket_token),
           pty_socket = COALESCE(?, pty_socket),
           pty_token = COALESCE(?, pty_token),
           status = CASE WHEN status = 'ended' THEN 'idle' ELSE status END,
           ended_at = NULL,
           updated_at = CASE WHEN ? THEN ? ELSE updated_at END
         WHERE id = ?`,
      )
      .run(
        fields.cwd ?? null,
        fields.transcript ?? null,
        fields.name ?? null,
        env.claudePid ?? null,
        env.termProgram ?? null,
        env.tmuxPane ?? null,
        tmuxSocket,
        env.socket ?? null,
        env.token ?? null,
        env.pty ?? null,
        env.ptyToken ?? null,
        activity ? 1 : 0,
        now,
        id,
      );
    return { session: this.get(id) as SessionRecord, created: false };
  }

  /** The hooks recorded turns for this session and every one of them has ended. */
  private turnsAllEnded(sessionId: string): boolean {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(ended_at IS NULL), 0) AS open FROM turns WHERE session_id = ?",
      )
      .get(sessionId) as { n: number; open: number };
    return row.n > 0 && row.open === 0;
  }

  /**
   * Without `claude agents` (older Claude Code, or claude not found): a session whose process is gone has
   * ended, and one "working" with nothing written for half an hour was left open.
   */
  private sweep(): void {
    for (const s of this.list()) {
      if (s.pid && !processAlive(s.pid)) {
        this.setStatus(s.id, "ended");
        continue;
      }
      const { changed, lastActivity } = this.correctTimes(s, undefined);
      if (s.status === "working" && lastActivity !== null && Date.now() - lastActivity > STALE_MS)
        this.setStatus(s.id, "idle", { keepUpdatedAt: true });
      else if (changed) this.publish(s.id);
    }
  }

  /**
   * Started and last-active times from Claude Code itself: `claude agents` knows when a session started,
   * and the transcript when it last did something. Hooks only see what happens after Relay started.
   */
  private correctTimes(
    session: SessionRecord,
    startedAt: number | undefined,
  ): { changed: boolean; lastActivity: number | null } {
    const path = transcriptPathFor(session);
    const lastActivity = path ? transcriptLastActivity(path) : null;
    const started =
      startedAt && startedAt > 0 && startedAt < session.startedAt ? startedAt : session.startedAt;
    // The transcript is the truth for activity; a minute's slack avoids rewriting on every tick.
    const updated =
      lastActivity !== null && Math.abs(lastActivity - session.updatedAt) > 60_000
        ? lastActivity
        : session.updatedAt;
    if (started === session.startedAt && updated === session.updatedAt)
      return { changed: false, lastActivity };
    this.db
      .query("UPDATE sessions SET started_at = ?, updated_at = ? WHERE id = ?")
      .run(started, updated, session.id);
    return { changed: true, lastActivity };
  }

  setStatus(
    id: string,
    status: SessionStatus,
    extra?: { title?: string; lastSummary?: string; keepUpdatedAt?: boolean },
  ): void {
    const now = Date.now();
    this.db
      .query(
        `UPDATE sessions SET
           updated_at = CASE WHEN ? THEN updated_at WHEN status != ? OR ? IS NOT NULL THEN ? ELSE updated_at END,
           status = ?,
           title = COALESCE(title, ?),
           last_summary = COALESCE(?, last_summary),
           ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END
         WHERE id = ?`,
      )
      .run(
        extra?.keepUpdatedAt ? 1 : 0,
        status,
        extra?.lastSummary ?? null,
        now,
        status,
        extra?.title ?? null,
        extra?.lastSummary ?? null,
        status,
        now,
        id,
      );
    this.publish(id);
  }

  /** A phone's name for the session (null or empty clears it). Not activity: updatedAt stays. */
  rename(id: string, name: string | null): SessionRecord | null {
    if (!this.get(id)) return null;
    this.db.query("UPDATE sessions SET custom_name = ? WHERE id = ?").run(name?.trim() || null, id);
    this.publish(id);
    return this.get(id);
  }

  /**
   * Pin the session to the top of the Sessions list, or unpin it. Pinning a pinned session keeps its time, so it
   * doesn't jump. Not activity: updatedAt stays. Ended sessions keep their pin, and get it back when resumed.
   */
  pin(id: string, pinned: boolean, now = Date.now()): SessionRecord | null {
    if (!this.get(id)) return null;
    this.db
      .query(
        "UPDATE sessions SET pinned_at = CASE WHEN ? THEN COALESCE(pinned_at, ?) ELSE NULL END WHERE id = ?",
      )
      .run(pinned ? 1 : 0, now, id);
    this.publish(id);
    return this.get(id);
  }

  publish(id: string): void {
    const s = this.get(id);
    if (s) this.events.emit({ type: "session.upsert", session: publicSession(s) });
  }

  private async refreshGit(id: string, cwd: string): Promise<void> {
    try {
      const top = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
      const [toplevel, branch] = top.split("\n");
      this.db
        .query("UPDATE sessions SET project = ?, branch = ? WHERE id = ?")
        .run(toplevel ? basename(toplevel) : basename(cwd), branch && branch !== "HEAD" ? branch : null, id);
      this.publish(id);
    } catch {
      // Not a git repository; keep the directory name.
    }
  }

  /**
   * Reconciles with `claude agents --json`, which lists every live session (interactive and background)
   * including ones that started before Relay's hooks were installed.
   */
  async reconcile(claudeBin: string): Promise<void> {
    let live: {
      sessionId: string;
      pid?: number;
      cwd: string;
      kind?: string;
      name?: string;
      status?: string;
      /** Epoch ms; sessions found here (not through hooks) would otherwise get the time Relay saw them. */
      startedAt?: number;
    }[];
    try {
      live = JSON.parse(await run([claudeBin, "agents", "--json"], 15_000));
    } catch (err) {
      log.warn("reconcile: claude agents --json failed", { err: errMessage(err) });
      this.sweep();
      return;
    }
    const liveIds = new Set(live.map((s) => s.sessionId));
    for (const s of live) {
      const kind: SessionKind = s.kind === "background" ? "background" : "interactive";
      const { session, created } = this.touch(
        s.sessionId,
        {
          cwd: s.cwd,
          name: s.name ?? null,
          kind,
          env: { claudePid: s.pid ?? null },
        },
        false,
      );
      this.db.query("UPDATE sessions SET kind = ? WHERE id = ?").run(kind, s.sessionId);
      const times = this.correctTimes(session, s.startedAt);
      // "busy" with nothing written for half an hour is a session left open, not one working: it
      // belongs with the idle ones, not under Active.
      const stale = times.lastActivity !== null && Date.now() - times.lastActivity > STALE_MS;
      const reported: SessionStatus | null =
        s.status === "busy" ? "working" : s.status === "idle" ? "idle" : null;
      // Claude Code also says "busy" while background shells it started keep running after the turn ended (a dev
      // server, a watcher), with its prompt waiting for you. When the hooks recorded this session's turns and none
      // is open, it's idle; a background task finishing starts a turn of its own, which shows as working.
      const status = reported === "working" && (stale || this.turnsAllEnded(s.sessionId)) ? "idle" : reported;
      if (created || (status && session.status !== status && session.status !== "waiting")) {
        this.setStatus(s.sessionId, status ?? "idle", { keepUpdatedAt: true });
      } else if (times.changed) this.publish(s.sessionId);
    }
    for (const s of this.list()) {
      if (!liveIds.has(s.id)) this.setStatus(s.id, "ended");
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function run(cmd: string[], timeoutMs = 5000): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, PATH: CHILD_PATH, RELAY_INTERNAL: "1" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
  return out.trim();
}

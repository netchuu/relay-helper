import { BackgroundTask } from "../../../protocol/index.ts";
import type { EventLog } from "./events.ts";
import { redact } from "./redact.ts";
import { fitLabel, oneLine, shortCommand, stepFor } from "./steps.ts";
import { cutDetail } from "./timeline.ts";

/**
 * Background work: the shells and agents Claude left running, per session, from
 * Claude Code's own list in each Stop hook (`background_tasks`). A task leaves the list when its
 * `<task-notification>` arrives, when a later Stop no longer lists it, or when the session ends. An agent's tool
 * calls (hooks with its `agent_id`) give its current activity. In memory: after a restart it comes back at the next Stop.
 */

const lists = new Map<string, BackgroundTask[]>();

/** The session's background list, for `publicSession`. */
export function backgroundOf(sessionId: string): BackgroundTask[] {
  return lists.get(sessionId) ?? [];
}

/**
 * Whether the session still has background shells or agents running: the phones then show it as working and
 * the "finished" push waits until the last one ends. The session's own status stays idle (older phones show the
 * strip only), so this is the one place that says it.
 */
export function runsInBackground(sessionId: string): boolean {
  return (lists.get(sessionId)?.length ?? 0) > 0;
}

/** Tests only. */
export function resetBackground(): void {
  lists.clear();
}

interface RawTask {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  description?: unknown;
  command?: unknown;
  agent_type?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** The task id a `<task-notification>` prompt is about, or null. */
export function notifiedTaskId(prompt: string): string | null {
  if (!/^\s*<task-notification>/.test(prompt)) return null;
  return /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(prompt)?.[1] ?? null;
}

/** How many not-yet-listed agents per session keep their latest activity until a Stop lists them. */
const EARLY_KEPT = 16;

export class BackgroundTracker {
  private readonly throttleMs: number;
  /**
   * Activity of agents not listed yet: Claude starts a background agent, and its first tool calls can reach the
   * helper before the Stop that first lists it. Kept per session, by agent id, for that Stop.
   */
  private readonly early = new Map<string, Map<string, BackgroundTask["activity"]>>();
  private readonly lastSent = new Map<string, number>();
  private readonly trailing = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly events: EventLog,
    opts: { throttleMs?: number } = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 1000;
    events.subscribe((e) => {
      if (e.type === "session.upsert" && e.session.status === "ended") this.clear(e.session.id);
    });
  }

  /**
   * After a restart: each session's last list as the phones last saw it, so the helper and the phones agree (a dev
   * server usually keeps running while the helper restarts). The session's next Stop corrects it. Ended sessions and
   * entries that don't fit the protocol are left out; nothing is sent (the phones have it already).
   */
  restore(isLive: (sessionId: string) => boolean): void {
    for (const { sessionId, tasks } of this.events.latestBackground()) {
      if (!Array.isArray(tasks) || !isLive(sessionId)) continue;
      const kept = tasks.flatMap((t) => {
        const parsed = BackgroundTask.safeParse(t);
        return parsed.success ? [parsed.data] : [];
      });
      if (kept.length) lists.set(sessionId, kept);
    }
  }

  /** A Stop hook's `background_tasks`: the session's whole list now. Older Claude Code sends none: no change. */
  stopped(sessionId: string, raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const before = lists.get(sessionId) ?? [];
    const known = new Map(before.map((t) => [t.id, t]));
    const now = Date.now();
    const next: BackgroundTask[] = [];
    for (const item of raw as RawTask[]) {
      const id = str(item?.id);
      if (!id || (item.status !== undefined && item.status !== "running")) continue;
      if (next.some((t) => t.id === id)) continue;
      const shell = item.type === "shell";
      const command = shell ? str(item.command) : null;
      const description = str(item.description);
      // The command's first words; when those are empty (a command that starts with `|` or `&&`), the command on
      // one line; else the kind.
      const fromCommand = command
        ? fitLabel(shortCommand(redact(command))).trim() || fitLabel(oneLine(redact(command))).trim()
        : "";
      const title = description
        ? fitLabel(oneLine(redact(description)))
        : fromCommand || (shell ? "Shell" : "Agent");
      const old = known.get(id);
      const agentType = shell ? null : str(item.agent_type);
      const earlyActivity = shell ? undefined : this.early.get(sessionId)?.get(id);
      next.push({
        id,
        kind: shell ? "shell" : "agent",
        title,
        ...(command ? { detail: cutDetail(command) } : {}),
        ...(agentType ? { agentType } : {}),
        startedAt: old?.startedAt ?? now,
        ...(!shell && (old?.activity ?? earlyActivity) ? { activity: old?.activity ?? earlyActivity } : {}),
      });
    }
    this.early.delete(sessionId);
    this.set(sessionId, next);
  }

  /** A `<task-notification>` started a turn: that task finished. */
  notified(sessionId: string, prompt: string): void {
    const id = notifiedTaskId(prompt);
    const list = lists.get(sessionId);
    if (!id || !list?.some((t) => t.id === id)) return;
    this.set(
      sessionId,
      list.filter((t) => t.id !== id),
    );
  }

  /** A tool call inside a background agent (a hook with its `agent_id`): the agent's activity. */
  agentTool(
    sessionId: string,
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
    cwd: string | null,
    /** From a PostToolUse: only fills in an agent with no activity yet, so a call finishing never replaces a newer running one. */
    finished = false,
  ): void {
    const activity = { ...stepFor(toolName, input, cwd, "live"), at: Date.now() };
    const list = lists.get(sessionId);
    const task = list?.find((t) => t.id === agentId && t.kind !== "shell");
    if (!list || !task) {
      // Not listed yet (or a foreground subagent): remember it in case the next Stop lists this agent.
      if (list?.some((t) => t.id === agentId)) return;
      const early = this.early.get(sessionId) ?? new Map();
      if (finished && early.has(agentId)) return;
      early.delete(agentId);
      early.set(agentId, activity);
      while (early.size > EARLY_KEPT) early.delete(early.keys().next().value as string);
      this.early.set(sessionId, early);
      return;
    }
    if (task.activity?.label === activity.label || (finished && task.activity)) return;
    lists.set(
      sessionId,
      list.map((t) => (t === task ? { ...t, activity } : t)),
    );
    this.sendThrottled(sessionId);
  }

  /** The session ended: nothing of it runs any more. */
  clear(sessionId: string): void {
    this.early.delete(sessionId);
    if (lists.has(sessionId)) this.set(sessionId, []);
  }

  private set(sessionId: string, next: BackgroundTask[]): void {
    const before = lists.get(sessionId) ?? [];
    if (next.length) lists.set(sessionId, next);
    else lists.delete(sessionId);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    // A changed list goes out at once and carries any pending activity; only activity counts for the limit.
    this.cancelTrailing(sessionId);
    this.emit(sessionId);
  }

  private cancelTrailing(sessionId: string): void {
    const pending = this.trailing.get(sessionId);
    if (pending) clearTimeout(pending);
    this.trailing.delete(sessionId);
  }

  private sendThrottled(sessionId: string): void {
    const wait = (this.lastSent.get(sessionId) ?? 0) + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.send(sessionId);
      return;
    }
    if (this.trailing.has(sessionId)) return;
    this.trailing.set(
      sessionId,
      setTimeout(() => {
        this.trailing.delete(sessionId);
        this.send(sessionId);
      }, wait),
    );
  }

  private send(sessionId: string): void {
    this.cancelTrailing(sessionId);
    this.lastSent.set(sessionId, Date.now());
    this.emit(sessionId);
  }

  private emit(sessionId: string): void {
    // Only the newest list of a session matters (sync replays only that): drop the older ones as it goes out.
    this.events.deleteSessionBackground(sessionId);
    this.events.emit({
      type: "session.background",
      sessionId,
      tasks: backgroundOf(sessionId).map((t) => ({ ...t })),
    });
  }
}

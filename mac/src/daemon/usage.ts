import type { Usage, UsageLimit } from "../../../protocol/index.ts";

/**
 * What is left of the plan limits and of a session's context (usage-left), from the JSON Claude Code gives its
 * status line: `context_window.remaining_percentage` and `rate_limits.five_hour` / `.seven_day`
 * (`used_percentage`, `resets_at` in epoch seconds). Every part can be missing. In memory: it comes back at the next
 * status line refresh after a restart.
 */

const perSession = new Map<string, Usage>();
const lastLimits = new Map<string, Pick<Usage, "fiveHour" | "sevenDay">>();
/** Sessions whose context is full: Claude Code refuses their prompts until they are compacted or cleared. */
const full = new Set<string>();

/** What a turn that didn't fit the context says, in place of Claude Code's "Prompt is too long". */
export const CONTEXT_FULL = "This chat's context is full. Compact or clear it to continue.";

/**
 * Claude Code's error for a turn that didn't fit the context window. It comes as an `invalid_request`, a type
 * other errors share, so the text decides: the whole message, so an answer that merely starts with these words
 * isn't taken for it. `error` is absent when the turn wasn't reported as failed.
 */
export function isContextFullError(error: string | undefined, message: string, details = ""): boolean {
  if (error !== undefined && error !== "invalid_request") return false;
  if (/^\s*prompt is too long\.?\s*$/i.test(message)) return true;
  return error !== undefined && /\bprompt is too long\b/i.test(details);
}

/** Marks a session's context as full, or as usable again. True when that changed what the session shows. */
export function noteContextFull(sessionId: string, isFull: boolean): boolean {
  if (full.has(sessionId) === isFull) return false;
  if (isFull) full.add(sessionId);
  else full.delete(sessionId);
  return true;
}

export function contextIsFull(sessionId: string): boolean {
  return full.has(sessionId);
}
/** The plan's limits belong to the account, not a session: the newest ones seen, for a session that has none yet. */
let accountLimits: Pick<Usage, "fiveHour" | "sevenDay"> = {};
/** The session whose reading is kept for each window: a reading without a reset time is only as good as it is. */
const keptFrom: { fiveHour?: string; sevenDay?: string } = {};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const percent = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.min(100, Math.max(0, Math.round(n)));
};

function limitOf(raw: unknown): UsageLimit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const used = percent(r.used_percentage);
  if (used === null) return null;
  const at = num(r.resets_at);
  // Epoch seconds; a value that is already in milliseconds is kept.
  const resetsAt = at === null || at <= 0 ? undefined : at < 1e11 ? Math.round(at * 1000) : Math.round(at);
  return { usedPercent: used, ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** The usage in a status line payload, or null when it has none of the parts. */
export function parseUsage(payload: unknown): Usage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const context = (p.context_window ?? {}) as Record<string, unknown>;
  const limits = (p.rate_limits ?? {}) as Record<string, unknown>;
  const left = percent(context.remaining_percentage);
  const fiveHour = limitOf(limits.five_hour);
  const sevenDay = limitOf(limits.seven_day);
  if (left === null && !fiveHour && !sevenDay) return null;
  return {
    ...(left !== null ? { contextLeftPercent: left } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

/**
 * Which reading of one limit window to keep: the one with the later reset (a newer window), and within the same
 * window the higher percentage, since usage in a window only goes up. An idle session's stale reading, sent again
 * at every status line refresh, therefore changes nothing.
 */
function newer(
  kept: UsageLimit | undefined,
  seen: UsageLimit | undefined,
  previous: UsageLimit | undefined,
  now: number,
): UsageLimit | undefined {
  if (!kept) return seen;
  if (!seen) return kept;
  if (seen.resetsAt === undefined) {
    // No reset time: arrival order says nothing about age. A session that sends the same reading again is idle;
    // one whose reading changed is current, so it may go down. A kept reading whose reset has passed is stale.
    if (kept.resetsAt !== undefined) return kept.resetsAt <= now ? seen : kept;
    // A session's first reading is current, higher or lower: the kept one is older, or from a session that ended.
    if (previous === undefined) return seen;
    return previous.resetsAt === undefined && previous.usedPercent === seen.usedPercent ? kept : seen;
  }
  const a = kept.resetsAt ?? 0;
  const b = seen.resetsAt;
  if (b !== a) return b > a ? seen : kept;
  return seen.usedPercent > kept.usedPercent ? seen : kept;
}

/**
 * Remembers a session's usage and returns the sessions whose shown usage changed: this one, and the others when
 * the account's limits did (they are the account's, so every live session shows the newest reading).
 */
export function noteUsageAll(sessionId: string, usage: Usage | null): string[] {
  if (!usage) return [];
  const ids = new Set([...perSession.keys(), sessionId]);
  const before = new Map([...ids].map((id) => [id, JSON.stringify(usageOf(id) ?? null)]));
  // The session's last reading per window: a payload without a limit (context only) keeps what it had.
  const prev = lastLimits.get(sessionId) ?? {};
  lastLimits.set(sessionId, {
    ...((usage.fiveHour ?? prev.fiveHour) ? { fiveHour: usage.fiveHour ?? prev.fiveHour } : {}),
    ...((usage.sevenDay ?? prev.sevenDay) ? { sevenDay: usage.sevenDay ?? prev.sevenDay } : {}),
  });
  perSession.set(sessionId, usage);
  const now = Date.now();
  const fiveHour = newer(accountLimits.fiveHour, usage.fiveHour, prev.fiveHour, now);
  const sevenDay = newer(accountLimits.sevenDay, usage.sevenDay, prev.sevenDay, now);
  if (fiveHour !== accountLimits.fiveHour) keptFrom.fiveHour = sessionId;
  if (sevenDay !== accountLimits.sevenDay) keptFrom.sevenDay = sessionId;
  accountLimits = { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
  return [...ids].filter((id) => JSON.stringify(usageOf(id) ?? null) !== before.get(id));
}

/** Remembers a session's usage. True when it changed for that session (so the phones need an update). */
export function noteUsage(sessionId: string, usage: Usage | null): boolean {
  return noteUsageAll(sessionId, usage).includes(sessionId);
}

/** The session's usage for `publicSession`: its context, with the account's newest limits that still apply. */
export function usageOf(sessionId: string, now = Date.now()): Usage | undefined {
  const own = perSession.get(sessionId);
  // A full context is known from the failed turn, with or without a status line reading. The reading can lag
  // behind or be missing, so a full context says 0 left itself.
  const isFull = full.has(sessionId);
  if (!own && !isFull) return undefined;
  const live = (l: UsageLimit | undefined) =>
    l && (l.resetsAt === undefined || l.resetsAt > now) ? l : undefined;
  const fiveHour = live(accountLimits.fiveHour);
  const sevenDay = live(accountLimits.sevenDay);
  const out: Usage = {
    ...(isFull
      ? { contextLeftPercent: 0, contextFull: true as const }
      : own?.contextLeftPercent !== undefined
        ? { contextLeftPercent: own.contextLeftPercent }
        : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** A session ended: nothing more to show for it. */
export function forgetUsage(sessionId: string): void {
  perSession.delete(sessionId);
  lastLimits.delete(sessionId);
  full.delete(sessionId);
  // A kept reading without a reset time has no live session behind it any more: a new session's reading replaces it.
  for (const w of ["fiveHour", "sevenDay"] as const) {
    if (keptFrom[w] === sessionId && accountLimits[w]?.resetsAt === undefined) {
      delete accountLimits[w];
      delete keptFrom[w];
    }
  }
}

/** Tests only. */
export function resetUsage(): void {
  perSession.clear();
  lastLimits.clear();
  full.clear();
  accountLimits = {};
  delete keptFrom.fiveHour;
  delete keptFrom.sevenDay;
}

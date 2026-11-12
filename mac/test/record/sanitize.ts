import { redact } from "../../src/daemon/redact.ts";

/**
 * Turns what Claude Code wrote while recording into something that can be committed: only the entry types the
 * helper reads, only the fields it reads, every string through the helper's own `redact`, the scratch folder, the home
 * folder and the user name replaced, and the clock moved to a fixed start (offsets stay).
 */

export const FIXTURE_CWD = "/Users/me/Projects/scratch";
export const FIXTURE_HOME = "/Users/me";
export const FIXTURE_START = Date.parse("2026-11-09T10:00:00.000Z");

export interface Context {
  /** The scratch folder as recorded (all spellings: with and without /private). */
  cwds: string[];
  home: string;
  user: string;
  /** The recorded session's id, and the fixed one it becomes. */
  sessionId: string;
  fixedSessionId: string;
  /** The first timestamp of the recording: it becomes FIXTURE_START. */
  firstAt: number;
}

const KEEP_TOP = [
  "parentUuid",
  "isSidechain",
  "type",
  "subtype",
  "uuid",
  "timestamp",
  "isMeta",
  "cwd",
  "agentId",
  "durationMs",
  "messageCount",
  "version",
  "gitBranch",
  "imagePasteIds",
  "isApiErrorMessage",
];
const KEEP_MESSAGE = ["role", "content", "model", "id", "stop_reason"];
const TYPES = new Set(["user", "assistant", "system"]);

function scrubString(s: string, c: Context): string {
  let out = s;
  // Claude Code's own temp folder is named after the user id and the folder, in dashes ("-private-var-…").
  out = out.replace(/\/(?:private\/)?tmp\/claude-\d+/g, "/tmp/claude");
  for (const cwd of c.cwds) {
    out = out.split(cwd).join(FIXTURE_CWD);
    out = out.split(cwd.replace(/[/.]/g, "-")).join(FIXTURE_CWD.replace(/[/.]/g, "-"));
  }
  if (c.home) out = out.split(c.home).join(FIXTURE_HOME);
  if (c.user.length > 2) out = out.replace(new RegExp(`\\b${c.user}\\b`, "g"), "me");
  out = out.split(c.sessionId).join(c.fixedSessionId);
  // An email address, whatever it is.
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "me@example.com");
  return redact(out);
}

function scrub(value: unknown, c: Context): unknown {
  if (typeof value === "string") return scrubString(value, c);
  if (Array.isArray(value)) return value.map((v) => scrub(v, c));
  if (value && typeof value === "object")
    // A thinking block's signature is opaque and long: the helper never reads it.
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "signature")
        .map(([k, v]) => [k, scrub(v, c)]),
    );
  return value;
}

/** One transcript line; null when the helper doesn't read that kind of entry (or the line isn't JSON). */
export function sanitizeEntry(line: string, c: Context): string | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const type = raw.type;
  if (typeof type !== "string" || !TYPES.has(type)) return null;
  // System entries: only the turn bookkeeping the helper looks at.
  if (type === "system" && raw.subtype !== "turn_duration" && raw.subtype !== "stop_hook_summary")
    return null;
  const out: Record<string, unknown> = {};
  for (const k of KEEP_TOP) if (k in raw) out[k] = raw[k];
  if (raw.message && typeof raw.message === "object") {
    const m = raw.message as Record<string, unknown>;
    const msg: Record<string, unknown> = {};
    for (const k of KEEP_MESSAGE) if (k in m) msg[k] = m[k];
    out.message = msg;
  }
  out.sessionId = c.fixedSessionId;
  if (typeof out.timestamp === "string") {
    const t = Date.parse(out.timestamp);
    if (!Number.isNaN(t)) out.timestamp = new Date(FIXTURE_START + (t - c.firstAt)).toISOString();
  }
  return JSON.stringify(scrub(out, c));
}

export function sanitizeTranscript(text: string, c: Context): string {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((l) => sanitizeEntry(l, c))
    .filter((l): l is string => l !== null);
  return `${lines.join("\n")}\n`;
}

/** An agent's `agent-<id>.meta.json`. */
export function sanitizeMeta(text: string, c: Context): string {
  return `${JSON.stringify(scrub(JSON.parse(text), c), null, 2)}\n`;
}

/** The earliest timestamp in a transcript (ms), or now. */
export function firstTimestamp(text: string): number {
  let first = Number.POSITIVE_INFINITY;
  for (const line of text.split("\n")) {
    const m = /"timestamp":"([^"]+)"/.exec(line);
    const t = m ? Date.parse(m[1] as string) : Number.NaN;
    if (!Number.isNaN(t) && t < first) first = t;
  }
  return Number.isFinite(first) ? first : Date.now();
}

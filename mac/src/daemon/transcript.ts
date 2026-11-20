import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Turn, TurnStats, TurnStep } from "../../../protocol/index.ts";
import { PHONE_PREFIX } from "./inject.ts";
import { finishedMessages, messageFrom, type RawMessage, turnMessageFields } from "./messages.ts";
import { redact } from "./redact.ts";
import { compact, withoutIdeContext } from "./render.ts";
import { TranscriptSteps, timelineFields } from "./steps.ts";
import { isContextFullError } from "./usage.ts";

/** Past turns read (redacted, read-only) from Claude Code's transcript, for sessions Relay didn't record. */

// Read per call: Bun's homedir() ignores a HOME set after start, which tests rely on.
const projectsDir = () => join(process.env.HOME || homedir(), ".claude", "projects");
/** Large transcripts are read from the end: the recent turns are what the phone shows. */
const TAIL_BYTES = 6 * 1024 * 1024;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TRANSCRIPT_TURN_PREFIX = "tx:";

/** Where Claude Code keeps this session's transcript; null unless it is a file under ~/.claude/projects. */
export function transcriptPathFor(session: {
  id: string;
  cwd: string;
  transcript: string | null;
}): string | null {
  const candidates = [session.transcript];
  if (SESSION_ID.test(session.id)) {
    candidates.push(join(projectsDir(), session.cwd.replace(/[^A-Za-z0-9-]/g, "-"), `${session.id}.jsonl`));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const real = realpathSync(candidate);
      if (
        real.startsWith(`${realpathSync(projectsDir())}/`) &&
        real.endsWith(".jsonl") &&
        statSync(real).isFile()
      )
        return real;
    } catch {
      // Missing: try the next one.
    }
  }
  return null;
}

const activityCache = new Map<string, { mtimeMs: number; size: number; at: number | null }>();

/** Newest entry timestamp in the transcript (epoch ms); file times are unreliable, Claude Code sometimes touches all. Cached by size and mtime. */
export function transcriptLastActivity(path: string): number | null {
  try {
    const st = statSync(path);
    const cached = activityCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.at;
    const length = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, length, st.size - length);
    } finally {
      closeSync(fd);
    }
    let at: number | null = null;
    for (const m of buf.toString("utf8").matchAll(/"timestamp":"([^"]+)"/g)) {
      const t = Date.parse(m[1] as string);
      if (Number.isFinite(t) && (at === null || t > at)) at = t;
    }
    activityCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, at });
    return at;
  } catch {
    return null;
  }
}

interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

interface Draft {
  uuid: string;
  prompt: string;
  startedAt: number;
  endedAt: number;
  text: string;
  toolCalls: number;
  files: Set<string>;
  /** The turn ended with Claude Code's interrupt marker (Esc, or a deny-and-interrupt). */
  stopped: boolean;
  steps: TranscriptSteps;
  /** Everything Claude wrote (live-messages); the last is the answer when it is `text`. */
  messages: RawMessage[];
}

/** A transcript line as an entry; null for a line that isn't JSON or parses to something else than an object (`null`, `42`, `[]`). */
function parseEntry(line: string): Entry | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Entry) : null;
  } catch {
    return null;
  }
}

/** The user entry Claude Code writes on interrupt ("[Request interrupted by user]", or "... for tool use"); no hook marks it. */
const INTERRUPT_MARKER = "[Request interrupted by user";

function entryText(entry: Entry): string | null {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((b) => b?.type === "text").map((b) => String(b.text ?? ""));
    if (parts.length) return parts.join("\n");
  }
  return null;
}

/**
 * True when the last thing said in the main conversation since `since` is Claude Code's error that the prompt
 * didn't fit the context. Claude Code can end such a turn without a Stop hook, so the transcript is the only sign.
 */
export function endedContextFull(path: string, since: number): boolean {
  let lines: string[];
  try {
    lines = readTail(path).split("\n");
  } catch {
    return false;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = lines[i] ? (parseEntry(lines[i] as string) as (Entry & ApiError) | null) : null;
    if (!entry || entry.isSidechain || (entry.type !== "assistant" && entry.type !== "user")) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isNaN(ts) || ts < since - 10_000) return false;
    if (entry.type === "user" && entry.isMeta) continue;
    return (
      entry.type === "assistant" &&
      entry.isApiErrorMessage === true &&
      isContextFullError(entry.error ?? "unknown", entryText(entry) ?? "")
    );
  }
  return false;
}

interface ApiError {
  isApiErrorMessage?: boolean;
  error?: string;
}

/** The last entries a turn writes: Claude's messages, the interrupt marker, Claude Code's turn bookkeeping. */
function endsEarlierTurn(entry: Entry & { subtype?: string }): boolean {
  if (entry.isSidechain) return false;
  if (entry.type === "assistant" || isInterruptMarker(entry)) return true;
  return (
    entry.type === "system" && (entry.subtype === "turn_duration" || entry.subtype === "stop_hook_summary")
  );
}

/** A prompt for comparing with its transcript entry: without the phone's line and peer header, spaces collapsed. */
function comparable(text: string): string {
  return text
    .replace(/^\s*Another Claude session sent a message:\s*/, "")
    .replace(PHONE_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isInterruptMarker(entry: Entry): boolean {
  if (entry.type !== "user" || entry.isSidechain) return false;
  return entryText(entry)?.trim().startsWith(INTERRUPT_MARKER) ?? false;
}

/**
 * Which of `turns` (unanswered, oldest first) `answer` answers, by transcript order: the newest whose prompt stands before it.
 * Null: no prompt among them precedes it; undefined: no evidence yet, so the open turn keeps the answer.
 */
export function answerOwner(
  path: string,
  answer: string,
  turns: { id: string; prompt: string | null; startedAt: number }[],
): string | null | undefined {
  const wanted = answer.trim();
  const newest = turns.at(-1);
  if (!wanted || !newest?.prompt) return undefined;
  let entries: (Entry & { attachment?: { type?: string; prompt?: unknown } })[];
  try {
    entries = readTail(path)
      .split("\n")
      .flatMap((line) => {
        const entry = line ? parseEntry(line) : null;
        return entry ? [entry] : [];
      });
  } catch {
    return undefined;
  }
  const answerAt = entries.findLastIndex((entry) => {
    if (entry.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content))
      return false;
    return (entry.message.content as { type?: string; text?: string }[]).some(
      (block) => block.type === "text" && block.text?.trim() === wanted,
    );
  });
  if (answerAt < 0) return undefined;
  // Only from the last prompt before the answer (or an earlier turn's end): old entries with the same words ("continue") must not match.
  let from = 0;
  for (let i = answerAt - 1; i >= 0; i--) {
    const entry = entries[i] as Entry & { subtype?: string };
    const closed =
      entry.type === "system" && (entry.subtype === "turn_duration" || entry.subtype === "stop_hook_summary");
    if (closed) from = i + 1;
    else if (promptText(entry) !== null) from = i;
    else continue;
    break;
  }
  // A prompt is its own user entry, or the queued command attached to the running turn.
  const written = (entry: (typeof entries)[number]): string | null => {
    const queued = entry.type === "attachment" && entry.attachment?.type === "queued_command";
    const text = queued ? entry.attachment?.prompt : promptText(entry);
    if (typeof text !== "string" || (queued && isSystemMessage(text.trim()))) return null;
    return sameWords(redact(text));
  };
  // Same words; one may carry more after them (attached file paths).
  const matches = (asked: string, text: string) =>
    text === asked || text.startsWith(`${asked} `) || asked.startsWith(`${text} `);
  // Oldest first, each turn takes the first unclaimed entry before the answer, written since its hook (seconds of clock slack) or untimed.
  const taken = new Set<number>();
  let owner: string | null = null;
  let queued = false;
  for (const turn of turns) {
    const asked = turn.prompt ? sameWords(redact(turn.prompt)) : "";
    if (!asked) {
      // A turn begun on a notice has no prompt to look for: it was running before any prompt that still waits.
      if (!queued) owner = turn.id;
      continue;
    }
    const own = entries.findIndex((entry, i) => {
      if (i < from || i >= answerAt || taken.has(i)) return false;
      const text = written(entry);
      if (text === null || !matches(asked, text)) return false;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      return Number.isNaN(at) || at >= turn.startedAt - 5000;
    });
    if (own >= 0) {
      taken.add(own);
      owner = turn.id;
    } else if (
      entries.slice(answerAt + 1).some((entry) => {
        const text = promptText(entry);
        return text !== null && matches(asked, sameWords(redact(text)));
      })
    ) {
      queued = true;
    }
  }
  if (owner === newest.id) return owner;
  // Only with a waiting prompt's entry after the answer: otherwise the transcript may just be behind.
  return queued ? owner : undefined;
}

/** A prompt for comparing the hook's text with the transcript's: `comparable`, without image markers. */
function sameWords(text: string): string {
  const plain = comparable(text);
  const words = plain
    .replace(/\[Image[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words || plain;
}

/**
 * What the turn started at `since` (epoch ms) left in the transcript; null when unreadable.
 * Anchored on its prompt entry, not a time window: turns can start within a second of the previous one's end.
 */
export function interruptedTurn(
  path: string,
  since: number,
  /** Nothing after this (epoch ms): when the inbox stop message cut the turn off, what follows is the next turn. */
  until = Number.POSITIVE_INFINITY,
  /** The session's folder, for the steps' file paths (turn-steps). */
  cwd: string | null = null,
  /** The turn's prompt as recorded (redacted); null when unknown, then the nearest typed prompt anchors it. */
  prompt: string | null = null,
): {
  interrupted: boolean;
  text: string;
  toolCalls: number;
  files: string[];
  endedAt: number | null;
  steps: TurnStep[];
  /** The turn's thinking lines (turn-timeline). */
  thoughts: TurnStep[];
  /** Everything Claude wrote in the turn (live-messages); the last is the answer when it is `text`. */
  messages: RawMessage[];
  /** The last entry is Claude's finished answer with nothing after it (no interrupt marker); `lastAt` is when it was written. */
  finished: boolean;
  lastAt: number | null;
} | null {
  let lines: string[];
  try {
    lines = readTail(path).split("\n");
  } catch {
    return null;
  }
  const entries: { entry: Entry; ts: number }[] = [];
  // Wide enough for clock differences between the hook and Claude Code; the anchor decides, not the window.
  const from = since - 10_000;
  for (const line of lines) {
    if (!line) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isNaN(ts) && ts >= from) entries.push({ entry, ts });
  }
  const empty = {
    interrupted: false,
    text: "",
    toolCalls: 0,
    files: [],
    endedAt: null,
    steps: [],
    thoughts: [],
    messages: [],
    finished: false,
    lastAt: null,
  };
  // Entries up to the previous turn's last belong to it, so its prompt can't anchor this one even with the same text.
  let boundary = -1;
  entries.forEach(({ entry, ts }, i) => {
    if (ts < since && endsEarlierTurn(entry)) boundary = i;
  });
  const wanted = prompt === null ? null : comparable(prompt);
  // A turn Claude Code started itself (background notification) has an empty prompt; a typed prompt would be the next turn's.
  const systemTurn = prompt !== null && prompt.trim() === "";
  let anchor = -1;
  for (let i = boundary + 1; i < entries.length && anchor === -1; i++) {
    const entry = (entries[i] as { entry: Entry }).entry;
    if (entry.type !== "user" || entry.isSidechain || isInterruptMarker(entry)) continue;
    const own = entryText(entry);
    if (own === null) continue;
    if (
      systemTurn
        ? isSystemMessage(own)
        : wanted
          ? comparable(redact(own)).includes(wanted)
          : promptText(entry) !== null
    )
      anchor = i;
  }
  // No prompt entry yet: only what came after the previous turn and this one's start counts.
  let rest: { entry: Entry; ts: number }[];
  if (anchor === -1) {
    rest = entries.slice(boundary + 1).filter(({ ts }) => ts >= since);
    if (!rest.length) return empty;
  } else rest = entries.slice(anchor + 1);

  let interrupted = false;
  let text = "";
  let endedAt: number | null = null;
  const files = new Set<string>();
  const steps = new TranscriptSteps(
    cwd,
    anchor === -1 ? since : ((entries[anchor] as { ts: number }).ts ?? since),
    path,
  );
  const messages: RawMessage[] = [];
  let finished = false;
  let lastAt: number | null = null;
  for (const { entry, ts } of rest) {
    if (ts > until) break;
    if (isInterruptMarker(entry)) {
      interrupted = true;
      endedAt = ts;
      finished = false;
      continue;
    }
    // The next prompt is a new turn (one queued at the computer starts as soon as Esc stops this one).
    if (promptText(entry) !== null) break;
    if ((entry.type === "assistant" || entry.type === "user") && !entry.isSidechain) {
      finished = isFinishedAnswer(entry);
      lastAt = ts;
    }
    steps.add(entry);
    const message = messageFrom(entry, since);
    if (message) messages.push(message);
    if (entry.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    const blocks = entry.message.content as {
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[];
    const texts = blocks.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text as string);
    if (texts.length) text = texts.join("\n\n");
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const file = block.input?.file_path ?? block.input?.notebook_path;
      if (block.name && EDIT_TOOLS.has(block.name) && typeof file === "string") files.add(file);
    }
  }
  return {
    interrupted,
    text,
    toolCalls: steps.steps.length,
    files: [...files],
    endedAt,
    steps: steps.steps,
    thoughts: steps.thoughts,
    messages,
    finished,
    lastAt,
  };
}

/** An assistant entry that ends the turn: it has text and no tool call, and Claude Code didn't say it goes on. */
function isFinishedAnswer(entry: Entry): boolean {
  if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return false;
  const reason = (entry.message as { stop_reason?: string | null }).stop_reason;
  if (reason === "tool_use" || reason === "pause_turn") return false;
  const blocks = entry.message.content as { type?: string; text?: string }[];
  if (blocks.some((b) => b.type === "tool_use")) return false;
  return blocks.some((b) => b.type === "text" && b.text?.trim());
}

function readTail(path: string): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // Drop the partial first line when reading from the middle.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/**
 * A message Claude Code inserts itself (command echoes, reminders, notifications, other sessions' or agents' messages).
 * Phone replies use the same inbox but start with the phone's own line, so they stay yours.
 */
export function isSystemMessage(text: string): boolean {
  const body = text.trim().replace(/^Another Claude session sent a message:\s*/, "");
  return /^<(command-|local-command|system-reminder|task-notification|cross-session-message|agent-message)/.test(
    body,
  );
}

/** The text of a genuine prompt you typed, or null for tool results, meta entries and slash commands. */
function promptText(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const text = entryText(entry);
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || isSystemMessage(trimmed)) return null;
  // Claude Code's note that the turn was interrupted, not something you typed.
  if (trimmed.startsWith(INTERRUPT_MARKER)) return null;
  return trimmed;
}

function draftsFrom(path: string, cwd: string | null = null): Draft[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const line of readTail(path).split("\n")) {
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // A line like `null` parses but isn't an entry.
    if (!entry) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (current && isInterruptMarker(entry)) {
      current.stopped = true;
      if (!Number.isNaN(ts)) current.endedAt = ts;
      continue;
    }
    const prompt = promptText(entry);
    if (prompt !== null) {
      current = {
        uuid: entry.uuid ?? String(drafts.length),
        prompt,
        startedAt: Number.isNaN(ts) ? 0 : ts,
        endedAt: Number.isNaN(ts) ? 0 : ts,
        text: "",
        toolCalls: 0,
        files: new Set(),
        stopped: false,
        steps: new TranscriptSteps(cwd, Number.isNaN(ts) ? null : ts, path),
        messages: [],
      };
      drafts.push(current);
      continue;
    }
    if (current && entry.type === "user") current.steps.add(entry);
    if (!current || entry.type !== "assistant" || entry.isSidechain || !Array.isArray(entry.message?.content))
      continue;
    current.steps.add(entry);
    const message = messageFrom(entry);
    if (message) current.messages.push(message);
    if (!Number.isNaN(ts)) current.endedAt = ts;
    const blocks = entry.message.content as {
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[];
    const texts = blocks.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text as string);
    // Claude's answer is its last text; earlier texts were narration between tool calls.
    if (texts.length) current.text = texts.join("\n\n");
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      current.toolCalls++;
      const file = block.input?.file_path ?? block.input?.notebook_path;
      if (block.name && EDIT_TOOLS.has(block.name) && typeof file === "string") current.files.add(file);
    }
  }
  return drafts;
}

function toTurn(sessionId: string, d: Draft, previewChars: number): Turn {
  const full = redact(d.text);
  const { text: summary, truncated } = compact(full, previewChars);
  const stats: TurnStats = {
    durationMs: d.endedAt > d.startedAt ? d.endedAt - d.startedAt : null,
    toolCalls: d.steps.steps.length,
    filesEdited: [...d.files],
  };
  const timeline = timelineFields(d.steps.steps, d.steps.thoughts);
  const messages = turnMessageFields(finishedMessages(d.messages, d.text));
  return {
    id: `${TRANSCRIPT_TURN_PREFIX}${sessionId}:${d.uuid}`,
    sessionId,
    prompt: redact(withoutIdeContext(d.prompt)),
    summary,
    fullLength: full.length,
    truncated,
    stats,
    failed: false,
    startedAt: d.startedAt || null,
    endedAt: d.endedAt,
    ...(d.stopped ? { stopped: true } : {}),
    ...timeline,
    ...messages,
  };
}

/** Transcript turns minus those already recorded without a start (`startless`), matched by the same answer ending within ten seconds before. */
export function withoutRecordedCopies(
  turns: Turn[],
  startless: { summary: string | null; ended_at: number }[],
): Turn[] {
  return turns.filter(
    (t) =>
      !startless.some(
        (r) => r.summary === t.summary && r.ended_at >= t.endedAt && r.ended_at - t.endedAt < 10_000,
      ),
  );
}

/** Finished turns (answered with text), newest first; the newest is left out while the session works. */
export function transcriptTurns(
  sessionId: string,
  path: string,
  opts: { limit: number; previewChars: number; working: boolean; before?: number; cwd?: string | null },
): Turn[] {
  let drafts: Draft[];
  try {
    drafts = draftsFrom(path, opts.cwd ?? null);
  } catch {
    return [];
  }
  if (opts.working) drafts = drafts.slice(0, -1);
  return drafts
    .filter((d) => (d.text || d.stopped) && (opts.before === undefined || d.endedAt < opts.before))
    .slice(-opts.limit)
    .reverse()
    .map((d) => toTurn(sessionId, d, opts.previewChars));
}

/** The full (redacted) answer of a transcript turn, for `turn.full`. */
export function transcriptTurnText(path: string, uuid: string): string | null {
  try {
    const draft = draftsFrom(path).find((d) => d.uuid === uuid);
    return draft ? redact(draft.text) : null;
  } catch {
    return null;
  }
}

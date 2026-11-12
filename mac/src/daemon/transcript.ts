import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Turn, TurnStats, TurnStep } from "../../../protocol/index.ts";
import { PHONE_PREFIX } from "./inject.ts";
import { finishedMessages, messageFrom, type RawMessage, turnMessageFields } from "./messages.ts";
import { redact } from "./redact.ts";
import { compact, withoutIdeContext } from "./render.ts";
import { TranscriptSteps, timelineFields } from "./steps.ts";

/**
 * Past turns read from Claude Code's own transcript (~/.claude/projects/<cwd>/<session>.jsonl), for
 * sessions whose turns Relay didn't record: they started before Relay's hooks were installed, or
 * finished while the daemon was down. Read-only; the same redaction applies as for recorded turns.
 */

const PROJECTS = join(homedir(), ".claude", "projects");
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
    candidates.push(join(PROJECTS, session.cwd.replace(/[^A-Za-z0-9-]/g, "-"), `${session.id}.jsonl`));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const real = realpathSync(candidate);
      if (real.startsWith(`${realpathSync(PROJECTS)}/`) && real.endsWith(".jsonl") && statSync(real).isFile())
        return real;
    } catch {
      // Missing: try the next one.
    }
  }
  return null;
}

const activityCache = new Map<string, { mtimeMs: number; size: number; at: number | null }>();

/**
 * When the session last did anything: the newest entry timestamp in its transcript (epoch ms). File
 * times can't be used: Claude Code touches every transcript at once in some cases. Read from the last
 * 64 KB and cached by file size and time, so the 20 s reconcile costs one stat per session.
 */
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

/**
 * What Claude Code writes into the transcript as a user entry when a turn is interrupted: Esc gives
 * "[Request interrupted by user]" (sometimes with a newline after it), a deny-and-interrupt or Esc during a tool
 * "[Request interrupted by user for tool use]". Checked with 2.1.318. No hook event marks an interrupt.
 */
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

/** The last entries a turn writes: Claude's messages, the interrupt marker, Claude Code's turn bookkeeping. */
function endsEarlierTurn(entry: Entry & { subtype?: string }): boolean {
  if (entry.isSidechain) return false;
  if (entry.type === "assistant" || isInterruptMarker(entry)) return true;
  return (
    entry.type === "system" && (entry.subtype === "turn_duration" || entry.subtype === "stop_hook_summary")
  );
}

/**
 * A prompt as it can be compared with its transcript entry: without the phone's line and Claude Code's peer
 * header, which every inbox message shares, and with spaces collapsed.
 */
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
 * What the turn that started at `since` (epoch ms) left in the transcript: whether it was interrupted, and
 * Claude's last text and stats so far. Null when the file can't be read.
 *
 * Anchored on the turn's own prompt entry (the user entry nearest `since` whose text has `prompt` in it), not
 * on a time window: a turn can start within a second of the previous one's marker and text (a message queued at
 * the computer, which Esc submits at once; the turn the inbox stop message starts). Without that entry, only
 * entries from `since` on count.
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
    try {
      const entry = JSON.parse(line) as Entry;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      if (!Number.isNaN(ts) && ts >= from) entries.push({ entry, ts });
    } catch {
      // not JSON
    }
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
  };
  // Everything up to the previous turn's last entry belongs to that turn, so its prompt entry can never anchor
  // this one, even with the same text ("continue" twice, or two messages from the phone).
  let boundary = -1;
  entries.forEach(({ entry, ts }, i) => {
    if (ts < since && endsEarlierTurn(entry)) boundary = i;
  });
  const wanted = prompt === null ? null : comparable(prompt);
  // A turn Claude Code started itself (a background task's notification) is recorded with an empty prompt: its
  // entry is the system message, not a typed prompt (which would be the next turn's).
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
  // No prompt entry yet (not written, or a transcript without one): only what came after the previous turn
  // and after this one started counts.
  let rest: { entry: Entry; ts: number }[];
  if (anchor === -1) {
    rest = entries.slice(boundary + 1).filter(({ ts }) => ts >= since);
    if (!rest.length) return empty;
  } else rest = entries.slice(anchor + 1);

  let interrupted = false;
  let text = "";
  let toolCalls = 0;
  let endedAt: number | null = null;
  const files = new Set<string>();
  const steps = new TranscriptSteps(
    cwd,
    anchor === -1 ? since : ((entries[anchor] as { ts: number }).ts ?? since),
    path,
  );
  const messages: RawMessage[] = [];
  for (const { entry, ts } of rest) {
    if (ts > until) break;
    if (isInterruptMarker(entry)) {
      interrupted = true;
      endedAt = ts;
      continue;
    }
    // The next prompt is a new turn (one queued at the computer starts as soon as Esc stops this one).
    if (promptText(entry) !== null) break;
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
      toolCalls++;
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
  };
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
 * A message Claude Code puts in the conversation itself, not something you typed: slash-command echoes, local
 * command output, system reminders, background-task notifications, and messages from another Claude session or
 * agent (`<cross-session-message …>`, `<agent-message …>`, after the inbox's "Another Claude session sent a
 * message:" line). Replies from the phone come through the same inbox but start with the phone's own line, so
 * they stay yours.
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

/**
 * Finished turns from the transcript, newest first. A turn counts as finished once Claude answered with
 * text; the newest one is left out while the session is still working on it.
 */
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

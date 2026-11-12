import { readFileSync } from "node:fs";
import type { TurnStats, TurnStep } from "../../../protocol/index.ts";
import { messageFrom, type RawMessage } from "./messages.ts";
import { TranscriptSteps } from "./steps.ts";
import { isSystemMessage } from "./transcript.ts";

export interface Compact {
  text: string;
  truncated: boolean;
}

/**
 * Compact preview of an assistant message: whole paragraphs up to `maxChars`, never cutting inside a
 * fenced code block or a word. The full text stays available through `turn.full`.
 */
export function compact(full: string, maxChars: number): Compact {
  const text = full
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return { text, truncated: false };

  const blocks = splitBlocks(text);
  let out = "";
  for (const block of blocks) {
    const candidate = out ? `${out}\n\n${block}` : block;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (!out) {
    // First block alone is too long: cut at a word boundary (close an open code fence if needed).
    const first = blocks[0] ?? text;
    let cut = first.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.6) cut = cut.slice(0, lastSpace);
    out = closeOpenFence(cut);
  }
  return { text: `${out.trimEnd()} …`, truncated: true };
}

/**
 * The code fence open after `line`, given the one open before it (CommonMark): a fence opens with a line of three
 * or more backticks or tildes (a backtick fence's info string has no backtick) and closes
 * with a line of the same character, at least as long, with nothing after it.
 */
export function fenceAfter(open: string | null, line: string): string | null {
  // Any indent: inside a list item a fence sits deeper than CommonMark's three spaces outside lists.
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return open;
  const fence = m[1] as string;
  const info = m[2] as string;
  if (open === null) return fence.startsWith("`") && info.includes("`") ? null : fence;
  return fence[0] === open[0] && fence.length >= open.length && !info.trim() ? null : open;
}

/** Closes a code fence left open at the end of a cut text, with a line like its opening one. */
export function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split("\n")) open = fenceAfter(open, line);
  return open ? `${text}\n${open}` : text;
}

/** Splits Markdown into paragraphs while keeping fenced code blocks intact. */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let open: string | null = null;
  for (const line of text.split("\n")) {
    open = fenceAfter(open, line);
    if (open === null && line.trim() === "") {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

/** One line for notification titles/bodies: first non-empty line without Markdown decoration. */
export function firstLine(text: string, max = 140): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^(```|~~~|---|\|)/.test(l)) ?? "";
  const plain = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Stats for the latest turn, read from the session transcript (JSONL): tool calls and edited files
 * since the last real user prompt. The transcript is written asynchronously, so callers should read it
 * shortly after Stop and treat the result as best effort.
 */
export function turnStatsFromTranscript(transcriptPath: string, startedAt: number | null): TurnStats {
  return (
    turnFromTranscript(transcriptPath, startedAt, null)?.stats ?? {
      durationMs: startedAt ? Date.now() - startedAt : null,
      toolCalls: 0,
      filesEdited: [],
    }
  );
}

/**
 * Stats, steps (turn-steps) and messages (live-messages, the answer included) of the latest turn, from one read
 * of the transcript; null when it can't be read. Steps and `toolCalls` count the same tool_use blocks, so
 * "14 steps" and the list agree.
 */
export function turnFromTranscript(
  transcriptPath: string,
  startedAt: number | null,
  cwd: string | null,
): { stats: TurnStats; steps: TurnStep[]; thoughts: TurnStep[]; messages: RawMessage[] } | null {
  const stats: TurnStats = {
    durationMs: startedAt ? Date.now() - startedAt : null,
    toolCalls: 0,
    filesEdited: [],
  };
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return null;
  }
  // Walk backwards to the last genuine user prompt.
  const entries: unknown[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isUserPrompt(entry)) break;
    entries.push(entry);
  }
  const files = new Set<string>();
  const steps = new TranscriptSteps(cwd, startedAt, transcriptPath);
  const messages: RawMessage[] = [];
  for (const entry of [...entries].reverse()) {
    steps.add(entry as Parameters<TranscriptSteps["add"]>[0]);
    // Not before the turn started: the previous turn's last text can be flushed after this prompt.
    const m = messageFrom(entry, startedAt ?? undefined);
    if (m) messages.push(m);
  }
  for (const entry of entries) {
    const message = (entry as { type?: string; message?: { content?: unknown } }).message;
    // A subagent's calls (sidechain) aren't the turn's steps; the count matches the list.
    const e = entry as { type?: string; isSidechain?: boolean };
    if (e.type !== "assistant" || e.isSidechain || !Array.isArray(message?.content)) continue;
    for (const block of message.content as {
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }[]) {
      if (block.type !== "tool_use") continue;
      stats.toolCalls++;
      const filePath = block.input?.file_path ?? block.input?.notebook_path;
      if (block.name && EDIT_TOOLS.has(block.name) && typeof filePath === "string") files.add(filePath);
    }
  }
  stats.filesEdited = [...files];
  // A tool call written twice is one step; the count follows the list (turn-timeline).
  stats.toolCalls = steps.steps.length;
  return { stats, steps: steps.steps, thoughts: steps.thoughts, messages };
}

function isUserPrompt(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  // A notice Claude Code adds itself (a background task finishing) isn't a prompt: taken in mid-turn, it doesn't
  // end the turn being read.
  if (typeof content === "string") return !isSystemMessage(content);
  return Array.isArray(content) && content.some((b) => (b as { type?: string }).type === "text");
}

/**
 * A prompt without the context blocks the IDE extension puts in front of it (`<ide_opened_file>…</ide_opened_file>`,
 * `<ide_selection>…</ide_selection>`, …). They aren't what the person typed, so the phone's chat and the session
 * title leave them out. Only leading blocks go: a block ends at a closing tag followed by a line break (or the end),
 * so code inside a selection that contains the closing tag doesn't end it early, and the person's own text that
 * mentions such a tag stays. A block cut off before its end (a shortened title) goes entirely.
 */
export function withoutIdeContext(prompt: string): string {
  let rest = prompt.replace(/\r\n?/g, "\n").trimStart();
  for (;;) {
    const open = /^<(ide_[a-z_]+)>/.exec(rest);
    if (!open) break;
    const close = `</${open[1]}>`;
    let at = rest.indexOf(close);
    while (at !== -1) {
      const after = rest.slice(at + close.length);
      if (after === "" || after.startsWith("\n") || /^\s*<ide_[a-z_]+>/.test(after)) break;
      at = rest.indexOf(close, at + close.length);
    }
    if (at === -1) return "";
    rest = rest.slice(at + close.length).trimStart();
  }
  return rest.trim();
}

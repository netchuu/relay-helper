import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  graphemes,
  TURN_ACTIONS_LIVE_MAX,
  TURN_MESSAGE_MAX,
  TURN_MESSAGE_UNITS,
  TURN_MESSAGES_MAX,
  type TurnMessage,
  type TurnStep,
} from "../../../protocol/index.ts";
import type { EventLog } from "./events.ts";
import { redact } from "./redact.ts";
import { closeOpenFence, splitBlocks } from "./render.ts";
import { TimelineReader } from "./timeline.ts";

/**
 * Live messages: what Claude writes between its tool calls. No hook fires for
 * text, so they come from the transcript: live while the turn runs, and from one read at its end. The final
 * answer is never one of them; it stays `Turn.summary`.
 */

/** A message as the transcript has it, before redaction and the cut (to compare with the final answer). */
export interface RawMessage {
  id: string;
  raw: string;
  at: number;
}

interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: { model?: string; content?: unknown };
}

/**
 * The message in a transcript entry, or null: only Claude's own text in the main conversation, not a subagent's,
 * an API error, Claude Code's synthetic entries, thinking or tool calls. An entry with several text blocks is
 * one message.
 */
export function messageFrom(entry: unknown, since?: number): RawMessage | null {
  const e = entry as Entry;
  if (e?.type !== "assistant" || e.isSidechain || e.isApiErrorMessage) return null;
  if (e.message?.model === "<synthetic>" || !Array.isArray(e.message?.content) || !e.uuid) return null;
  const texts = (e.message.content as { type?: string; text?: unknown }[])
    .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b) => b.text as string);
  if (!texts.length) return null;
  const at = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
  if (since !== undefined && (Number.isNaN(at) || at < since)) return null;
  return { id: e.uuid, raw: texts.join("\n\n"), at: Number.isNaN(at) ? 0 : at };
}

/**
 * Redacted (whole, before any cut, so a cut never leaves the start of a secret), then at most TURN_MESSAGE_MAX
 * characters as people see them, " …" included: whole paragraphs first, never ending inside a fenced code block
 * (an open fence is closed), else cut at a word. Never splits a character.
 */
export function shownMessage(m: RawMessage): TurnMessage {
  const text = redact(m.raw)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (graphemes(text).length <= TURN_MESSAGE_MAX && text.length <= TURN_MESSAGE_UNITS)
    return { id: m.id, text, at: m.at };
  return { id: m.id, text: cut(text), at: m.at, truncated: true };
}

const ELLIPSIS = " …";

function fits(text: string): boolean {
  return graphemes(text).length <= TURN_MESSAGE_MAX && text.length <= TURN_MESSAGE_UNITS;
}

function cut(text: string): string {
  let out = "";
  for (const block of splitBlocks(text)) {
    const candidate = out ? `${out}\n\n${block}` : block;
    if (!fits(`${closeOpenFence(candidate)}${ELLIPSIS}`)) break;
    out = candidate;
  }
  if (out) return `${closeOpenFence(out).trimEnd()}${ELLIPSIS}`;
  // The first paragraph alone is too long: as much of it as fits, at a word when one is near the end, with an
  // open fence closed and the ellipsis.
  const g = graphemes(splitBlocks(text)[0] ?? text);
  let n = Math.min(g.length, TURN_MESSAGE_MAX);
  for (;;) {
    let kept = g.slice(0, n).join("");
    const lastSpace = kept.lastIndexOf(" ");
    if (lastSpace > kept.length * 0.6) kept = kept.slice(0, lastSpace);
    const result = `${closeOpenFence(kept.trimEnd())}${ELLIPSIS}`;
    if (fits(result) || n === 0) return result;
    // Over by the closing fence and the ellipsis (or the storage guard): drop the overflow and try again.
    const over = Math.max(
      1,
      graphemes(result).length - TURN_MESSAGE_MAX,
      Math.ceil((result.length - TURN_MESSAGE_UNITS) / 2),
    );
    n = Math.max(0, n - over);
  }
}

/**
 * A finished turn's messages: without the final answer (the last message, when its text is the answer's), shown,
 * at most TURN_MESSAGES_MAX with the rest counted.
 */
export function finishedMessages(
  raw: RawMessage[],
  answer: string | null,
): { messages: TurnMessage[]; messagesMore?: number } {
  const last = raw.at(-1);
  const list = last && answer !== null && last.raw.trim() === answer.trim() ? raw.slice(0, -1) : raw;
  const messages = list.slice(0, TURN_MESSAGES_MAX).map(shownMessage);
  const more = list.length - messages.length;
  return more > 0 ? { messages, messagesMore: more } : { messages };
}

/** `messages`/`messagesMore` for a Turn, left out when there are none. */
export function turnMessageFields(f: { messages: TurnMessage[]; messagesMore?: number }): {
  messages?: TurnMessage[];
  messagesMore?: number;
} {
  return {
    ...(f.messages.length ? { messages: f.messages } : {}),
    ...(f.messagesMore ? { messagesMore: f.messagesMore } : {}),
  };
}

/** JSON for `turns.messages_json`; null when the turn has none. */
export function messagesJson(f: { messages: TurnMessage[]; messagesMore?: number }): string | null {
  return f.messages.length || f.messagesMore ? JSON.stringify(turnMessageFields(f)) : null;
}

/** Reads `turns.messages_json`; a missing or corrupt value is no messages. */
export function parseMessagesJson(json: string | null | undefined): {
  messages?: TurnMessage[];
  messagesMore?: number;
} {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as { messages?: unknown; messagesMore?: unknown };
    const messages = Array.isArray(v.messages)
      ? (v.messages as TurnMessage[]).filter(
          (m) => m && typeof m.id === "string" && typeof m.text === "string" && typeof m.at === "number",
        )
      : [];
    const more = typeof v.messagesMore === "number" && v.messagesMore > 0 ? v.messagesMore : undefined;
    return turnMessageFields({ messages, ...(more ? { messagesMore: more } : {}) });
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------------------------------

interface Following {
  turnId: string;
  path: string | null;
  startedAt: number;
  offset: number;
  partial: Buffer;
  ids: Set<string>;
  sent: TurnMessage[];
  timer: ReturnType<typeof setInterval> | null;
  /** The turn's actions and thinking lines (turn-timeline), and the ones already sent. */
  timeline: TimelineReader;
  actions: TurnStep[];
  actionIds: Set<string>;
}

/** The running turn's messages, actions and thinking lines so far, per session, for `session.live`. */
const live = new Map<string, { turnId: string; messages: TurnMessage[]; actions: TurnStep[] }>();

export function liveMessages(sessionId: string, turnId: string): TurnMessage[] {
  const entry = live.get(sessionId);
  return entry && entry.turnId === turnId ? entry.messages : [];
}

/** The running turn's actions and thinking lines so far (turn-timeline), oldest first. */
export function liveActions(sessionId: string, turnId: string): TurnStep[] {
  const entry = live.get(sessionId);
  return entry && entry.turnId === turnId ? entry.actions : [];
}

/** Tests only. */
export function resetLiveMessages(): void {
  live.clear();
}

/**
 * Follows the transcript of each running turn and emits `turn.message` once per message, in order, at most
 * TURN_MESSAGES_MAX per turn, and `turn.action` once per action and thinking line (again when an action turns out
 * failed), at most TURN_ACTIONS_LIVE_MAX per turn (turn-timeline). Reads what was appended on every tool hook
 * (`poll`) and every `pollMs`.
 */
export class MessageTracker {
  private readonly turns = new Map<string, Following>();
  private readonly pollMs: number;

  constructor(
    private readonly events: EventLog,
    opts: { pollMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    // Going idle or ending without a Stop: the turn is over.
    events.subscribe((e) => {
      if (e.type === "session.upsert" && (e.session.status === "idle" || e.session.status === "ended"))
        this.clear(e.session.id);
    });
  }

  turnStarted(
    sessionId: string,
    turnId: string,
    path: string | null,
    startedAt = Date.now(),
    cwd: string | null = null,
  ): void {
    this.clear(sessionId);
    const state: Following = {
      turnId,
      path,
      startedAt,
      offset: path ? sizeOf(path) : 0,
      partial: Buffer.alloc(0),
      ids: new Set(),
      sent: [],
      timer: null,
      timeline: new TimelineReader(cwd, startedAt, { transcriptPath: path }),
      actions: [],
      actionIds: new Set(),
    };
    this.turns.set(sessionId, state);
    live.set(sessionId, { turnId, messages: state.sent, actions: state.actions });
    if (path && this.pollMs > 0) state.timer = setInterval(() => this.read(sessionId, state), this.pollMs);
  }

  /** Something happened in the session (a tool hook): read what the transcript has now. */
  poll(sessionId: string): void {
    const state = this.turns.get(sessionId);
    if (state) this.read(sessionId, state);
  }

  /** The turn finished (or was stopped): stop following it. Returns what was sent live. */
  endTurn(sessionId: string, turnId?: string): TurnMessage[] {
    const state = this.turns.get(sessionId);
    if (!state || (turnId !== undefined && state.turnId !== turnId)) {
      if (turnId) {
        this.events.deleteTurnMessages(turnId);
        this.events.deleteTurnActions(turnId);
      }
      return [];
    }
    this.end(sessionId, state);
    return state.sent;
  }

  /** The session ended or went idle without a Stop. */
  clear(sessionId: string): void {
    const state = this.turns.get(sessionId);
    if (state) this.end(sessionId, state);
  }

  private end(sessionId: string, state: Following): void {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    this.turns.delete(sessionId);
    if (live.get(sessionId)?.turnId === state.turnId) live.delete(sessionId);
    this.events.deleteTurnMessages(state.turnId);
    this.events.deleteTurnActions(state.turnId);
  }

  /** Sends a step once (or again when it changed): `turn.action`, at most TURN_ACTIONS_LIVE_MAX per turn. */
  private sendAction(sessionId: string, state: Following, step: TurnStep): void {
    const id = step.id;
    if (!id) return;
    if (!state.actionIds.has(id)) {
      if (state.actionIds.size >= TURN_ACTIONS_LIVE_MAX) return;
      state.actionIds.add(id);
      state.actions.push(step);
    }
    this.events.emit({ type: "turn.action", sessionId, turnId: state.turnId, step: { ...step } });
  }

  /** The entry's actions and thinking lines, from the turn's start on; a failed action is sent again. */
  private readActions(sessionId: string, state: Following, entry: unknown): void {
    const e = entry as { timestamp?: string };
    const at = e?.timestamp ? Date.parse(e.timestamp) : Number.NaN;
    if (Number.isNaN(at) || at < state.startedAt) return;
    for (const step of state.timeline.add(entry as Parameters<TimelineReader["add"]>[0]))
      this.sendAction(sessionId, state, step);
  }

  /** What the running agents' own transcripts have now (agent-progress): the steps whose progress changed. */
  private readAgents(sessionId: string, state: Following): void {
    for (const step of state.timeline.refreshAgents()) this.sendAction(sessionId, state, step);
  }

  private read(sessionId: string, state: Following): void {
    if (!state.path || this.turns.get(sessionId) !== state) return;
    this.readMain(sessionId, state);
    if (this.turns.get(sessionId) === state) this.readAgents(sessionId, state);
  }

  private readMain(sessionId: string, state: Following): void {
    if (!state.path) return;
    const size = sizeOf(state.path);
    // Replaced or cut short: read it again; the timestamps and the ids sent keep old messages out.
    if (size < state.offset) {
      state.offset = 0;
      state.partial = Buffer.alloc(0);
    }
    if (size === state.offset) return;
    let chunk: Buffer;
    try {
      const fd = openSync(state.path, "r");
      try {
        chunk = Buffer.alloc(size - state.offset);
        const n = readSync(fd, chunk, 0, chunk.length, state.offset);
        chunk = chunk.subarray(0, n);
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    state.offset += chunk.length;
    const data = Buffer.concat([state.partial, chunk]);
    // A newline byte never sits inside a UTF-8 character, so the cut is safe; the rest waits for the next read.
    const end = data.lastIndexOf(0x0a);
    state.partial = Buffer.from(data.subarray(end + 1));
    if (end < 0) return;
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      this.readActions(sessionId, state, entry);
      const m = messageFrom(entry, state.startedAt);
      if (!m || state.ids.has(m.id)) continue;
      state.ids.add(m.id);
      if (state.sent.length >= TURN_MESSAGES_MAX) continue;
      const message = shownMessage(m);
      state.sent.push(message);
      this.events.emit({ type: "turn.message", sessionId, turnId: state.turnId, message });
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The next message Claude Code suggests in its prompt, for the phone's chip above the reply box. Claude Code shows it
 * (greyed) only on the terminal screen, so the helper reads it there after a turn ends: a few quick looks, since the
 * suggestion appears a moment after the Stop, then slower ones while it shows, to notice when it goes away (the
 * person typed, or Claude Code dropped it). A new turn clears it at once.
 */
import { errMessage, log } from "../log.ts";
import { readPromptHoldsText, readSuggestion } from "./inject.ts";
import { redact } from "./redact.ts";
import type { Registry } from "./registry.ts";
import { clearSuggestionSeen, noteTurnEnded, noteTypedDuringTurn } from "./suggestionSeen.ts";
import { head } from "./text.ts";

/** Longest suggestion kept, in characters. */
const MAX_LENGTH = 300;
/** Pauses between the looks after a Stop, in ms: the suggestion shows up a moment after the turn ends. */
const FIRST_LOOKS = [600, 900, 1500, 2500, 4000];
/** While a suggestion shows: how often to check that it's still there, and how long to check that often. */
const WATCH_EVERY_MS = 3_000;
const WATCH_FAST_FOR_MS = 10 * 60_000;
/** After that the session is likely left alone: check less often, but keep the suggestion while it shows. */
const WATCH_IDLE_EVERY_MS = 30_000;
/** Empty looks in a row, while one shows, before it counts as gone: a screen caught mid-redraw reads empty once. */
const EMPTY_LOOKS_TO_CLEAR = 2;

/** The least time between two reads of a working session's prompt. */
const PROBE_EVERY_MS = 3_000;
/** The longest a Stop waits for its read of the prompt; the suggestion can appear about a second after the Stop hook. */
const STOP_PROBE_MAX_MS = 500;

const shown = new Map<string, string>();

/** The suggestion the session's prompt shows right now, for `publicSession`. */
export function suggestionOf(sessionId: string): string | undefined {
  return shown.get(sessionId);
}

/** One line, redacted like other text from the terminal, cut to a sensible length. */
export function cleanSuggestion(text: string): string | null {
  const line = redact(text).replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > MAX_LENGTH ? `${head(line, MAX_LENGTH - 1)}…` : line;
}

export interface SuggestionDeps {
  registry: Pick<Registry, "get" | "list" | "publish">;
  /** Reads the suggestion off the session's terminal; tests swap it. */
  read?: typeof readSuggestion;
  sleep?: (ms: number) => Promise<void>;
  /** False when no phone is connected: nothing is read then. Default: always. */
  phoneConnected?: () => boolean;
  now?: () => number;
  /** Whether the session's prompt line holds text; tests swap it. */
  holdsText?: typeof readPromptHoldsText;
}

export class SuggestionWatcher {
  /** The watch each session has now; a newer one (or `clear`) makes an older one stop. */
  private readonly watches = new Map<string, number>();
  private counter = 0;
  private readonly probing = new Set<string>();
  private readonly probedAt = new Map<string, number>();

  constructor(private readonly d: SuggestionDeps) {}

  /** A turn ended: look for the suggestion now and keep an eye on it while the session is idle. */
  turnEnded(sessionId: string): void {
    noteTurnEnded(sessionId, this.d.now?.());
    this.look(sessionId);
  }

  /** A tool hook during a turn: Claude Code draws no suggestion while it works, so text in the prompt was typed. */
  duringTurn(sessionId: string): void {
    const now = (this.d.now ?? Date.now)();
    if (this.probing.has(sessionId) || now - (this.probedAt.get(sessionId) ?? -Infinity) < PROBE_EVERY_MS)
      return;
    this.probing.add(sessionId);
    this.probedAt.set(sessionId, now);
    void this.probe(sessionId).finally(() => this.probing.delete(sessionId));
  }

  /** The Stop hook arrived: read the prompt once more, before the session goes idle and a suggestion can be drawn. */
  async beforeStop(sessionId: string): Promise<void> {
    // A read that finishes later may be seeing the suggestion, already drawn: it doesn't count.
    const window = { open: true };
    const timer = setTimeout(() => {
      window.open = false;
    }, STOP_PROBE_MAX_MS);
    try {
      await Promise.race([this.probe(sessionId, window), Bun.sleep(STOP_PROBE_MAX_MS)]);
    } finally {
      clearTimeout(timer);
      window.open = false;
    }
  }

  private async probe(sessionId: string, window?: { open: boolean }): Promise<void> {
    const session = this.d.registry.get(sessionId);
    if (!session || session.status === "idle" || !session.canReceive) return;
    try {
      const holds = await (this.d.holdsText ?? readPromptHoldsText)(session);
      if (holds !== true || window?.open === false) return;
      // The turn may have ended while the screen was read: that text could be the suggestion.
      if (this.d.registry.get(sessionId)?.status === "idle") return;
      noteTypedDuringTurn(sessionId);
    } catch (err) {
      log.warn("prompt probe", { sessionId, err: errMessage(err) });
    }
  }

  private look(sessionId: string): void {
    const id = ++this.counter;
    this.watches.set(sessionId, id);
    void this.watch(sessionId, id).catch((err) =>
      log.warn("suggestion watch", { sessionId, err: errMessage(err) }),
    );
  }

  /** A phone connected: look at the idle sessions now, since nothing was read while none was. */
  lookNow(): void {
    for (const s of this.d.registry.list()) {
      if (s.status === "idle" && s.canReceive && !this.watches.has(s.id)) this.look(s.id);
    }
  }

  /** A turn started, or the session ended: the suggestion is gone. Returns whether one was showing. */
  clear(sessionId: string): boolean {
    this.watches.delete(sessionId);
    clearSuggestionSeen(sessionId);
    return shown.delete(sessionId);
  }

  private set(sessionId: string, text: string | null): void {
    const before = shown.get(sessionId);
    if (text === null) shown.delete(sessionId);
    else shown.set(sessionId, text);
    if (before !== (text ?? undefined)) this.d.registry.publish(sessionId);
  }

  private async watch(sessionId: string, id: number): Promise<void> {
    const sleep = this.d.sleep ?? Bun.sleep;
    const read = this.d.read ?? readSuggestion;
    const now = this.d.now ?? Date.now;
    const started = now();
    let empty = 0;
    for (let n = 0; ; n++) {
      // After the quick looks, stop when there is nothing to keep an eye on.
      if (n >= FIRST_LOOKS.length && !shown.has(sessionId)) break;
      const wait =
        n < FIRST_LOOKS.length
          ? (FIRST_LOOKS[n] ?? WATCH_EVERY_MS)
          : now() - started > WATCH_FAST_FOR_MS
            ? WATCH_IDLE_EVERY_MS
            : WATCH_EVERY_MS;
      await sleep(wait);
      // With no phone the first looks are still taken (they only note what the prompt showed), but nothing is published.
      const offline = this.d.phoneConnected !== undefined && !this.d.phoneConnected();
      if (offline && n >= FIRST_LOOKS.length) {
        if (shown.has(sessionId)) this.set(sessionId, null);
        break;
      }
      if (this.watches.get(sessionId) !== id) return;
      const session = this.d.registry.get(sessionId);
      if (!session || session.status !== "idle" || !session.canReceive) {
        // The session is no longer idle: the suggestion is no longer known to be current.
        if (shown.has(sessionId)) this.set(sessionId, null);
        break;
      }
      const text = await read(session);
      // A turn started while the screen was being read.
      if (this.watches.get(sessionId) !== id) return;
      if (offline) {
        if (shown.has(sessionId)) this.set(sessionId, null);
        continue;
      }
      // Unreadable (no tab, an error, a half-drawn screen): keep what is known and look again.
      if (text === undefined) continue;
      if (text === null && shown.has(sessionId) && ++empty < EMPTY_LOOKS_TO_CLEAR) continue;
      if (text !== null) empty = 0;
      this.set(sessionId, text === null ? null : cleanSuggestion(text));
    }
    if (this.watches.get(sessionId) === id) this.watches.delete(sessionId);
  }
}

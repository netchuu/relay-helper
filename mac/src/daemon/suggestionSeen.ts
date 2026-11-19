import { type DB, getSetting, setSetting } from "./db.ts";

/** What a session's prompt showed when it went idle: Claude Code's grey suggestion, or nothing. */
interface Seen {
  text: string;
  at: number;
}

const KEY = "suggestion_seen";
const STOP_KEY = "suggestion_stop";
const TYPED_KEY = "suggestion_typed";
const MAX_SESSIONS = 100;
const seen = new Map<string, Seen>();
/** When each session's turn last ended without anyone having typed into its prompt during it. */
const stops = new Map<string, number>();
/** Sessions whose prompt held text during the running turn: Claude Code shows no suggestion then, so it was typed. */
const typed = new Set<string>();
let db: DB | null = null;

/** Loads what was kept before a restart, and keeps every change from now on. */
export function bindSuggestionSeen(database: DB): void {
  db = database;
  seen.clear();
  stops.clear();
  typed.clear();
  try {
    const stored = getSetting<Record<string, Seen>>(database, KEY, {});
    for (const [id, s] of Object.entries(stored)) if (typeof s?.text === "string") seen.set(id, s);
    const storedStops = getSetting<Record<string, number>>(database, STOP_KEY, {});
    for (const [id, at] of Object.entries(storedStops)) if (typeof at === "number") stops.set(id, at);
    const storedTyped = getSetting<string[]>(database, TYPED_KEY, []);
    if (Array.isArray(storedTyped)) for (const id of storedTyped) if (typeof id === "string") typed.add(id);
  } catch {
    // unreadable: start empty
  }
}

function save(): void {
  if (!db) return;
  while (seen.size > MAX_SESSIONS) {
    const oldest = [...seen.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    seen.delete(oldest[0]);
  }
  while (stops.size > MAX_SESSIONS) {
    const oldest = [...stops.entries()].sort((a, b) => a[1] - b[1])[0];
    if (!oldest) break;
    stops.delete(oldest[0]);
  }
  while (typed.size > MAX_SESSIONS) {
    const oldest = typed.values().next().value;
    if (oldest === undefined) break;
    typed.delete(oldest);
  }
  try {
    setSetting(db, KEY, Object.fromEntries(seen));
    setSetting(db, STOP_KEY, Object.fromEntries(stops));
    setSetting(db, TYPED_KEY, [...typed]);
  } catch {
    // kept in memory only
  }
}

/** The session's prompt held text while its turn ran: someone typed it (Claude Code draws no suggestion then). */
export function noteTypedDuringTurn(sessionId: string): void {
  if (typed.has(sessionId)) return;
  typed.add(sessionId);
  stops.delete(sessionId);
  save();
}

/** A turn ended. Its prompt can only show a suggestion if no read during the turn saw text in it. */
export function noteTurnEnded(sessionId: string, at = Date.now()): void {
  if (typed.has(sessionId)) return;
  stops.set(sessionId, at);
  save();
}

/** The Stop that ended the turn; undefined when unknown or when text was seen in the prompt during the turn. */
export function untypedStopAt(sessionId: string): number | undefined {
  return typed.has(sessionId) ? undefined : stops.get(sessionId);
}

/** The prompt's text (whitespace squeezed, possibly empty) at the first look after the session went idle; undefined when unknown. */
export function suggestionSeenOf(sessionId: string): string | undefined {
  return seen.get(sessionId)?.text;
}

/** Claude Code draws its suggestion within about 3 s of the Stop: an empty first look gives way only to text seen that soon. */
const LATE_MS = 3_000;

/** Keeps the first look of this idle stretch; later looks (which may show typing) don't replace it. */
export function noteSuggestionSeen(sessionId: string, text: string, at = Date.now()): void {
  const before = seen.get(sessionId);
  if (before && !(before.text === "" && text !== "" && at - before.at < LATE_MS)) return;
  seen.set(sessionId, { text, at });
  save();
}

/** A new turn started or the session ended: the next idle stretch gets its own first look. */
export function clearSuggestionSeen(sessionId: string): void {
  const had = seen.delete(sessionId);
  const stopped = stops.delete(sessionId);
  if (typed.delete(sessionId) || stopped || had) save();
}

/** Forgets everything in memory (tests simulating a restart). */
export function resetSuggestionSeen(): void {
  seen.clear();
  stops.clear();
  typed.clear();
  db = null;
}

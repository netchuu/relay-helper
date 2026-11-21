/** The first `n` UTF-16 units of `s`, backing off one when the cut would split a surrogate pair (an emoji). */
export function head(s: string, n: number): string {
  if (n >= s.length) return s;
  if (n <= 0) return "";
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** `JSON.stringify` for a frame to the phone: a string with a lone surrogate is repaired (U+FFFD) instead of written as a `\ud83d` escape the phone can't read. */
export function wellFormedJSON(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "string" ? v.toWellFormed() : v));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this matches
const HIDDEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\uFEFF]/g;

/** Invisible and control characters written out (`\x1b`, `\u{202E}`) so an approval shows what will run; newline and tab stay. */
export function visibleEscapes(text: string): string {
  return text.replace(HIDDEN, (c) => {
    const n = c.charCodeAt(0);
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u{${n.toString(16).toUpperCase()}}`;
  });
}

const NAME_ESCAPE_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this removes
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[PX^_][^\x1b\n]*(?:\x1b\\)?|[ -/]*[0-~])?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this matches
const NAME_REMOVED = /[\x00-\x1f\x7f-\x9f\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/** A session title or name without escape sequences, control characters and bidi controls; joiners stay for emoji and scripts. */
export function cleanName(text: string): string {
  return text.replace(NAME_ESCAPE_SEQUENCES, "").replace(NAME_REMOVED, "");
}

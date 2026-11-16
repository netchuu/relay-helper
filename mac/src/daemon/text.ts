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

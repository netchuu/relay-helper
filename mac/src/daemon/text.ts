/** The first `n` UTF-16 units of `s`, backing off one when the cut would split a surrogate pair (an emoji). */
export function head(s: string, n: number): string {
  if (n >= s.length) return s;
  if (n <= 0) return "";
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

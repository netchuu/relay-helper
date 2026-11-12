/**
 * Reads Claude Code's prompt line off a terminal's visible text, to tell whether it holds an unsent draft before
 * Relay types a phone message into that tab (a message typed into a draft would be sent together with it).
 *
 * Claude Code 2.1.319 draws its input between two rules, with `❯` in front of the first line:
 *
 *     ────────────────────────────
 *     ❯ fix the login test
 *       and the signup one
 *     ────────────────────────────
 *
 * Older versions drew a box (`╭─╮`, `│ > … │`, `╰─╯`). An empty prompt can show a dimmed suggestion
 * (`❯ Try "fix typecheck errors"`), which the plain text can't tell from typing, so that one counts as empty.
 */

/** A line made only of a horizontal rule, or the top or bottom edge of the older box. */
function isRule(line: string): boolean {
  return /^[╭╰]?─{8,}[╮╯]?$/.test(line.trim());
}

/** The prompt markers: `❯` (2.x), `>` (1.x), `!` (shell mode). */
const MARKER = /^[❯>!](?:\s|$)/;

/** A suggestion Claude Code shows in an empty prompt. */
const PLACEHOLDER = /^Try "[^\n]*"$/;

/**
 * The text in the prompt line at the bottom of `screen`, or null when it's empty or there's no prompt line to read
 * (another app in the tab, a dialog, a terminal Relay can't read).
 */
export function promptDraft(screen: string): string | null {
  const lines = screen.replace(/\r/g, "").split("\n");
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRule(lines[i] ?? "")) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) return null;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (isRule(lines[i] ?? "")) {
      top = i;
      break;
    }
  }
  if (top < 0 || bottom - top < 2) return null;
  const inner = lines.slice(top + 1, bottom).map((l) => l.replace(/^\s*│/, "").replace(/│\s*$/, "").trim());
  const first = inner[0] ?? "";
  if (!MARKER.test(first)) return null;
  const text = [first.slice(1), ...inner.slice(1)]
    .map((l) => l.trim())
    .join("\n")
    .trim();
  if (!text || PLACEHOLDER.test(text)) return null;
  return text;
}

/** The phone's text after a clean break, for when it has to be typed after a draft (it waited long enough). */
export function afterBreak(text: string): string {
  return `\n\n${text}`;
}

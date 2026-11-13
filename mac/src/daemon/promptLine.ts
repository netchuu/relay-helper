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
 * (`❯ Try "fix typecheck errors"`, or a guess at the next message), which plain text can't tell from typing. Three
 * ways to tell them apart:
 *  - the `Try "…"` form is always taken as empty;
 *  - a screen with its escape codes (tmux `capture-pane -e`) shows the dim attribute: a prompt whose text is all dim
 *    is a suggestion;
 *  - a terminal that gives no attributes (iTerm2) can say that no key was pressed at this Mac since the prompt was
 *    last submitted (`noKeySincePrompt`): nobody could have typed the text, so it is a suggestion.
 */

/** A line made only of a horizontal rule, or the top or bottom edge of the older box. */
function isRule(line: string): boolean {
  return /^[╭╰]?─{8,}[╮╯]?$/.test(line.trim());
}

/** The prompt markers: `❯` (2.x), `>` (1.x), `!` (shell mode). */
const MARKER = /^[❯>!](?:\s|$)/;

/** A suggestion Claude Code shows in an empty prompt. */
const PLACEHOLDER = /^Try "[^\n]*"$/;

/** One line of a screen: its text without escape codes, and which characters are dimmed (SGR 2) or reversed (SGR 7). */
interface StyledLine {
  text: string;
  dim: boolean[];
  reverse: boolean[];
}

const ESC = String.fromCharCode(27);

/** Splits a line with SGR escape codes into text and per-character attributes. Other escapes are dropped. */
export function styledLine(raw: string): StyledLine {
  const out: StyledLine = { text: "", dim: [], reverse: [] };
  let dim = false;
  let reverse = false;
  const re = new RegExp(`${ESC}\\[([0-9;:]*)([A-Za-z])|${ESC}[^\\[]?`, "gy");
  let i = 0;
  while (i < raw.length) {
    re.lastIndex = i;
    const m = re.exec(raw);
    if (m) {
      i = re.lastIndex;
      if (m[2] === "m") {
        const params = (m[1] ?? "").split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
        for (let k = 0; k < params.length; k++) {
          const p = params[k];
          if (p === 0) {
            dim = false;
            reverse = false;
          } else if (p === 2) dim = true;
          else if (p === 22) dim = false;
          else if (p === 7) reverse = true;
          else if (p === 27) reverse = false;
          else if (p === 38 || p === 48) k += params[k + 1] === 2 ? 4 : 2; // a colour's own numbers
        }
      }
      continue;
    }
    const ch = String.fromCodePoint(raw.codePointAt(i) ?? 32);
    i += ch.length;
    out.text += ch;
    for (let n = 0; n < ch.length; n++) {
      out.dim.push(dim);
      out.reverse.push(reverse);
    }
  }
  return out;
}

export interface PromptOptions {
  /** No key was pressed at this Mac since the prompt was last submitted: text in the prompt is a suggestion. */
  noKeySincePrompt?: boolean;
}

/**
 * The text in the prompt line at the bottom of `screen`, or null when it's empty or there's no prompt line to read
 * (another app in the tab, a dialog, a terminal Relay can't read).
 */
export function promptDraft(screen: string, opts: PromptOptions = {}): string | null {
  const styled = screen
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => styledLine(l));
  const lines = styled.map((l) => l.text);
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
  if (opts.noKeySincePrompt || allDim(styled.slice(top + 1, bottom))) return null;
  return text;
}

/**
 * Whether the prompt's text (after the marker) is dimmed throughout, so it is a suggestion. A reversed character is
 * the cursor, drawn over the first letter of a suggestion: it doesn't count either way.
 */
function allDim(rows: StyledLine[]): boolean {
  let seen = false;
  for (const [r, row] of rows.entries()) {
    let past = r > 0; // the marker is on the first row only
    let idx = 0;
    for (const c of row.text) {
      const at = idx;
      idx += c.length;
      if (!past) {
        past = /[❯>!]/.test(c);
        continue;
      }
      if (/[\s│]/.test(c) || row.reverse[at]) continue;
      if (!row.dim[at]) return false;
      seen = true;
    }
  }
  return seen;
}

/** The phone's text after a clean break, for when it has to be typed after a draft (it waited long enough). */
export function afterBreak(text: string): string {
  return `\n\n${text}`;
}

/** When each session's prompt was last submitted (its UserPromptSubmit hook arrived), in ms. */
const promptSubmitted = new Map<string, number>();

export function notePromptSubmitted(sessionId: string, at = Date.now()): void {
  promptSubmitted.set(sessionId, at);
}

/**
 * Whether no key was pressed at this Mac since the session's prompt was last submitted: the keyboard's idle time
 * reaches back past that moment (the Enter that submitted it is the last key, if a person did). False when either
 * is unknown, so text in the prompt then counts as a draft.
 */
export function noKeySincePrompt(
  sessionId: string,
  keyIdleSeconds: number | null,
  now = Date.now(),
): boolean {
  const at = promptSubmitted.get(sessionId);
  return at !== undefined && keyIdleSeconds !== null && keyIdleSeconds * 1000 >= now - at;
}

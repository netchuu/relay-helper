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
 *    last submitted (`noKeySincePrompt`): nobody could have typed the text, so it is a suggestion;
 *  - or the prompt showed this same text when the session went idle (`seen`, kept by suggestionSeen.ts): typing
 *    after that changes it.
 */

/** A line made only of a horizontal rule (it may carry the session's name near its end), or an edge of the older box. */
function isRule(line: string): boolean {
  return /^[╭╰]?─{8,}(?: [^─\n]{1,60} ─+)?[╮╯]?$/.test(line.trim());
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
  const re = new RegExp(`${ESC}[()*+].?|${ESC}\\[([0-9;:]*)([A-Za-z])|${ESC}[^\\[]?`, "gy");
  let i = 0;
  while (i < raw.length) {
    re.lastIndex = i;
    const m = re.exec(raw);
    if (m) {
      i = re.lastIndex;
      if (m[2] === "m") {
        // ';' separates parameters; a ':' group (`38:2::R:G:B`, `58:5:N`) is one parameter led by its first number
        const params = (m[1] ?? "").split(";").map((g) => {
          const [head, sub] = g.split(":", 2);
          return { p: head === "" ? 0 : Number(head), grouped: sub !== undefined };
        });
        for (let k = 0; k < params.length; k++) {
          const { p, grouped } = params[k] as { p: number; grouped: boolean };
          if (p === 0) {
            dim = false;
            reverse = false;
          } else if (p === 2) dim = true;
          else if (p === 22) dim = false;
          else if (p === 7) reverse = true;
          else if (p === 27) reverse = false;
          else if ((p === 38 || p === 48 || p === 58) && !grouped) k += params[k + 1]?.p === 2 ? 4 : 2; // a colour's own numbers
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
  /** What the prompt showed when the session went idle (see suggestionSeen.ts): the same text is the suggestion. */
  seen?: string;
}

const squash = (t: string) => t.replace(/\s+/g, " ").trim();

/** The prompt's text with whitespace squeezed ("" when empty), or undefined when there's no prompt line to read. */
export function promptTextRead(screen: string): string | undefined {
  const read = readPrompt(screen, {});
  return read ? squash(read.text) : undefined;
}

/** Whether the prompt line holds text (not the empty box or the placeholder); undefined when there's no prompt to read. */
export function promptHoldsText(screen: string): boolean | undefined {
  const read = readPrompt(screen, {});
  return read ? !read.placeholder && squash(read.text) !== "" : undefined;
}

/**
 * The text in the prompt line at the bottom of `screen`, or null when it's empty or there's no prompt line to read
 * (another app in the tab, a dialog, a terminal Relay can't read).
 */
export function promptDraft(screen: string, opts: PromptOptions = {}): string | null {
  const read = readPrompt(screen, opts);
  return read && !read.suggestion ? read.text : null;
}

/**
 * Claude Code's suggested next message in the empty prompt of `screen` (one line), or null when the prompt holds
 * typing, nothing, or the `Try "…"` hint, or when the suggestion can't be told from typing (a terminal with no
 * attributes and no `noKeySincePrompt`).
 */
export function promptSuggestion(screen: string, opts: PromptOptions = {}): string | null {
  return promptSuggestionRead(screen, opts) ?? null;
}

/** As `promptSuggestion`, but undefined when no prompt box is on the screen (not drawn yet, or mid-redraw). */
export function promptSuggestionRead(screen: string, opts: PromptOptions = {}): string | null | undefined {
  const read = readPrompt(screen, opts);
  if (!read) return undefined;
  if (!read.suggestion || read.placeholder) return null;
  const line = read.text.replace(/\s+/g, " ").trim();
  return line || null;
}

interface PromptRead {
  text: string;
  /** The text is a suggestion (dimmed, or no key was pressed since the prompt was submitted), not typing. */
  suggestion: boolean;
  /** The `Try "…"` hint, which isn't a message. */
  placeholder: boolean;
}

function readPrompt(screen: string, opts: PromptOptions): PromptRead | null {
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
  // An empty prompt box is a prompt that holds nothing (neither draft nor suggestion), not a screen we can't read.
  if (!text) return { text, suggestion: true, placeholder: true };
  if (PLACEHOLDER.test(text)) return { text, suggestion: true, placeholder: true };
  const suggestion =
    opts.noKeySincePrompt === true ||
    (opts.seen !== undefined && opts.seen !== "" && squash(text) === opts.seen) ||
    allDim(styled.slice(top + 1, bottom));
  return { text, suggestion, placeholder: false };
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

/** Whether the keyboard's idle time reaches back past `at`: no key was pressed at this Mac since. False when unknown. */
export function noKeySince(at: number, keyIdleSeconds: number | null, now = Date.now()): boolean {
  return keyIdleSeconds !== null && keyIdleSeconds * 1000 >= now - at;
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
  return at !== undefined && noKeySince(at, keyIdleSeconds, now);
}

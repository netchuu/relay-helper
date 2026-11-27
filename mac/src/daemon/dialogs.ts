/**
 * Finds a Claude Code dialog on a terminal screen by its shape: a list of options with a `❯` cursor and a footer
 * like `Enter to confirm · Esc to cancel`, never a prompt box. A table of known dialogs names them by their words.
 */
import { createHash } from "node:crypto";
import type { AtMacDialog } from "../../../protocol/index.ts";
import { styledLine } from "./promptLine.ts";
import { redact } from "./redact.ts";
import { head } from "./text.ts";

export const TITLE_MAX = 120;
export const BODY_MAX = 600;
export const OPTIONS_MAX = 9;
export const OPTION_MAX = 120;

export interface Dialog {
  kind: string;
  title: string;
  body: string;
  options: string[];
  /** Index in `options` the `❯` cursor is on. */
  cursor: number;
  /** Esc dismisses it without a side effect. */
  canClose: boolean;
  /** Same for the same kind, title and options; changes when the screen shows another dialog. */
  id: string;
}

interface Known {
  kind: string;
  re: RegExp;
  canClose: boolean;
}

// Esc on the trust, bypass, API key and login screens quits Claude Code or declines: no Close It.
const KNOWN: Known[] = [
  { kind: "trust", re: /Accessing workspace:[\s\S]*Yes, I trust this folder/, canClose: false },
  { kind: "mcpServer", re: /New MCP server found in this project/, canClose: true },
  { kind: "rateLimit", re: /Stop and wait for limit to reset/, canClose: true },
  { kind: "exitTasks", re: /Exit and stop tasks/, canClose: true },
  { kind: "modelSwitch", re: /^\s*Switch model\?\s*$/m, canClose: true },
  { kind: "bypass", re: /WARNING: Claude Code running in Bypass Permissions mode/, canClose: false },
  { kind: "apiKey", re: /Do you want to use this API key\?/, canClose: false },
  { kind: "login", re: /Please run \/login|OAuth token has expired/, canClose: false },
];

const FOOTER = /Enter to (?:confirm|select|save)|Esc to (?:cancel|exit|close)/;
const OPTION = /^(\s*)(❯\s+)?(?:\d+\.\s+)?(\S.*?)\s*$/;
const isRule = (l: string) => /^[╭╰]?─{8,}(?: [^─\n]{1,60} ─+)?[╮╯]?$/.test(l.trim());
/** How far above the options the title may be when no rule marks the top. */
const LOOK_UP = 12;

function parseOption(line: string): { col: number; label: string } | null {
  if (line.trim() === "" || isRule(line) || FOOTER.test(line) || /^\s*⎿/.test(line)) return null;
  const m = OPTION.exec(line);
  return m ? { col: (m[1] ?? "").length + (m[2] ?? "").length, label: m[3] ?? "" } : null;
}

/** The dialog the screen shows, or null (a prompt, output, a shell, nothing). */
export function detectDialog(screen: string): Dialog | null {
  const lines = screen
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => styledLine(l).text.replace(/\s+$/, ""));
  let cursorAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*❯\s+\S/.test(lines[i] ?? "")) {
      cursorAt = i;
      break;
    }
  }
  if (cursorAt < 0) return null;
  const col = parseOption(lines[cursorAt] ?? "")?.col ?? 0;
  // Option lines run up and down from the cursor at its column; deeper lines under an option describe it.
  const rows = [cursorAt];
  const walk = (step: 1 | -1) => {
    for (let i = cursorAt + step; i >= 0 && i < lines.length; i += step) {
      const o = parseOption(lines[i] ?? "");
      if (!o || o.col < col) break;
      if (o.col === col) rows[step === 1 ? "push" : "unshift"](i);
    }
  };
  walk(-1);
  walk(1);
  if (rows.length < 2) return null;
  const first = rows[0] as number;
  const last = rows[rows.length - 1] as number;
  const options = rows.map((i) => parseOption(lines[i] ?? "")?.label ?? "");

  let top = first - 1;
  while (top >= 0 && first - top <= LOOK_UP && !isRule(lines[top] ?? "")) top--;
  const footerAt = lines.findIndex((l, i) => i > last && FOOTER.test(l));
  // A rule under the cursor before any footer closes a prompt box, so the options are a draft.
  const ruleBelow = lines.findIndex((l, i) => i > last && isRule(l));
  if (ruleBelow >= 0 && (footerAt < 0 || ruleBelow < footerAt) && top >= 0 && isRule(lines[top] ?? ""))
    return null;
  const block = lines.slice(Math.max(top, 0), footerAt >= 0 ? footerAt + 1 : last + 1).join("\n");
  const known = KNOWN.find((k) => k.re.test(block));
  if (!known && footerAt < 0) return null;

  const above = lines
    .slice(Math.max(top + 1, first - LOOK_UP), first)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const clean = (s: string, n: number) => head(redact(s).trim(), n);
  const kind = known?.kind ?? "other";
  const title = clean(above[0] ?? "", TITLE_MAX) || "A question on your computer";
  const shown = options.slice(0, OPTIONS_MAX).map((o) => clean(o, OPTION_MAX));
  return {
    kind,
    title,
    body: clean(above.slice(1).join("\n"), BODY_MAX),
    options: shown,
    cursor: rows.indexOf(cursorAt),
    canClose: known?.canClose ?? true,
    id: dialogId(kind, title, shown),
  };
}

/** A short hash of what makes the dialog this dialog. */
export function dialogId(kind: string, title: string, options: string[]): string {
  const h = createHash("sha256")
    .update(JSON.stringify([kind, title, options]))
    .digest("hex");
  return `d_${h.slice(0, 8)}`;
}

export function atMacOf(d: Dialog): AtMacDialog {
  return { id: d.id, kind: d.kind, title: d.title, canClose: d.canClose };
}

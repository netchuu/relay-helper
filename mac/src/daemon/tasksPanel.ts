/** Claude Code's `/tasks` panel on a terminal screen: its list of background shells, or one task's detail view. */
import { styledLine } from "./promptLine.ts";
import { redact } from "./redact.ts";

export type TasksPanel =
  | {
      kind: "list";
      /** Running tasks, top to bottom; `label` is the command as the row shows it (cut with `…` when long). */
      rows: { label: string }[];
      /** Index in `rows` of the `❯` cursor; -1 when it sits on another line ("Earlier in this session"). */
      cursor: number;
    }
  | { kind: "detail"; command: string | null };

const ROW = /^(\s*)(❯\s+)?(\S)\s+(.+?)\s{2,}[a-z]+(?:\s·.*)?$/;

/** The panel the screen shows now, or null (a prompt, another dialog). Only a panel with its stop hint counts. */
export function readTasksPanel(screen: string): TasksPanel | null {
  const lines = screen
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => styledLine(l).text.replace(/\s+$/, ""));
  const footerAt = lastIndex(lines, (l) => /x to stop/.test(l) && /Esc to close/.test(l));
  if (footerAt < 0) return null;
  const headerAt = lastIndex(lines.slice(0, footerAt), (l) => l.trim() === "Background");
  if (headerAt >= 0) {
    const rows: { label: string }[] = [];
    let cursor = -1;
    for (let i = headerAt + 1; i < footerAt; i++) {
      const line = lines[i] as string;
      if (/^\s*(❯\s+)?Earlier in this session/.test(line)) break;
      const m = ROW.exec(line);
      if (!m) continue;
      if (m[2]) cursor = rows.length;
      rows.push({ label: (m[4] as string).trim() });
    }
    return { kind: "list", rows, cursor };
  }
  const shown = lines.slice(0, footerAt);
  const at = lastIndex(shown, (l) => /^\s*Command:\s/.test(l));
  if (at < 0) return null;
  const parts = [(shown[at] as string).replace(/^\s*Command:\s*/, "")];
  // Claude Code wraps a long or multi-line command onto indented lines, up to the blank line before the output.
  for (let i = at + 1; i < shown.length && (shown[i] as string).trim() !== ""; i++)
    parts.push(shown[i] as string);
  return {
    kind: "detail",
    command:
      parts
        .map((p) => p.trim())
        .filter(Boolean)
        .join(" ") || null,
  };
}

function lastIndex<T>(items: T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i] as T)) return i;
  return -1;
}

const norm = (text: string) => redact(text).replace(/\s+/g, " ").trim();
const uncut = (text: string) => (text.endsWith("…") ? text.slice(0, -1).trimEnd() : null);

/** Whether a command as the screen shows it is the helper's command: equal, or one of them cut with `…` and a prefix. */
export function sameCommand(shown: string, known: string): boolean {
  const s = norm(shown);
  const k = norm(known);
  const sc = uncut(s);
  const kc = uncut(k);
  if (sc !== null && kc !== null) return sc.startsWith(kc) || kc.startsWith(sc);
  if (sc !== null) return k.startsWith(sc);
  if (kc !== null) return s.startsWith(kc);
  return s === k;
}

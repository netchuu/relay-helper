/**
 * Makes Zed's built-in terminal start through `relay shell`, so replies from the phone are typed into
 * Claude Code there (Zed has no outside API to type into its terminal; see ../shell/ptyShell.ts).
 *
 * Zed reads `~/.config/zed/settings.json` (macOS; on Linux `$XDG_CONFIG_HOME/zed/settings.json`), which allows
 * comments and trailing commas. Zed from Flathub (`dev.zed.Zed`) leaves its sandbox at startup but keeps the
 * sandbox's config folder (it passes it on as FLATPAK_XDG_CONFIG_HOME), so it reads
 * `~/.var/app/dev.zed.Zed/config/zed/settings.json` instead. Every one that exists is set up.
 * The file is edited as text, in place, so the person's comments and formatting survive. Only the
 * `terminal.shell` entry is touched, and only when it isn't set already: a custom shell is left alone.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ZedEnv {
  home: string;
  platform: NodeJS.Platform;
  xdgConfigHome?: string;
  exists(path: string): boolean;
  list(dir: string): string[];
}

const realEnv = (): ZedEnv => ({
  home: homedir(),
  platform: process.platform,
  xdgConfigHome: process.env.XDG_CONFIG_HOME || undefined,
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
});

/** The settings files of every Zed on this computer: the normal install and any Flatpak (Flathub) one. */
export function zedSettingsPaths(e: ZedEnv = realEnv()): string[] {
  const paths: string[] = [];
  // Zed's own rule (crates/paths): XDG_CONFIG_HOME on Linux, ~/.config on macOS.
  const configDir =
    e.platform === "linux" && e.xdgConfigHome ? join(e.xdgConfigHome, "zed") : join(e.home, ".config", "zed");
  const native =
    e.exists(configDir) ||
    e.exists("/Applications/Zed.app") ||
    e.exists(join(e.home, "Applications", "Zed.app")) ||
    e.exists(join(e.home, ".local", "zed.app")) ||
    e.exists(join(e.home, ".local", "bin", "zed")) ||
    // Distribution packages (Arch names the binary zeditor).
    e.exists("/usr/bin/zeditor") ||
    e.exists("/usr/bin/zed");
  if (native) paths.push(join(configDir, "settings.json"));
  if (e.platform === "linux") {
    const apps = join(e.home, ".var", "app");
    for (const id of e.list(apps).sort())
      if (id.startsWith("dev.zed.Zed")) paths.push(join(apps, id, "config", "zed", "settings.json"));
  }
  return paths;
}

export function zedInstalled(e: ZedEnv = realEnv()): boolean {
  return zedSettingsPaths(e).length > 0;
}

/** "Zed" or "Zed (Flatpak)", for install and doctor lines. */
export function zedLabel(settingsPath: string): string {
  return settingsPath.includes("/.var/app/") ? "Zed (Flatpak)" : "Zed";
}

/**
 * A Flatpak override with ZED_FLATPAK_NO_ESCAPE keeps Zed inside its sandbox, where its terminal can't run
 * `relay shell` (or anything else from the host).
 */
export function flatpakNoEscape(settingsPath: string, e: ZedEnv = realEnv()): boolean {
  const id = /\/\.var\/app\/([^/]+)\//.exec(settingsPath)?.[1];
  if (!id) return false;
  for (const dir of [join(e.home, ".local", "share", "flatpak", "overrides"), "/var/lib/flatpak/overrides"]) {
    const file = join(dir, id);
    if (!e.exists(file)) continue;
    try {
      if (/^ZED_FLATPAK_NO_ESCAPE=/m.test(readFileSync(file, "utf8"))) return true;
    } catch {
      // unreadable override: assume the default (escape)
    }
  }
  return false;
}

export type ZedState = "ours" | "custom" | "none";

/**
 * Whether install sets up Zed's terminal. An update run by the daemon (`--from-update`) keeps the saved
 * choice, so `relay install --no-zed` stays off; a plain `relay install` sets the choice again.
 */
export function zedChoice(saved: boolean, opts: { noZed: boolean; fromUpdate: boolean }): boolean {
  return opts.fromUpdate ? saved : !opts.noZed;
}

export interface ZedEdit {
  text: string;
  changed: boolean;
  state: ZedState;
}

/** The `terminal.shell` value Relay sets. Zed appends `-c <command>` for tasks; `relay shell` passes those on. */
export function relayShellValue(relayBin: string): string {
  return `{ "with_arguments": { "program": ${JSON.stringify(relayBin)}, "args": ["shell"] } }`;
}

export function shellState(text: string): ZedState {
  const shell = findShell(text);
  if (!shell) return "none";
  const value = text.slice(shell.valueStart, shell.valueEnd);
  if (isSystemDefault(value)) return "none";
  return isOurs(text.slice(shell.valueStart, shell.valueEnd)) ? "ours" : "custom";
}

/** Adds Relay's `terminal.shell`, unless a shell is set already (Relay's or the person's own). */
export function addRelayShell(text: string, relayBin: string): ZedEdit {
  const value = relayShellValue(relayBin);
  const source = text.trim() ? text : "{\n}\n";
  const root = parseRoot(source);
  const terminal = root.entries.find((e) => e.key === "terminal");
  if (terminal) {
    const obj = parseValueAt(source, terminal.valueStart);
    if (obj.kind !== "object") return { text, changed: false, state: "custom" };
    const shell = obj.entries.find((e) => e.key === "shell");
    if (shell) {
      const current = source.slice(shell.valueStart, shell.valueEnd);
      // "system" is Zed's default written out: nothing custom to keep, so it's replaced like no entry.
      if (isSystemDefault(current))
        return {
          text: source.slice(0, shell.valueStart) + value + source.slice(shell.valueEnd),
          changed: true,
          state: "ours",
        };
      if (!isOurs(current)) return { text, changed: false, state: "custom" };
      if (current === value) return { text, changed: false, state: "ours" };
      // Ours, but the binary moved: point it at the current one.
      return {
        text: source.slice(0, shell.valueStart) + value + source.slice(shell.valueEnd),
        changed: true,
        state: "ours",
      };
    }
    return { text: insertEntry(source, obj, `"shell": ${value}`, "    "), changed: true, state: "ours" };
  }
  return {
    text: insertEntry(source, root, `"terminal": {\n    "shell": ${value}\n  }`, "  "),
    changed: true,
    state: "ours",
  };
}

/** Removes Relay's `terminal.shell` (and `terminal` if Relay's entry was all it held). */
export function removeRelayShell(text: string): ZedEdit {
  const root = parseRoot(text);
  const terminal = root.entries.find((e) => e.key === "terminal");
  if (!terminal) return { text, changed: false, state: "none" };
  const obj = parseValueAt(text, terminal.valueStart);
  if (obj.kind !== "object") return { text, changed: false, state: "custom" };
  const shell = obj.entries.find((e) => e.key === "shell");
  if (!shell) return { text, changed: false, state: "none" };
  if (!isOurs(text.slice(shell.valueStart, shell.valueEnd))) return { text, changed: false, state: "custom" };
  if (obj.entries.length === 1)
    return { text: removeEntry(text, root, terminal), changed: true, state: "none" };
  return { text: removeEntry(text, obj, shell), changed: true, state: "none" };
}

/** Applies an edit to the real file, keeping a backup of what was there. Returns the backup path. */
export function writeZedSettings(
  path: string,
  edit: (text: string) => ZedEdit,
): { state: ZedState; backup: string | null } {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const result = edit(before);
  if (!result.changed) return { state: result.state, backup: null };
  // Never write something Zed couldn't read back.
  parseRoot(result.text);
  let backup: string | null = null;
  if (before) {
    backup = `${path}.relay-backup`;
    writeFileSync(backup, before);
  }
  // Zed installed but never opened has no settings folder yet.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.relay-tmp`;
  writeFileSync(tmp, result.text);
  renameSync(tmp, path);
  return { state: result.state, backup };
}

/** `"shell": "system"`: Zed's default (the login shell), as it appears in its default settings. */
function isSystemDefault(value: string): boolean {
  return value.trim() === '"system"';
}

/** Relay's entry: the `relay` binary started with the single argument `shell`. */
function isOurs(value: string): boolean {
  return /"program"\s*:\s*"[^"]*\/relay"/.test(value) && /"args"\s*:\s*\[\s*"shell"\s*\]/.test(value);
}

function findShell(text: string): Entry | null {
  try {
    const root = parseRoot(text.trim() ? text : "{}");
    const terminal = root.entries.find((e) => e.key === "terminal");
    if (!terminal) return null;
    const obj = parseValueAt(text, terminal.valueStart);
    return obj.kind === "object" ? (obj.entries.find((e) => e.key === "shell") ?? null) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// A small JSONC reader that records where things are, so edits can splice the original text.

interface Entry {
  key: string;
  /** Where the key's opening quote starts. */
  start: number;
  valueStart: number;
  valueEnd: number;
}

interface ObjectNode {
  kind: "object";
  /** Positions of `{` and `}`. */
  open: number;
  close: number;
  entries: Entry[];
}

type Node = ObjectNode | { kind: "other"; end: number };

class JsoncError extends Error {}

function parseRoot(text: string): ObjectNode {
  const start = skip(text, 0);
  const node = parseValueAt(text, start);
  if (node.kind !== "object") throw new JsoncError("Zed settings must be an object");
  if (skip(text, node.close + 1) !== text.length)
    throw new JsoncError("unexpected text after the settings object");
  return node;
}

function parseValueAt(text: string, pos: number): Node {
  const c = text[pos];
  if (c === "{") return parseObject(text, pos);
  return { kind: "other", end: skipValue(text, pos) };
}

function parseObject(text: string, open: number): ObjectNode {
  const entries: Entry[] = [];
  let pos = skip(text, open + 1);
  while (text[pos] !== "}") {
    if (pos >= text.length) throw new JsoncError("unterminated object");
    if (text[pos] !== '"') throw new JsoncError(`expected a key at ${pos}`);
    const keyEnd = skipString(text, pos);
    const key = JSON.parse(text.slice(pos, keyEnd)) as string;
    let p = skip(text, keyEnd);
    if (text[p] !== ":") throw new JsoncError(`expected ':' at ${p}`);
    p = skip(text, p + 1);
    const valueStart = p;
    const node = parseValueAt(text, p);
    const valueEnd = node.kind === "object" ? node.close + 1 : node.end;
    entries.push({ key, start: pos, valueStart, valueEnd });
    p = skip(text, valueEnd);
    if (text[p] === ",") p = skip(text, p + 1);
    pos = p;
  }
  return { kind: "object", open, close: pos, entries };
}

function skipValue(text: string, pos: number): number {
  const c = text[pos];
  if (c === '"') return skipString(text, pos);
  if (c === "{") return parseObject(text, pos).close + 1;
  if (c === "[") {
    let p = skip(text, pos + 1);
    while (text[p] !== "]") {
      if (p >= text.length) throw new JsoncError("unterminated array");
      p = skip(text, skipValue(text, p));
      if (text[p] === ",") p = skip(text, p + 1);
    }
    return p + 1;
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
  if (!m) throw new JsoncError(`unexpected character at ${pos}`);
  return pos + m[0].length;
}

function skipString(text: string, pos: number): number {
  let p = pos + 1;
  while (p < text.length) {
    if (text[p] === "\\") p += 2;
    else if (text[p] === '"') return p + 1;
    else p++;
  }
  throw new JsoncError("unterminated string");
}

/** Skips whitespace and comments. */
function skip(text: string, pos: number): number {
  let p = pos;
  for (;;) {
    while (p < text.length && /\s/.test(text[p] as string)) p++;
    if (text.startsWith("//", p)) {
      const nl = text.indexOf("\n", p);
      p = nl === -1 ? text.length : nl + 1;
    } else if (text.startsWith("/*", p)) {
      const end = text.indexOf("*/", p + 2);
      if (end === -1) throw new JsoncError("unterminated comment");
      p = end + 2;
    } else return p;
  }
}

/** Adds `entry` as the first member of `obj` (before anything else, so trailing commas don't matter). */
function insertEntry(text: string, obj: ObjectNode, entry: string, indent: string): string {
  const empty = obj.entries.length === 0;
  const before = text.slice(0, obj.open + 1);
  const after = text.slice(obj.open + 1);
  if (empty) {
    const closingIndent = indent.slice(2);
    return `${before}\n${indent}${entry}\n${closingIndent}${after.replace(/^\s*/, "")}`;
  }
  return `${before}\n${indent}${entry},${after.startsWith("\n") ? "" : "\n"}${after}`;
}

/** Removes `entry` from `obj`, with its comma and line. */
function removeEntry(text: string, obj: ObjectNode, entry: Entry): string {
  const index = obj.entries.indexOf(entry);
  const next = obj.entries[index + 1];
  let start = entry.start;
  // Take the line's indentation too.
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
  let end: number;
  if (next) {
    end = next.start;
    while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  } else {
    end = skip(text, entry.valueEnd);
    if (text[end] === ",") end++;
    // Drop a comma left on the previous member.
    const prev = obj.entries[index - 1];
    if (prev) {
      const between = text.slice(prev.valueEnd, start);
      const comma = between.indexOf(",");
      if (comma !== -1) {
        const cut = prev.valueEnd + comma;
        return (
          text.slice(0, cut) +
          text.slice(cut + 1, start).replace(/[ \t]*$/, "") +
          text.slice(end).replace(/^[ \t]*/, "")
        );
      }
    }
  }
  return text.slice(0, start) + text.slice(end);
}

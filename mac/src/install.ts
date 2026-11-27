import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { assertWritable, writeFileAtomic } from "./atomicWrite.ts";
import { CHILD_PATH, paths } from "./config.ts";
import type { ServiceContext } from "./platform/index.ts";

export const BIN_DIR = join(paths.home, "bin");
export const HOOK_BIN = join(BIN_DIR, "relay-hook");
export const RELAY_BIN = join(BIN_DIR, "relay");
/** The program `claude` runs in new terminals: Relay's wrapper, found first in PATH. */
export const WRAP_BIN = join(BIN_DIR, "claude");
export const DEFAULT_SETTINGS = join(homedir(), ".claude", "settings.json");

/**
 * Which Claude Code settings file install writes. `--settings` wins; an install the helper runs itself
 * (update, pair) keeps the file the person chose earlier; otherwise the default.
 */
export function chooseSettingsPath(opts: { flag?: string; saved?: string; byHelper: boolean }): string {
  // A flag is resolved against the directory the command runs in, so the saved choice names one file everywhere.
  if (opts.flag !== undefined) return resolve(opts.flag);
  return (opts.byHelper ? savedSettingsPath(opts.saved) : undefined) ?? DEFAULT_SETTINGS;
}

/** The settings file saved in config.json. A relative one (saved by older versions) names no single file: ignored. */
export function savedSettingsPath(saved: string | undefined): string | undefined {
  return saved !== undefined && isAbsolute(saved) ? saved : undefined;
}

/**
 * Recognises Relay's own entries: a command whose program is a file named exactly `relay-hook`, wherever it
 * lives. Someone else's `slack-relay-hook.sh` is not Relay's.
 */
const RELAY_HOOK_COMMAND = /(^|[/\\])relay-hook(["']?)(\s|$)/;

export function isRelayCommand(command: string | undefined): boolean {
  return command !== undefined && RELAY_HOOK_COMMAND.test(command.trim());
}

type HookCommand = { type: "command"; command: string; timeout?: number; async?: boolean };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HooksConfig = Record<string, HookGroup[]>;

/**
 * Relay's hook wiring. Only PermissionRequest and Elicitation block (they are the prompt race); everything else is async,
 * so Relay never adds latency to Claude's turn.
 */
export function relayHooks(hookBin: string): HooksConfig {
  const asyncHook = (timeout = 30): HookGroup[] => [
    { hooks: [{ type: "command", command: hookBin, timeout, async: true }] },
  ];
  return {
    SessionStart: asyncHook(),
    UserPromptSubmit: asyncHook(),
    // The model after a switch (the phone's model pill); present in Claude Code 2.1.325.
    PostModelSwitch: asyncHook(),
    PermissionRequest: [{ hooks: [{ type: "command", command: hookBin, timeout: 86_400 }] }],
    // An MCP server's question: the phone answers a one-field choice, anything else is left to the terminal.
    Elicitation: [{ hooks: [{ type: "command", command: hookBin, timeout: 86_400 }] }],
    // The live step (turn-steps). Async, so it never holds the tool: checked on Claude Code 2.1.318.
    PreToolUse: asyncHook(),
    PostToolUse: asyncHook(),
    PostToolUseFailure: asyncHook(),
    PermissionDenied: asyncHook(),
    Stop: asyncHook(),
    StopFailure: asyncHook(),
    // A `/compact` submits no prompt: this is where its turn starts.
    PreCompact: asyncHook(),
    Notification: asyncHook(),
    SessionEnd: [{ hooks: [{ type: "command", command: hookBin, timeout: 5 }] }],
  };
}

/** Pure: returns new settings with Relay's hooks, replacing older Relay entries and keeping everyone else's. */
export function mergeHooks(settings: Record<string, unknown>, hookBin: string): Record<string, unknown> {
  const hooks = { ...((settings.hooks as HooksConfig | undefined) ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const remaining = group.hooks.filter((h) => !isRelayCommand(h.command));
      if (remaining.length) kept.push({ ...group, hooks: remaining });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const [event, groups] of Object.entries(relayHooks(hookBin))) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return { ...settings, hooks };
}

/** Pure: removes Relay's entries only. */
export function removeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = { ...((settings.hooks as HooksConfig | undefined) ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isRelayCommand(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...settings, hooks };
}

/** How many of Relay's own hook entries the settings hold. */
export function countHooks(settings: Record<string, unknown>): number {
  const hooks = (settings.hooks as HooksConfig | undefined) ?? {};
  return Object.values(hooks)
    .flat()
    .flatMap((g) => g.hooks)
    .filter((h) => isRelayCommand(h.command)).length;
}

/**
 * Relay's status line command: relay-hook run as `relay-hook statusline`, optionally quoted, optionally followed by
 * the key of the settings file it was installed into (see `statusLineKey`).
 */
const RELAY_STATUSLINE_COMMAND = /(^|[/\\])relay-hook(["']?)\s+statusline(?:\s+([0-9a-f]{8}))?\s*$/;

type StatusLine = { type?: string; command?: string; padding?: number } & Record<string, unknown>;

function isRelayStatusLine(value: unknown): boolean {
  const command = (value as StatusLine | undefined)?.command;
  return typeof command === "string" && RELAY_STATUSLINE_COMMAND.test(command.trim());
}

/** The key in a Relay status line command, or undefined for one without (written before keys). */
function keyOf(value: unknown): string | undefined {
  const command = (value as StatusLine | undefined)?.command;
  return typeof command === "string" ? RELAY_STATUSLINE_COMMAND.exec(command.trim())?.[3] : undefined;
}

/**
 * Names one settings file in the saved status lines. Every settings file points at the same relay-hook, so the
 * command carries this key and `relay-hook statusline` knows whose status line to run.
 */
export function statusLineKey(settingsPath: string): string {
  return createHash("sha256").update(resolve(settingsPath)).digest("hex").slice(0, 8);
}

/**
 * The person's own status lines, saved so uninstall can give them back: `files` by settings-file key,
 * `previous` the shared one from older installs.
 */
export type SavedStatusLine = { previous: StatusLine | null; files?: Record<string, StatusLine | null> };

/** The status line saved for a Relay status line command: its file's own, or the old shared one without a key. */
export function savedStatusLineFor(saved: SavedStatusLine | null, command: unknown): StatusLine | null {
  const key = keyOf({ command });
  if (key === undefined) return saved?.previous ?? null;
  return saved?.files?.[key] ?? null;
}

/**
 * Pure: puts Relay's status line in the settings (usage-left). One the person already had is kept in `saved` and
 * run by Relay's script with the same input, so it looks the same. Installing again keeps what was saved before.
 */
export function mergeStatusLine(
  settings: Record<string, unknown>,
  hookBin: string,
  saved: SavedStatusLine | null,
  key?: string,
): { settings: Record<string, unknown>; saved: SavedStatusLine } {
  const current = settings.statusLine as StatusLine | undefined;
  const previous = isRelayStatusLine(current)
    ? savedStatusLineFor(saved, current?.command)
    : (current ?? null);
  // Everything else of theirs (padding, refreshInterval, hideVimModeIndicator, ...) keeps working.
  const command = key === undefined ? `${hookBin} statusline` : `${hookBin} statusline ${key}`;
  const ours: StatusLine = { ...previous, type: "command", command };
  if (key === undefined) return { settings: { ...settings, statusLine: ours }, saved: { previous } };
  // The other files' status lines stay as they were; the shared one stays for files still on the old command.
  return {
    settings: { ...settings, statusLine: ours },
    saved: { previous: saved?.previous ?? null, files: { ...saved?.files, [key]: previous } },
  };
}

/** True when the settings hold a Relay hook or Relay's status line: what uninstall has to take out. */
export function hasRelayEntries(settings: Record<string, unknown>): boolean {
  return countHooks(settings) > 0 || isRelayStatusLine(settings.statusLine);
}

/** Pure: gives the person's own status line back, or removes Relay's when there was none. Others' are left alone. */
export function removeStatusLine(
  settings: Record<string, unknown>,
  saved: SavedStatusLine | null,
): Record<string, unknown> {
  if (!isRelayStatusLine(settings.statusLine)) return settings;
  const { statusLine: _ours, ...rest } = settings;
  const previous = savedStatusLineFor(saved, (settings.statusLine as StatusLine).command);
  return previous ? { ...rest, statusLine: previous } : rest;
}

export const STATUSLINE_SAVED = join(paths.home, "statusline.json");

export function readSavedStatusLine(path = STATUSLINE_SAVED): SavedStatusLine | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SavedStatusLine;
  } catch {
    return null;
  }
}

export function writeSavedStatusLine(saved: SavedStatusLine, path = STATUSLINE_SAVED): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(saved, null, 2)}\n`, 0o600);
}

export function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Backs up, then writes atomically (tmp + rename) so a crash never leaves a half-written settings file. */
export function writeSettings(path: string, settings: Record<string, unknown>): string | null {
  mkdirSync(dirname(path), { recursive: true });
  assertWritable(path);
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.relay-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  return backup;
}

/** What the platform's service manager needs to run `relay daemon` at login. */
export function serviceContext(): ServiceContext {
  const path = [...new Set([join(homedir(), ".local", "bin"), ...CHILD_PATH.split(delimiter)])].join(
    delimiter,
  );
  return { relayBin: RELAY_BIN, home: paths.home, logPath: paths.log, path };
}

/**
 * `relay uninstall --purge`: deletes Relay's data directory, paired phones included. Refuses the filesystem
 * root or the home directory, in case RELAY_HOME points there. Returns false when nothing was there.
 */
export function purgeData(home: string, userHome = homedir()): boolean {
  const dir = resolve(home);
  if (dir === parse(dir).root || dir === resolve(userHome))
    throw new Error(`refusing to delete ${dir}: it isn't a Relay data directory`);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

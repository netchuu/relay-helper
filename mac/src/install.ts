import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, parse, resolve } from "node:path";
import { CHILD_PATH, paths } from "./config.ts";
import type { ServiceContext } from "./platform/index.ts";

export const BIN_DIR = join(paths.home, "bin");
export const HOOK_BIN = join(BIN_DIR, "relay-hook");
export const RELAY_BIN = join(BIN_DIR, "relay");
export const DEFAULT_SETTINGS = join(homedir(), ".claude", "settings.json");

/** Marker used to recognise Relay's own entries (idempotent install/uninstall). */
const RELAY_MARKER = "relay-hook";

type HookCommand = { type: "command"; command: string; timeout?: number; async?: boolean };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HooksConfig = Record<string, HookGroup[]>;

/**
 * Relay's hook wiring. Only PermissionRequest blocks (it is the prompt race); everything else is async,
 * so Relay never adds latency to Claude's turn.
 */
export function relayHooks(hookBin: string): HooksConfig {
  const asyncHook = (timeout = 30): HookGroup[] => [
    { hooks: [{ type: "command", command: hookBin, timeout, async: true }] },
  ];
  return {
    SessionStart: asyncHook(),
    UserPromptSubmit: asyncHook(),
    PermissionRequest: [{ hooks: [{ type: "command", command: hookBin, timeout: 86_400 }] }],
    // The live step (turn-steps). Async, so it never holds the tool: checked on Claude Code 2.1.318.
    PreToolUse: asyncHook(),
    PostToolUse: asyncHook(),
    PostToolUseFailure: asyncHook(),
    PermissionDenied: asyncHook(),
    Stop: asyncHook(),
    StopFailure: asyncHook(),
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
      const remaining = group.hooks.filter((h) => !h.command?.includes(RELAY_MARKER));
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
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command?.includes(RELAY_MARKER)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...settings, hooks };
}

/** How many of Relay's own hook entries the settings hold. */
export function countHooks(settings: Record<string, unknown>): number {
  const needle = RELAY_MARKER;
  const hooks = (settings.hooks as HooksConfig | undefined) ?? {};
  return Object.values(hooks)
    .flat()
    .flatMap((g) => g.hooks)
    .filter((h) => h.command?.includes(needle)).length;
}

export function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Backs up, then writes atomically (tmp + rename) so a crash never leaves a half-written settings file. */
export function writeSettings(path: string, settings: Record<string, unknown>): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.relay-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.relay-tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
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
 * `relay uninstall --purge`: deletes Relay's data directory (~/.relay), with the paired phones, the keys made at
 * pairing, the database, attachments and logs. A phone paired before can't reach this computer again. Refuses a
 * directory that is the filesystem root or the home directory itself, in case RELAY_HOME points there.
 * Returns false when there was nothing to delete.
 */
export function purgeData(home: string, userHome = homedir()): boolean {
  const dir = resolve(home);
  if (dir === parse(dir).root || dir === resolve(userHome))
    throw new Error(`refusing to delete ${dir}: it isn't a Relay data directory`);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

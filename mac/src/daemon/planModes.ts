import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seenModesOf } from "./held.ts";

export type ApprovalMode = "bypassPermissions" | "auto";

export interface PlanModeFacts {
  sessionId: string;
  cwd: string | null;
  /** The Claude Code process's command line, when it can be read. */
  args: string | null;
  home?: string;
}

function settingsAt(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function permissionsOf(settings: Record<string, unknown>): Record<string, unknown> {
  const p = settings.permissions;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/**
 * The extra choices Claude Code's plan dialog shows for a session: bypass permissions when the session was
 * started with it available (flag, or `defaultMode` in the user's settings) or has been in it, auto mode when the
 * session has been in it or the user's settings start in it. A `disable…Mode` key in any settings file removes it.
 * A project or local `defaultMode` of bypassPermissions or auto doesn't count: Claude Code ignores it there.
 */
export function planApprovalModes(facts: PlanModeFacts): ApprovalMode[] {
  const home = facts.home ?? homedir();
  const files = [join(home, ".claude", "settings.json")];
  if (facts.cwd)
    files.push(
      join(facts.cwd, ".claude", "settings.json"),
      join(facts.cwd, ".claude", "settings.local.json"),
    );
  const raw = files.map((f) => settingsAt(f));
  const all = raw.map(permissionsOf);
  const userDefault = all[0]?.defaultMode;
  const seen = seenModesOf(facts.sessionId);
  const args = facts.args ?? "";
  const out: ApprovalMode[] = [];
  const bypassOff = all.some((p) => p.disableBypassPermissionsMode === "disable");
  const bypassFlag =
    /(^|\s)--(dangerously-skip-permissions|allow-dangerously-skip-permissions)(\s|$)/.test(args) ||
    /(^|\s)--permission-mode[ =]bypassPermissions(\s|$)/.test(args);
  if (!bypassOff && (seen.has("bypassPermissions") || bypassFlag || userDefault === "bypassPermissions"))
    out.push("bypassPermissions");
  const autoOff =
    all.some((p) => p.disableAutoMode === "disable") || raw.some((s) => s.disableAutoMode === "disable");
  if (!autoOff && (seen.has("auto") || userDefault === "auto")) out.push("auto");
  return out;
}

/** A process's command line (`ps`), or null when it can't be read. Synchronous: the prompt opens right away. */
export function processArgs(pid: number | null): string | null {
  if (!pid) return null;
  try {
    const out = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    return out.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

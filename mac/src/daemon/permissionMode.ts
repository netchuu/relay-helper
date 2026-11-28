/** Switching Claude Code's permission mode the way the terminal does: Shift+Tab, until the footer shows the mode. */
import { notePermissionMode, noteSeenModes, seenModesOf } from "./held.ts";
import type { TypeOps } from "./inject.ts";

/** The modes the phone offers for any session; the rest join once the session has shown them. */
const ALWAYS = ["default", "acceptEdits", "plan"];
const OPTIONAL = ["bypassPermissions", "auto"];

/** What the phone's menu offers: the three modes every session cycles through, plus any other the session has been in. */
export function offeredModes(sessionId: string): string[] {
  const seen = seenModesOf(sessionId);
  return [...ALWAYS, ...OPTIONAL.filter((m) => seen.has(m))];
}

const FOOTER: [RegExp, string][] = [
  [/bypass permissions on/i, "bypassPermissions"],
  [/accept edits on/i, "acceptEdits"],
  [/plan mode on/i, "plan"],
  [/auto mode on/i, "auto"],
  [/don'?t ask on/i, "dontAsk"],
  [/manual mode on|\? for shortcuts/i, "default"],
];

/** The mode in the footer of Claude Code's screen; null when the footer isn't readable (a dialog covers it). */
export function modeFromScreen(screen: string): string | null {
  const tail = screen
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6);
  for (let i = tail.length - 1; i >= 0; i--)
    for (const [pattern, mode] of FOOTER) if (pattern.test(tail[i] as string)) return mode;
  return null;
}

export class ModeSwitchError extends Error {}

export interface SwitchTarget {
  id: string;
  ptySocket: string | null;
  ptyToken: string | null;
  pid: number | null;
}

export interface SwitchOptions {
  /** How long to wait for the footer to change after one press. */
  settleMs?: number;
  /** Presses before giving up: a full turn of the cycle with every optional mode in it. */
  maxPresses?: number;
}

/** Presses Shift+Tab until the footer shows `target`; returns the mode shown. Throws ModeSwitchError with a sentence for the phone. */
export async function switchPermissionMode(
  session: SwitchTarget,
  target: string,
  ops: Pick<TypeOps, "ptyScreen" | "ptyShiftTab">,
  opts: SwitchOptions = {},
): Promise<string> {
  const { settleMs = 1500, maxPresses = 6 } = opts;
  const { ptySocket, ptyToken, pid } = session;
  if (!ptySocket || !ptyToken || !pid || !ops.ptyScreen || !ops.ptyShiftTab)
    throw new ModeSwitchError("This session's mode can't be changed from the phone.");
  const { ptyScreen, ptyShiftTab } = ops;
  const read = async () => {
    const screen = await ptyScreen(ptySocket, ptyToken);
    return screen === null ? null : modeFromScreen(screen);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let shown = await read();
  if (shown === null) throw new ModeSwitchError("Claude Code's screen can't be read right now.");
  noteShown(session.id, shown);
  if (shown === target) return shown;
  const covered = new ModeSwitchError(
    "Claude Code is showing a question. Answer it at the computer, then try again.",
  );
  for (let press = 0; press < maxPresses; press++) {
    if (press > 0) {
      shown = await read();
      if (shown === null) throw covered;
      noteShown(session.id, shown);
      if (shown === target) return shown;
    }
    const reply = await ptyShiftTab(ptySocket, ptyToken, pid).catch(() => null);
    if (!reply?.ok)
      throw new ModeSwitchError(
        reply?.reason === "not_foreground"
          ? "Claude Code isn't in front at the computer."
          : "This session's mode can't be changed from the phone.",
      );
    const before: string | null = shown;
    const until = Date.now() + settleMs;
    for (;;) {
      await sleep(50);
      shown = await read();
      if ((shown !== null && shown !== before) || Date.now() >= until) break;
    }
    if (shown === null) throw covered;
    noteShown(session.id, shown);
    if (shown === target) return shown;
  }
  throw new ModeSwitchError(
    `Claude Code didn't switch to ${modeWords(target)}. Press Shift+Tab at the computer.`,
  );
}

function noteShown(sessionId: string, mode: string): void {
  noteSeenModes(sessionId, mode);
  notePermissionMode(sessionId, mode);
}

const WORDS: Record<string, string> = {
  default: "manual mode",
  acceptEdits: "accept edits",
  plan: "plan mode",
  auto: "auto mode",
  bypassPermissions: "bypass permissions",
};

function modeWords(mode: string): string {
  return WORDS[mode] ?? mode;
}

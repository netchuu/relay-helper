import { delimiter } from "node:path";
import { CHILD_PATH } from "../config.ts";
import { cleanTypedText } from "../shell/typedText.ts";

/**
 * Typing into a WezTerm pane or a kitty window through the terminal's own command line (`wezterm cli send-text`,
 * `kitty @ send-text`). The session's environment names the pane (WEZTERM_PANE, KITTY_WINDOW_ID) and, for kitty, the
 * remote-control socket (KITTY_LISTEN_ON, set only when the user turned remote control on).
 */
export type PaneTarget =
  | { kind: "wezterm"; pane: string; socket: string | null }
  | { kind: "kitty"; listenOn: string; windowId: string };

/** What the registry stores for a session (registry.ts). */
export interface PaneFields {
  weztermPane: string | null;
  weztermSocket: string | null;
  kittyListenOn: string | null;
  kittyWindowId: string | null;
}

/** The pane a session was started in, when its terminal lets Relay type there; null otherwise (the inbox). */
export function paneTargetOf(s: PaneFields): PaneTarget | null {
  if (s.weztermPane && /^\d+$/.test(s.weztermPane))
    return { kind: "wezterm", pane: s.weztermPane, socket: s.weztermSocket };
  if (s.kittyListenOn && s.kittyWindowId && /^\d+$/.test(s.kittyWindowId))
    return { kind: "kitty", listenOn: s.kittyListenOn, windowId: s.kittyWindowId };
  return null;
}

/** What a terminal can tell about a pane: its tty (WezTerm) or the processes in front in it (kitty). */
export interface PaneInfo {
  tty?: string;
  pids?: number[];
}

/** One command of a typing sequence: the arguments after the program, and what goes in on stdin. */
export interface PaneStep {
  args: string[];
  stdin?: string;
  waitMs?: number;
}

/** Where the terminals put their program on macOS when it isn't linked into a directory on PATH. */
const APP_DIRS = ["/Applications/WezTerm.app/Contents/MacOS", "/Applications/kitty.app/Contents/MacOS"];

function childEnv(target: PaneTarget): Record<string, string> {
  const path = [process.env.PATH ?? "", CHILD_PATH, ...APP_DIRS].filter(Boolean).join(delimiter);
  return target.kind === "wezterm" && target.socket
    ? { PATH: path, WEZTERM_UNIX_SOCKET: target.socket }
    : { PATH: path };
}

function program(target: PaneTarget): string[] {
  return target.kind === "wezterm"
    ? ["wezterm", "cli", "--no-auto-start"]
    : ["kitty", "@", "--to", target.listenOn];
}

function matchArgs(target: PaneTarget): string[] {
  return target.kind === "wezterm" ? ["--pane-id", target.pane] : ["--match", `id:${target.windowId}`];
}

/** `send-text` for `text`: typed key by key, or pasted (a newline or a tab typed would be Enter or Tab). */
function sendText(target: PaneTarget, text: string, paste: boolean): PaneStep {
  const base = [...program(target), "send-text", ...matchArgs(target)];
  if (target.kind === "wezterm") return { args: [...base, ...(paste ? [] : ["--no-paste"])], stdin: text };
  return { args: [...base, "--stdin", ...(paste ? ["--bracketed-paste", "auto"] : [])], stdin: text };
}

/** Enter alone. */
export function paneEnterSteps(target: PaneTarget): PaneStep[] {
  return [sendText(target, "\r", false)];
}

/** Ctrl+S alone: Claude Code's stash key. */
export function paneStashSteps(target: PaneTarget): PaneStep[] {
  return [sendText(target, "\u0013", false)];
}

/** Ctrl+C alone: clears the prompt's text. */
export function paneClearSteps(target: PaneTarget): PaneStep[] {
  return [sendText(target, "\u0003", false)];
}

/** Esc alone. */
export function paneEscapeSteps(target: PaneTarget): PaneStep[] {
  return [sendText(target, "\u001b", false)];
}

/** The letter x alone: Claude Code's `/tasks` list stops the task under the cursor with it. */
export function paneXSteps(target: PaneTarget): PaneStep[] {
  return [sendText(target, "x", false)];
}

/** An arrow key alone. */
export function paneArrowSteps(target: PaneTarget, key: "up" | "down"): PaneStep[] {
  return [sendText(target, key === "up" ? "\u001b[A" : "\u001b[B", false)];
}

/**
 * The commands that type a message: the text (pasted when it holds a newline or tab, so it stays one message), each
 * attachment path pasted on its own, then Enter.
 */
export function paneTypeSteps(
  target: PaneTarget,
  text: string,
  split: (text: string) => { body: string; paths: string[] },
): PaneStep[] {
  const { body, paths } = split(cleanTypedText(text));
  const steps: PaneStep[] = [];
  if (body) steps.push(sendText(target, body, /[\n\t]/.test(body)));
  for (const path of paths) {
    if (steps.length > 0) steps.push(sendText(target, " ", false));
    steps.push(sendText(target, path, true));
  }
  // Let Claude Code turn a pasted path into its image before Enter (an Enter right after it is lost).
  const [enter] = paneEnterSteps(target);
  if (enter) steps.push(paths.length > 0 ? { ...enter, waitMs: 300 } : enter);
  return steps;
}

/** A step failed after text had already gone into the prompt. */
export class PartlyTyped extends Error {}

/** Runs the steps in order (each one's `args` start with the terminal's program). */
async function runSteps(target: PaneTarget, steps: PaneStep[], what: string): Promise<void> {
  let typed = false;
  for (const step of steps) {
    if (step.waitMs) await Bun.sleep(step.waitMs);
    const res = await execFull(target, step.args, step.stdin);
    if (res.code !== 0) {
      const msg = `${target.kind} ${what} failed (${res.code})`;
      throw typed ? new PartlyTyped(msg) : new Error(msg);
    }
    typed = true;
  }
}

async function execFull(
  target: PaneTarget,
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string }> {
  const [bin, ...rest] = args;
  if (!bin) return { code: 127, out: "" };
  try {
    const proc = Bun.spawn([bin, ...rest], {
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "ignore",
      env: childEnv(target),
    });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  } catch {
    return { code: 127, out: "" };
  }
}

export async function paneType(
  target: PaneTarget,
  text: string,
  split: (text: string) => { body: string; paths: string[] },
): Promise<void> {
  await runSteps(target, paneTypeSteps(target, text, split), "send-text");
}

export async function paneEnter(target: PaneTarget): Promise<void> {
  await runSteps(target, paneEnterSteps(target), "send-text");
}

export async function paneStash(target: PaneTarget): Promise<void> {
  await runSteps(target, paneStashSteps(target), "send-text");
}

export async function paneClear(target: PaneTarget): Promise<void> {
  await runSteps(target, paneClearSteps(target), "send-text");
}

export async function paneArrow(target: PaneTarget, key: "up" | "down"): Promise<void> {
  await runSteps(target, paneArrowSteps(target, key), "send-text");
}

export async function paneX(target: PaneTarget): Promise<void> {
  await runSteps(target, paneXSteps(target), "send-text");
}

export async function paneEscape(target: PaneTarget): Promise<void> {
  await runSteps(target, paneEscapeSteps(target), "send-text");
}

/** The pane's visible text with its escape codes (the dim attribute marks a suggestion), or null when it can't be read. */
export async function paneScreen(target: PaneTarget): Promise<string | null> {
  const args =
    target.kind === "wezterm"
      ? [...program(target), "get-text", ...matchArgs(target), "--escapes"]
      : [...program(target), "get-text", ...matchArgs(target), "--ansi"];
  const res = await execFull(target, args);
  return res.code === 0 ? res.out : null;
}

/** The tty of a WezTerm pane, or the foreground processes of a kitty window; null when the terminal can't tell. */
export async function paneInfo(target: PaneTarget): Promise<PaneInfo | null> {
  if (target.kind === "wezterm") {
    const res = await execFull(target, [...program(target), "list", "--format", "json"]);
    if (res.code !== 0) return null;
    return weztermPaneInfo(res.out, target.pane);
  }
  const res = await execFull(target, [...program(target), "ls", ...matchArgs(target)]);
  if (res.code !== 0) return null;
  return kittyWindowInfo(res.out, target.windowId);
}

export function weztermPaneInfo(json: string, pane: string): PaneInfo | null {
  try {
    const list = JSON.parse(json) as { pane_id?: number; tty_name?: string }[];
    const hit = list.find((p) => String(p.pane_id) === pane);
    return hit?.tty_name ? { tty: hit.tty_name } : null;
  } catch {
    return null;
  }
}

export function kittyWindowInfo(json: string, windowId: string): PaneInfo | null {
  try {
    const oses = JSON.parse(json) as {
      tabs?: { windows?: { id?: number; foreground_processes?: { pid?: number }[] }[] }[];
    }[];
    for (const os of oses)
      for (const tab of os.tabs ?? [])
        for (const w of tab.windows ?? [])
          if (String(w.id) === windowId)
            return {
              pids: (w.foreground_processes ?? []).map((p) => p.pid).filter((p): p is number => !!p),
            };
    return null;
  } catch {
    return null;
  }
}

/** The two lines `kitty.conf` needs for Relay to type into kitty windows. */
export const KITTY_CONF_LINES = ["allow_remote_control socket-only", "listen_on unix:/tmp/kitty"];

/**
 * What `relay doctor` says about sessions in kitty windows: Relay types there only when kitty's remote control is
 * on (KITTY_LISTEN_ON is set). Null when no session is in a kitty window without it.
 */
export function kittyDoctorNote(sessions: PaneFields[]): string | null {
  const without = sessions.filter((s) => s.kittyWindowId && !s.kittyListenOn);
  if (without.length === 0) return null;
  return `kitty: remote control is off, so replies to ${without.length === 1 ? "a session" : `${without.length} sessions`} in kitty arrive as a message from another session. Add to kitty.conf and restart kitty: ${KITTY_CONF_LINES.join(" and ")}`;
}

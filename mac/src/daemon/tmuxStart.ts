import { join } from "node:path";
import { CHILD_PATH, paths } from "../config.ts";

/** Where a session started from the phone runs: a tmux pane the helper can type into, like a session started in tmux by hand. */
export interface TerminalPane {
  socket: string;
  pane: string;
  /** Claude Code's own process: the pane runs it directly, with no shell in between. */
  pid: number;
}

export interface TerminalLauncher {
  /** Starts `cmd` in `cwd` in a new detached pane. */
  launch(cmd: string[], cwd: string, name: string): Promise<TerminalPane>;
  /** The pane's text and whether its process has exited; null when the pane is gone. */
  look(pane: TerminalPane): Promise<{ screen: string; exited: boolean } | null>;
  close(pane: TerminalPane): Promise<void>;
  /** Lets the pane go away when its process exits; it was kept only to read a refusal at startup. */
  release(pane: TerminalPane): Promise<void>;
}

/** tmux reads an argument ending in ";" as the end of a command; a backslash before it keeps the text whole. */
export function tmuxArg(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

async function tmux(socket: string, args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["tmux", "-S", socket, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH, ...(process.env.LANG ? { LANG: process.env.LANG } : {}) },
  });
  const out = await new Response(proc.stdout).text();
  return { out, code: await proc.exited };
}

/** Its own tmux server, so the user's tmux and its settings are never touched. */
export const tmuxLauncher: TerminalLauncher = {
  async launch(cmd, cwd, name) {
    const socket = join(paths.home, "tmux.sock");
    // remain-on-exit keeps a Claude Code that refused to start on screen, so its words can be read.
    const { out, code } = await tmux(socket, [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id} #{pane_pid}",
      "-s",
      name,
      "-c",
      cwd,
      "--",
      ...cmd.map(tmuxArg),
      ";",
      "set-option",
      "-g",
      "remain-on-exit",
      "on",
    ]);
    const [pane, pid] = out.trim().split(" ");
    if (code !== 0 || !pane || !Number.isInteger(Number(pid)))
      throw new Error("tmux couldn't start the pane");
    return { socket, pane, pid: Number(pid) };
  },
  async look({ socket, pane }) {
    const state = await tmux(socket, ["display-message", "-p", "-t", pane, "#{pane_dead}"]);
    if (state.code !== 0) return null;
    const screen = await tmux(socket, ["capture-pane", "-p", "-e", "-t", pane]);
    return screen.code === 0 ? { screen: screen.out, exited: state.out.trim() === "1" } : null;
  },
  async close({ socket, pane }) {
    await tmux(socket, ["kill-pane", "-t", pane]);
  },
  async release({ socket, pane }) {
    await tmux(socket, ["set-option", "-p", "-t", pane, "remain-on-exit", "off"]);
  },
};

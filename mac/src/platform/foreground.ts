import { run } from "./exec.ts";

/**
 * Whether Claude Code is the program in front of a terminal, so a reply typed there reaches Claude and not a shell.
 * When Claude Code is suspended (Ctrl-Z), has exited, or another program runs in front of it, keys typed into the
 * terminal go to the shell or that program, outside Claude's permission prompts.
 *
 * A terminal has one foreground process group; the shell hands it to the job it starts in front. Claude Code's
 * own children (tools, MCP servers) stay in its group, so "Claude's group is the terminal's foreground group" is
 * the test. `relay shell` makes the same check for its own tab (shell/ptyShell.ts).
 */

export interface Proc {
  pid: number;
  /** Process group. */
  pgid: number;
  /** The foreground process group of the process's terminal; 0 or -1 without a terminal. */
  tpgid: number;
  /** The terminal's name as `ps` shows it (`ttys004`, `pts/3`); `??` or `?` without one. */
  tty: string;
  command: string;
}

/** The `ps` call `parseProcs` reads. */
export const PS_ARGS = ["ps", "-A", "-o", "pid=,pgid=,tpgid=,tty=,command="];

export function parseProcs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m)
      procs.push({
        pid: Number(m[1]),
        pgid: Number(m[2]),
        tpgid: Number(m[3]),
        tty: m[4] ?? "",
        command: m[5] ?? "",
      });
  }
  return procs;
}

/** How a `claude` program shows in `ps` (the same test viewerTtyOf uses for a session's viewer). */
const CLAUDE_COMMAND = /^(\S*\/)?claude(\s|$)/;

/**
 * Whether the Claude Code process `pid` is in front:
 * - without `tty` (tmux, where the pane is the process's own terminal): `pid`'s group is the foreground group of
 *   its own terminal;
 * - with `tty` (the tab Relay would type into): when `pid` runs on that terminal, the same; when it doesn't (a
 *   session Claude Code runs in a background host, shown in the tab by a `claude` viewer), the tab's foreground
 *   group is a `claude` program.
 * False when `pid` isn't running any more, or has no terminal.
 */
export function inFront(procs: Proc[], pid: number, tty: string | null): boolean {
  const me = procs.find((p) => p.pid === pid);
  if (!me) return false;
  const name = tty === null ? me.tty : tty.replace(/^\/dev\//, "");
  if (!name || name === "?" || name === "??") return false;
  if (me.tty === name) return me.tpgid > 0 && me.pgid === me.tpgid;
  const onTty = procs.filter((p) => p.tty === name);
  const fg = onTty[0]?.tpgid ?? 0;
  return fg > 0 && onTty.some((p) => p.pgid === fg && CLAUDE_COMMAND.test(p.command));
}

/** `inFront`, read from the system now. False when `ps` fails. */
export async function claudeInFront(pid: number, tty: string | null): Promise<boolean> {
  const res = await run(PS_ARGS, { timeoutMs: 5000 });
  return res.code === 0 && inFront(parseProcs(res.out), pid, tty);
}

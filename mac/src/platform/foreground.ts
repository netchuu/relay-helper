import { run } from "./exec.ts";

/** Whether Claude Code is in front of a terminal: its process group is the terminal's foreground group. */

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

/** Whether `pid` is in front of its terminal, or of `tty` when a `claude` viewer there stands in for it. */
export function inFront(procs: Proc[], pid: number, tty: string | null, others: number[] = []): boolean {
  const me = procs.find((p) => p.pid === pid);
  if (!me) return false;
  const name = tty === null ? me.tty : tty.replace(/^\/dev\//, "");
  if (!name || name === "?" || name === "??") return false;
  if (me.tty === name) return me.tpgid > 0 && me.pgid === me.tpgid;
  const onTty = procs.filter((p) => p.tty === name);
  const fg = onTty[0]?.tpgid ?? 0;
  // A `claude` that is another known session's own process is not this session's viewer.
  return (
    fg > 0 && onTty.some((p) => p.pgid === fg && CLAUDE_COMMAND.test(p.command) && !others.includes(p.pid))
  );
}

/** `inFront`, read from the system now. False when `ps` fails. */
export async function claudeInFront(
  pid: number,
  tty: string | null,
  others: number[] = [],
): Promise<boolean> {
  const res = await run(PS_ARGS, { timeoutMs: 5000 });
  return res.code === 0 && inFront(parseProcs(res.out), pid, tty, others);
}

import { run } from "./exec.ts";

/** Whether Claude Code is in front of a terminal: its process group is the terminal's foreground group. */

export interface Proc {
  pid: number;
  /** Parent process; only in a snapshot (`PS_SNAPSHOT_ARGS`). */
  ppid?: number;
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

/** One `ps` that answers every question about a delivery's processes: terminal, parent and foreground group. */
export const PS_SNAPSHOT_ARGS = ["ps", "-A", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,command="];

export function parseProcs(out: string, withParent = false): Proc[] {
  const procs: Proc[] = [];
  const line = withParent
    ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/
    : /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*(.*)$/;
  for (const text of out.split("\n")) {
    const m = line.exec(text);
    if (!m) continue;
    const [pid, ppid, rest] = withParent ? [m[1], m[2], m.slice(3)] : [m[1], undefined, m.slice(2)];
    procs.push({
      pid: Number(pid),
      ...(ppid === undefined ? {} : { ppid: Number(ppid) }),
      pgid: Number(rest[0]),
      tpgid: Number(rest[1]),
      tty: rest[2] ?? "",
      command: rest[3] ?? "",
    });
  }
  return procs;
}

/** The processes now, with parents; empty when `ps` fails. */
export async function snapshotProcs(): Promise<Proc[]> {
  const res = await run(PS_SNAPSHOT_ARGS, { timeoutMs: 5000 });
  return res.code === 0 ? parseProcs(res.out, true) : [];
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

/** `inFront`, read from the system now (or from `procs`, a snapshot already taken). False when `ps` fails. */
export async function claudeInFront(
  pid: number,
  tty: string | null,
  others: number[] = [],
  procs?: () => Promise<Proc[]>,
): Promise<boolean> {
  if (procs) return inFront(await procs(), pid, tty, others);
  const res = await run(PS_ARGS, { timeoutMs: 5000 });
  return res.code === 0 && inFront(parseProcs(res.out), pid, tty, others);
}

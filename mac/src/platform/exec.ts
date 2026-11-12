import { delimiter } from "node:path";

/** Standard system directories, present on both macOS and Linux. */
export const BASE_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface RunResult {
  /** Exit code; 127 when the program isn't installed, 124 when it timed out. */
  code: number;
  out: string;
  err: string;
}

export type Runner = (cmd: string[], opts?: { timeoutMs?: number; stdin?: string }) => Promise<RunResult>;

/** Runs a command and captures its output. Never throws: a missing program is exit code 127. */
export const run: Runner = async (cmd, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: [process.env.PATH ?? "", ...BASE_PATH].filter(Boolean).join(delimiter) },
    });
  } catch {
    return { code: 127, out: "", err: `${cmd[0]}: not found` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 5000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: timedOut ? 124 : code, out: out.trim(), err: err.trim() };
};

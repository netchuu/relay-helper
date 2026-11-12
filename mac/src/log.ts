/** Minimal structured logger: one JSON object per line on stderr (launchd redirects it to daemon.log). */
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.RELAY_LOG_LEVEL as Level) ?? "info"] ?? order.info;

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

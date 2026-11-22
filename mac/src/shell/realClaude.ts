import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { relayHome } from "../home.ts";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The real `claude`: the first one on PATH outside the folders in `skip`, so Relay's own never finds itself. */
export function findRealClaude(
  env: Record<string, string | undefined>,
  skip: string[] = [join(relayHome(), "bin")],
): string | null {
  const skipped = new Set(skip.map(real));
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d && !skipped.has(real(d)));
  const hit = Bun.which("claude", { PATH: dirs.join(delimiter) });
  if (hit) return hit;
  const local = join(homedir(), ".local", "bin", "claude");
  if (existsSync(local) && !skipped.has(real(dirname(local)))) return local;
  try {
    const saved = JSON.parse(readFileSync(join(relayHome(), "config.json"), "utf8")).claudeBin;
    if (typeof saved === "string" && existsSync(saved) && !skipped.has(real(dirname(saved)))) return saved;
  } catch {
    // no config yet
  }
  return null;
}

/** PATH without Relay's own folder, whose `claude` is the wrapper. */
export function pathWithoutRelay(path: string, relayBin = join(relayHome(), "bin")): string {
  const own = real(relayBin);
  return path
    .split(delimiter)
    .filter((d) => d && real(d) !== own)
    .join(delimiter);
}

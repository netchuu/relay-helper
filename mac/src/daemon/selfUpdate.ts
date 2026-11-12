import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errMessage, log } from "../log.ts";

/**
 * Picks up a `brew upgrade` on its own. Homebrew only replaces its own `relay`; the service runs the copy
 * in ~/.relay/bin, which only `relay install` refreshes (along with the hooks and Zed's terminal). And
 * Homebrew can't run that for us: its post-install step is sandboxed away from ~/.relay and ~/.claude.
 *
 * So every few minutes the daemon looks at Homebrew's `relay`. When it is a newer version, it runs that
 * binary's own `install --no-service` (the new version's install steps, without restarting the service
 * from under itself), then exits so launchd or systemd starts the new copy.
 */

export interface SelfUpdateDeps {
  /** The version this daemon is. */
  current: string;
  /** Where Homebrew puts `relay`, in order. */
  candidates: string[];
  /** The installed copy the service runs (~/.relay/bin/relay): never an update source. */
  ownBin: string;
  /** Runs a command; returns its exit code and output. */
  run(cmd: string[]): Promise<{ code: number; out: string }>;
  /** True when launchd or systemd starts the daemon again after it exits. */
  restartsOnExit: boolean;
  /** True while a prompt waits for an answer: a restart would drop it. */
  busy(): boolean;
  /** Ends the daemon so the service manager starts the new version. */
  exit(): void;
}

export const CHECK_EVERY_MS = 5 * 60_000;

/** Homebrew's bin directories on macOS (Apple silicon, Intel) and Linux. */
export function brewCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [
    env.HOMEBREW_PREFIX && join(env.HOMEBREW_PREFIX, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    join(home, ".linuxbrew", "bin"),
  ].filter((d): d is string => Boolean(d));
  return [...new Set(dirs)].map((d) => join(d, "relay"));
}

/** Under launchd the daemon gets its job label; under systemd, an invocation id. */
export function underServiceManager(
  env: NodeJS.ProcessEnv = process.env,
  launchdLabel = "dev.relay.daemon",
): boolean {
  return env.XPC_SERVICE_NAME === launchdLabel || Boolean(env.INVOCATION_ID);
}

/** -1, 0 or 1 for dotted numeric versions ("0.10.0" is newer than "0.9.3"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function parseVersion(out: string): string | null {
  return /^relay (\d+(?:\.\d+)+)/m.exec(out)?.[1] ?? null;
}

export class SelfUpdater {
  /** Resolved paths already looked at, so `--version` runs only after Homebrew changed something. */
  private seen = new Map<string, string | null>();
  private updating = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SelfUpdateDeps) {}

  start(everyMs = CHECK_EVERY_MS): void {
    if (!this.deps.restartsOnExit) {
      log.info("self-update off: not running under launchd or systemd, so nothing would restart the helper");
      return;
    }
    const tick = () => void this.check().catch((err) => log.warn("self-update", { err: errMessage(err) }));
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The newest Homebrew `relay` that is newer than this daemon, or null. */
  async findNewer(): Promise<{ bin: string; version: string } | null> {
    let best: { bin: string; version: string } | null = null;
    const own = existsSync(this.deps.ownBin) ? realpathSync(this.deps.ownBin) : this.deps.ownBin;
    for (const candidate of this.deps.candidates) {
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      if (real === own) continue;
      if (!this.seen.has(real)) {
        const res = await this.deps.run([real, "--version"]);
        this.seen.set(real, res.code === 0 ? parseVersion(res.out) : null);
      }
      const version = this.seen.get(real);
      if (!version || compareVersions(version, this.deps.current) <= 0) continue;
      if (!best || compareVersions(version, best.version) > 0) best = { bin: real, version };
    }
    return best;
  }

  /** Returns what happened, for logs and tests. */
  async check(): Promise<"none" | "busy" | "updated" | "failed"> {
    if (this.updating) return "busy";
    const newer = await this.findNewer();
    if (!newer) return "none";
    if (this.deps.busy()) return "busy"; // try again on the next tick
    this.updating = true;
    log.info("updating the helper from Homebrew", { from: this.deps.current, to: newer.version });
    const res = await this.deps.run([newer.bin, "install", "--no-service", "--from-update"]);
    if (res.code !== 0) {
      this.updating = false;
      // Don't retry the same broken binary every tick; a later `brew upgrade` is a new path.
      this.seen.set(newer.bin, null);
      log.warn("helper update failed; still on the old version", {
        to: newer.version,
        out: res.out.slice(-500),
      });
      return "failed";
    }
    log.info("helper updated; restarting on the new version", { to: newer.version });
    this.deps.exit();
    return "updated";
  }
}

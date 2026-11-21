import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/** What the system says about a process; swapped in tests for a fake process table. */
export interface ProcessReader {
  /** A value that identifies when the process started, stable while the computer runs; null when it can't be read. */
  startTime(pid: number): number | null;
  /** The start in ms since the epoch, to compare with a time that was written; defaults to `startTime`. */
  wallStart?(pid: number): number | null;
  /** When the computer last booted, in ms since the epoch. */
  bootTime(): number;
}

/** What was saved with a pid: its start time, or for older records only when the pid was written. */
export interface SavedProcess {
  start?: number | null;
  /** When the record was written; a process that began later can't be the one saved. */
  savedAt?: number | null;
}

/** "dead": gone, or a different process now. "same": confirmed. "unknown": exists, can't tell whose. */
export type ProcessState = "dead" | "same" | "unknown";

const START_TOLERANCE_MS = 1500;
const SAVE_TOLERANCE_MS = 2000;
const CACHE_MS = 10_000;

const BOOT_SPAN_MS = 1e11;

/** The pieces of the system the real reader uses; tests swap them. */
export interface SystemSources {
  platform: string;
  /** The text of a file under /proc, or null. */
  readProc(path: string): string | null;
  /** `ps` start time in ms since the epoch (macOS). */
  psStart(pid: number): number | null;
}

// A boot id marks which boot a saved Linux start belongs to, without the wall clock, which can step after boot.
function bootKey(bootId: string): number {
  return Number.parseInt(bootId.replace(/-/g, "").slice(0, 4), 16);
}

/** Ticks since boot from a /proc/<pid>/stat line, in ms; null when it can't be parsed. */
export function statTicksMs(stat: string): number | null {
  // The command name sits in parentheses and may hold spaces; field 22 (starttime) is the 20th after it.
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  // 100 ticks a second on every Linux Relay runs on.
  return Number.isFinite(ticks) ? ticks * 10 : null;
}

/** One number for a Linux process: which boot, then ms since that boot. */
export function linuxStart(stat: string, bootId: string): number | null {
  const ms = statTicksMs(stat);
  const key = bootKey(bootId);
  return ms === null || !Number.isFinite(key) || ms >= BOOT_SPAN_MS ? null : key * BOOT_SPAN_MS + ms;
}

function darwinStart(pid: number): number | null {
  try {
    const r = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC", PATH: "/bin:/usr/bin" },
      timeout: 2000,
    });
    const ms = Date.parse(`${r.stdout.toString().trim()} UTC`);
    return r.exitCode === 0 && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

let boot: number | null = null;
function bootTimeMs(): number {
  boot ??= Math.round(Date.now() - uptime() * 1000);
  return boot;
}

const realSources: SystemSources = {
  platform: process.platform,
  readProc(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  psStart: darwinStart,
};

export function systemReader(src: SystemSources = realSources): ProcessReader {
  if (src.platform !== "linux") return { startTime: src.psStart, bootTime: bootTimeMs };
  const stat = (pid: number) => {
    const text = src.readProc(`/proc/${pid}/stat`);
    return text === null ? null : statTicksMs(text);
  };
  return {
    startTime(pid) {
      const text = src.readProc(`/proc/${pid}/stat`);
      const id = src.readProc("/proc/sys/kernel/random/boot_id");
      return text === null || id === null ? null : linuxStart(text, id.trim());
    },
    wallStart(pid) {
      const ms = stat(pid);
      return ms === null ? null : bootTimeMs() + ms;
    },
    bootTime: bootTimeMs,
  };
}

const system = systemReader();

let reader: ProcessReader = system;
const cache = new Map<number, { start: number | null; at: number }>();

/** Tests only. */
export function setProcessReader(next: ProcessReader | null): void {
  reader = next ?? system;
  cache.clear();
}

/** The process's start time. Cached briefly, so a sweep over many sessions reads each pid once. */
export function startTimeOf(pid: number): number | null {
  const hit = cache.get(pid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.start;
  const start = reader.startTime(pid);
  if (cache.size > 500) cache.clear();
  cache.set(pid, { start, at: Date.now() });
  return start;
}

/** Whether `pid` is still the process that was saved. Only ESRCH or a different start time proves it gone. */
export function processState(pid: number, saved: SavedProcess = {}): ProcessState {
  if (!Number.isInteger(pid) || pid <= 1) return "dead";
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") {
      cache.delete(pid);
      return "dead";
    }
  }
  const start = startTimeOf(pid);
  if (saved.start != null) {
    if (start === null) return "unknown";
    return Math.abs(start - saved.start) <= START_TOLERANCE_MS ? "same" : "dead";
  }
  if (saved.savedAt == null) return "unknown";
  if (saved.savedAt < reader.bootTime()) return "dead";
  const began = reader.wallStart ? reader.wallStart(pid) : start;
  if (began === null) return "unknown";
  // A live process with this pid that began before the record was written is the one that wrote it.
  return began > saved.savedAt + SAVE_TOLERANCE_MS ? "dead" : "same";
}

/** A signal may go to `pid` only when it is confirmed to be the saved process. */
export function signalSaved(pid: number, saved: SavedProcess, signal: NodeJS.Signals): boolean {
  if (processState(pid, saved) !== "same") return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

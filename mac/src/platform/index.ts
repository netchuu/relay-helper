import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import type { HostInfo, Platform } from "./types.ts";

export type * from "./types.ts";

/** Chosen once at startup. Other systems get the macOS code; install.sh only offers macOS and Linux. */
export const platform: Platform = process.platform === "linux" ? linux : darwin;

let cachedHost: Promise<HostInfo> | null = null;

/** What the phone shows for the paired computer ("Mac" or "computer", and its name). */
export async function hostInfo(): Promise<HostInfo> {
  cachedHost ??= platform
    .computerName()
    .catch(() => "")
    .then((name) => ({ os: platform.name === "linux" ? "linux" : "macos", name: name.slice(0, 80) }));
  const host = await cachedHost;
  return canStartSessions ? { ...host, canStartSessions: true, canStartEmpty: true } : host;
}

let canStartSessions = false;

/** The daemon found `claude`, so the phone may offer to start sessions (same on macOS and Linux). */
export function setCanStartSessions(can: boolean): void {
  canStartSessions = can;
}

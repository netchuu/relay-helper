import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import type { HostInfo, Platform } from "./types.ts";

export type * from "./types.ts";

/** Chosen once at startup. Other systems get the macOS code; install.sh only offers macOS and Linux. */
export const platform: Platform = process.platform === "linux" ? linux : darwin;

let cachedHost: Promise<HostInfo> | null = null;

/**
 * What the phone shows for the computer it's paired with ("Mac" or "computer", and its name). Sent in the
 * `pair` and `hello` replies; apps that don't know the field keep saying "Mac".
 */
export function hostInfo(): Promise<HostInfo> {
  cachedHost ??= platform
    .computerName()
    .catch(() => "")
    .then((name) => ({ os: platform.name === "linux" ? "linux" : "macos", name: name.slice(0, 80) }));
  return cachedHost;
}

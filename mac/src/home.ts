import { homedir } from "node:os";
import { join } from "node:path";

/** Relay's data folder. Kept apart from config.ts so a short-lived command can find it without loading that. */
export function relayHome(): string {
  return process.env.RELAY_HOME ?? join(homedir(), ".relay");
}

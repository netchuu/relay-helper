// The `claude` program in ~/.relay/bin: a small entry that starts faster than the whole `relay`, since it
// loads only the wrapper.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { relayHome } from "../home.ts";
import { passThrough, runWrap } from "./ptyWrap.ts";
import { findRealClaude } from "./realClaude.ts";

async function helperRunning(): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: join(relayHome(), "hook.sock"), socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

const bin = join(relayHome(), "bin");
const claude = findRealClaude(process.env, [bin, dirname(process.execPath)]);
if (!claude) {
  console.error("claude: Claude Code isn't installed (no `claude` on PATH).");
  process.exit(127);
}
const args = process.argv.slice(2);
// Relay must never be the reason `claude` doesn't start.
const wrapped = !process.env.RELAY_NO_WRAP && existsSync(join(bin, "relay")) && (await helperRunning());
process.exit(
  wrapped ? await runWrap(["--claude", claude, "--", ...args]) : await passThrough([claude, ...args]),
);

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { basename, join } from "node:path";
import { CHILD_PATH, paths } from "../config.ts";
import { processState, signalSaved } from "../platform/processIdentity.ts";
import { hostSaved, hostSocketPath, hostStatePath, readHostState } from "../shell/ptyHost.ts";

/** Where a session started from the phone runs: a terminal of its own (`relay host`) the helper can type into. */
export interface TerminalPane {
  id: string;
  socket: string;
  token: string;
  /** Claude Code's own process: the host runs it directly, with no shell in between. */
  pid: number;
}

export interface TerminalLauncher {
  /** Starts `cmd` in `cwd` in a new host that keeps running without the daemon. */
  launch(cmd: string[], cwd: string, id: string): Promise<TerminalPane>;
  /** The terminal's text and whether its command has exited; null when the host is gone. */
  look(pane: TerminalPane): Promise<{ screen: string; exited: boolean } | null>;
  /** Ends the chat and forgets it. */
  close(pane: TerminalPane): Promise<void>;
  /** Lets the host clean up after itself when the command exits; it was kept only to read a refusal at startup. */
  release(pane: TerminalPane): Promise<void>;
}

/** How to run `relay host`: this binary, or this script under Bun in a checkout. */
export function selfCommand(): string[] {
  return basename(process.execPath).replace(/\.exe$/, "") === "bun"
    ? [process.execPath, join(import.meta.dir, "../cli.ts")]
    : [process.execPath];
}

const HOST_START_MS = 10_000;
/** Exit records nobody collected (the daemon went down mid-start) are swept after this long. */
const STALE_RECORD_MS = 60 * 60_000;

function ask(
  socket: string,
  req: object,
  timeoutMs = 3000,
): Promise<{ ok?: boolean; screen?: string } | null> {
  return new Promise((resolve) => {
    const sock = connect(socket);
    let buf = "";
    const done = (value: { ok?: boolean; screen?: string } | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on("error", () => done(null));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
    });
    sock.on("close", () => {
      try {
        done(JSON.parse(buf.trim()));
      } catch {
        done(null);
      }
    });
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
  });
}

function sweep(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("h-") || !name.endsWith(".json")) continue;
      const path = join(dir, name);
      const id = name.slice(2, -5);
      const state = readHostState(dir, id);
      if (!state) continue;
      const stale = state.exited && Date.now() - statSync(path).mtimeMs > STALE_RECORD_MS;
      if (stale || (!state.exited && processState(state.hostPid, hostSaved(dir, id, state)) === "dead")) {
        rmSync(path, { force: true });
        rmSync(hostSocketPath(dir, id), { force: true });
      }
    }
  } catch {
    // no folder yet
  }
}

export function hostLauncher(opts: { dir?: string; self?: string[] } = {}): TerminalLauncher {
  const dir = opts.dir ?? join(paths.home, "pty");
  return {
    async launch(cmd, cwd, id) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      sweep(dir);
      // Claude Code gets the helper's search path and none of the helper's own markers.
      const env: Record<string, string | undefined> = { ...process.env, PATH: CHILD_PATH };
      delete env.RELAY_INTERNAL;
      const [bin, ...rest] = opts.self ?? selfCommand();
      const child = spawn(
        bin as string,
        [...rest, "host", "--dir", dir, "--id", id, "--cwd", cwd, "--", ...cmd],
        { detached: true, stdio: "ignore", env, windowsHide: true },
      );
      let spawnError: Error | null = null;
      let exited = false;
      child.on("error", (err) => {
        spawnError = err;
      });
      child.on("exit", () => {
        exited = true;
      });
      child.unref();
      const deadline = Date.now() + HOST_START_MS;
      for (;;) {
        const state = readHostState(dir, id);
        if (state) return { id, socket: state.socket, token: state.token, pid: state.pid };
        if (spawnError || exited || Date.now() > deadline) {
          if (!exited) child.kill();
          throw new Error(spawnError ? (spawnError as Error).message : "relay host didn't start");
        }
        await Bun.sleep(20);
      }
    },
    async look(pane) {
      const state = readHostState(dir, pane.id);
      if (!state) return null;
      if (state.exited) return { screen: state.exited.screen, exited: true };
      const reply = await ask(pane.socket, { op: "screen", token: pane.token });
      if (reply?.ok) return { screen: reply.screen ?? "", exited: false };
      // No answer: busy for a moment, or killed without a record.
      return processState(state.hostPid, hostSaved(dir, pane.id, state)) !== "dead"
        ? { screen: "", exited: false }
        : null;
    },
    async close(pane) {
      const state = readHostState(dir, pane.id);
      if (state && !state.exited) {
        signalSaved(state.hostPid, hostSaved(dir, pane.id, state), "SIGTERM");
      }
      rmSync(hostStatePath(dir, pane.id), { force: true });
    },
    async release(pane) {
      await ask(pane.socket, { op: "release", token: pane.token });
    },
  };
}

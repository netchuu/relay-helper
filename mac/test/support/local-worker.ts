import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawnSync } from "bun";

/**
 * Starts the relay Worker locally (`wrangler dev`) for the end-to-end tests, so that several test runs at once
 * (from different checkouts, or a release check next to `bun run test`) don't get in each other's way.
 *
 * Why the Worker could be slow or never come up under load:
 * - Two `wrangler dev` started at about the same time both pick the default devtools (inspector) port 9229, or
 *   the same "free" one, and all but one exit with "Address already in use (socket "direct:1:default")". The test
 *   didn't watch the process, so it waited out its 60 s for a `/health` that would never answer.
 * - `bunx wrangler` in a checkout without `cloud/node_modules` (a fresh one, before `cd cloud && bun install`) asked
 *   npm for the latest wrangler on every start and downloaded it, and its workerd, whenever a new one was out:
 *   seconds at best, minutes on a busy machine, and not the locked version.
 * - Every run in a checkout shared `cloud/.wrangler/state`, and the Worker and helper ports came from the pid,
 *   so two runs could land on the same ports.
 *
 * So: the locked wrangler from `cloud/node_modules` (installed once if missing), both ports from the OS, state
 * under the test's own directory, and a start that fails at once, with the Worker's output, when wrangler exits.
 */

export interface LocalWorker {
  port: number;
  inspectorPort: number;
  proc: Subprocess;
  /** Everything the Worker printed so far (stdout and stderr, interleaved as it arrived). */
  output(): string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** The directory with wrangler.jsonc and package.json. */
  cloudDir: string;
  /** Wrangler's persisted state (Durable Objects) and logs go here, not in cloud/.wrangler. */
  stateDir: string;
  /** The Worker's environment (default: this process's). */
  env?: Record<string, string | undefined>;
  /** How long to wait for GET /health, per start. */
  timeoutMs?: number;
  /** Starts again on fresh ports, at most this many times in all, only when wrangler exits because a port was taken. */
  attempts?: number;
  /** The command to run; tests of this module replace wrangler with a stand-in. */
  command?: (ports: { port: number; inspectorPort: number }) => string[];
}

/** A port nothing listens on right now, chosen by the OS (so parallel runs don't pick the same one). */
export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** The wrangler bin from cloud/node_modules, installing the locked dependencies first when they're missing. */
export function lockedWrangler(cloudDir: string): string {
  const bin = join(cloudDir, "node_modules", ".bin", "wrangler");
  if (existsSync(bin)) return bin;
  const install = spawnSync(["bun", "install", "--frozen-lockfile"], {
    cwd: cloudDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0 || !existsSync(bin)) {
    throw new Error(
      `Couldn't install the Worker's dependencies (bun install --frozen-lockfile in ${cloudDir}, exit ${install.exitCode}):\n` +
        `${install.stdout.toString()}${install.stderr.toString()}`,
    );
  }
  return bin;
}

const PORT_TAKEN = /address already in use|EADDRINUSE/i;

function lastLines(text: string, n = 60): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n") || "(nothing)";
}

/** Collects a stream into `sink` until it ends; keeps the last 256 KB so a chatty process can't fill memory. */
async function drain(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    sink.text += decoder.decode(chunk, { stream: true });
    if (sink.text.length > 256_000) sink.text = sink.text.slice(-200_000);
  }
}

async function stopProcess(proc: Subprocess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

export async function startLocalWorker(opts: StartOptions): Promise<LocalWorker> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const attempts = opts.attempts ?? 3;
  mkdirSync(opts.stateDir, { recursive: true });
  const command =
    opts.command ??
    (() => {
      const wrangler = lockedWrangler(opts.cloudDir);
      return ({ port, inspectorPort }: { port: number; inspectorPort: number }) => [
        wrangler,
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(inspectorPort),
        "--persist-to",
        join(opts.stateDir, "state"),
        "--show-interactive-dev-session=false",
      ];
    })();

  const tried: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = freePort();
    let inspectorPort = freePort();
    while (inspectorPort === port) inspectorPort = freePort();
    const argv = command({ port, inspectorPort });
    const out = { text: "" };
    const proc = Bun.spawn(argv, {
      cwd: opts.cloudDir,
      env: {
        ...(opts.env ?? process.env),
        WRANGLER_SEND_METRICS: "false",
        // Plain text for the error message, without colour codes.
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        // Wrangler's own debug log, otherwise in ~/Library/Preferences/.wrangler/logs.
        WRANGLER_LOG_PATH: join(opts.stateDir, "wrangler-logs"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const drained = Promise.all([drain(proc.stdout, out), drain(proc.stderr, out)]).catch(() => {});
    const worker: LocalWorker = {
      port,
      inspectorPort,
      proc,
      output: () => out.text,
      stop: async () => {
        await stopProcess(proc);
        await Promise.race([drained, Bun.sleep(1000)]);
      },
    };

    const what = `the local Worker (\`${argv.slice(0, 2).join(" ")}\` on 127.0.0.1:${port}, inspector port ${inspectorPort}) to answer GET /health`;
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastError = "no answer yet";
    while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return worker;
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = (e as Error).message;
      }
      await Bun.sleep(100);
    }

    const exited = proc.exitCode !== null || proc.signalCode !== null;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    await worker.stop();
    const output = out.text;
    if (exited && PORT_TAKEN.test(output) && attempt < attempts) {
      tried.push(`attempt ${attempt}: port ${port} or ${inspectorPort} was taken`);
      continue;
    }
    const why = exited
      ? `it exited (${proc.exitCode !== null ? `code ${proc.exitCode}` : proc.signalCode}) after ${secs} s without answering`
      : `no answer within ${secs} s (last try: ${lastError})`;
    throw new Error(
      `Waited for ${what}: ${why}.` +
        (tried.length ? `\nEarlier starts on other ports: ${tried.join("; ")}.` : "") +
        `\n--- the Worker's output (last 60 lines) ---\n${lastLines(output)}`,
    );
  }
  throw new Error("unreachable");
}

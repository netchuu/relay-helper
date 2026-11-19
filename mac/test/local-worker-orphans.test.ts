import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A killed or timed-out test runner leaves no local Worker server, nor its child processes, running. */
const dir = mkdtempSync(join(process.env.RELAY_TEST_ROOT ?? tmpdir(), "relay-lw-orphans-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const support = resolve(import.meta.dir, "support/local-worker.ts");

// Like wrangler: a server with a child of its own that it doesn't stop on SIGTERM.
const server = `
const port = Number(process.argv[2]);
const pidFile = process.argv[3];
const child = Bun.spawn(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: ["ignore", "ignore", "ignore"] });
await Bun.write(pidFile, String(process.pid) + " " + child.pid);
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
`;

const runner = `
import { startLocalWorker } from ${JSON.stringify(support)};
const pidFile = ${JSON.stringify(join(dir, "pids"))};
const w = await startLocalWorker({
  cloudDir: ${JSON.stringify(dir)},
  stateDir: ${JSON.stringify(join(dir, "state"))},
  command: ({ port }) => ["bun", ${JSON.stringify(join(dir, "server.ts"))}, String(port), pidFile],
  timeoutMs: 15000,
});
console.log("started " + w.proc.pid);
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pids: number[], ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pids.some(alive)) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function startRunner(): Promise<{ runner: Bun.Subprocess; pids: number[] }> {
  writeFileSync(join(dir, "server.ts"), server);
  writeFileSync(join(dir, "runner.ts"), runner);
  rmSync(join(dir, "pids"), { force: true });
  const proc = Bun.spawn(["bun", join(dir, "runner.ts")], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("started")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`runner exited early: ${seen}`);
    seen += decoder.decode(value);
  }
  const guardPid = Number(seen.match(/started (\d+)/)?.[1]);
  const [serverPid, childPid] = readFileSync(join(dir, "pids"), "utf8").split(" ").map(Number);
  const pids = [guardPid, serverPid, childPid] as number[];
  expect(pids.every(alive)).toBe(true);
  return { runner: proc, pids };
}

describe("local Worker cleanup", () => {
  test("SIGKILL of the runner leaves nothing running", async () => {
    const { runner: proc, pids } = await startRunner();
    proc.kill("SIGKILL");
    await proc.exited;
    expect(await gone(pids)).toBe(true);
  }, 30_000);

  test("SIGTERM of the runner leaves nothing running", async () => {
    const { runner: proc, pids } = await startRunner();
    proc.kill("SIGTERM");
    await proc.exited;
    expect(await gone(pids)).toBe(true);
  }, 30_000);
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, startLocalWorker } from "./support/local-worker.ts";

/**
 * The local Worker start that relay.test.ts uses (support/local-worker.ts), with stand-ins for wrangler: when the
 * Worker doesn't come up, the test must say what it waited for and show the Worker's output, not a bare timeout.
 */
const dir = mkdtempSync(join(process.env.RELAY_TEST_ROOT ?? tmpdir(), "relay-lw-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in "wrangler": a bun script that gets the two ports as arguments. */
function standIn(name: string, source: string): (p: { port: number; inspectorPort: number }) => string[] {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  return ({ port, inspectorPort }) => ["bun", file, String(port), String(inspectorPort)];
}

const healthServer = `
const port = Number(process.argv[2]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: (r) => new URL(r.url).pathname === "/health" ? new Response("ok") : new Response("no", { status: 404 }) });
console.log("Ready on http://127.0.0.1:" + port);
`;

describe("starting the local Worker", () => {
  test("returns once GET /health answers, on ports the OS handed out", async () => {
    const worker = await startLocalWorker({
      cloudDir: dir,
      stateDir: join(dir, "ok"),
      command: standIn("ok", healthServer),
      timeoutMs: 10_000,
    });
    try {
      expect(worker.port).toBeGreaterThan(0);
      expect(worker.inspectorPort).not.toBe(worker.port);
      expect((await fetch(`http://127.0.0.1:${worker.port}/health`)).ok).toBe(true);
      expect(worker.output()).toContain("Ready on");
    } finally {
      await worker.stop();
    }
    expect(worker.proc.exitCode !== null || worker.proc.signalCode !== null).toBe(true);
  });

  test("fails at once with the Worker's output when it exits, instead of waiting out the timeout", async () => {
    const started = Date.now();
    const error = await startLocalWorker({
      cloudDir: dir,
      stateDir: join(dir, "exits"),
      command: standIn(
        "exits",
        `console.error("✘ [ERROR] Could not resolve \\"./missing\\""); process.exit(1);`,
      ),
      timeoutMs: 30_000,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(message).toContain("to answer GET /health");
    expect(message).toContain("exited (code 1)");
    expect(message).toContain("the Worker's output");
    expect(message).toContain('Could not resolve "./missing"');
  });

  test("names what it waited for, and shows the output, when the Worker never answers", async () => {
    const error = await startLocalWorker({
      cloudDir: dir,
      stateDir: join(dir, "silent"),
      command: standIn("silent", `console.log("⎔ Starting local server..."); setInterval(() => {}, 1000);`),
      timeoutMs: 1500,
    }).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toMatch(
      /Waited for the local Worker .* on 127\.0\.0\.1:\d+, inspector port \d+\) to answer GET \/health/,
    );
    expect(message).toContain("no answer within");
    expect(message).toContain("Starting local server...");
  });

  test("starts again on fresh ports when wrangler exits because a port was taken, and fails if that start fails too", async () => {
    // Every start clashes: the error says so and gives up after the attempts it was allowed, not before or after.
    const counter = join(dir, "clash-count");
    writeFileSync(counter, "");
    const clash = standIn(
      "clash",
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
console.error('✘ [ERROR] Address already in use (socket "direct:1:default").');
process.exit(1);`,
    );
    const error = await startLocalWorker({
      cloudDir: dir,
      stateDir: join(dir, "clash"),
      command: clash,
      attempts: 3,
      timeoutMs: 10_000,
    }).catch((e: Error) => e);
    expect(await Bun.file(counter).text()).toBe("xxx");
    const message = (error as Error).message;
    expect(message).toContain("Address already in use");
    expect(message).toContain("Earlier starts on other ports: attempt 1");
    expect(message).toContain("attempt 2");

    // The first start clashes, the second comes up: that one is used.
    const flag = join(dir, "clashed-once");
    const once = standIn(
      "once",
      `import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(${JSON.stringify(flag)})) { writeFileSync(${JSON.stringify(flag)}, ""); console.error("Address already in use"); process.exit(1); }
${healthServer}`,
    );
    const worker = await startLocalWorker({
      cloudDir: dir,
      stateDir: join(dir, "once"),
      command: once,
      timeoutMs: 10_000,
    });
    expect((await fetch(`http://127.0.0.1:${worker.port}/health`)).ok).toBe(true);
    await worker.stop();
  });

  test("any other exit is not started again", async () => {
    const counter = join(dir, "other-count");
    writeFileSync(counter, "");
    const error = await startLocalWorker({
      cloudDir: dir,
      stateDir: join(dir, "other"),
      command: standIn(
        "other",
        `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(counter)}, "x"); process.exit(2);`,
      ),
      timeoutMs: 10_000,
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain("exited (code 2)");
    expect(await Bun.file(counter).text()).toBe("x");
  });

  test("freePort gives a port nothing listens on", async () => {
    const port = freePort();
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    expect(server.port).toBe(port);
    server.stop(true);
  });

  test("three real Workers started at the same moment all come up (they used to clash on the inspector port)", async () => {
    // Before: each \`wrangler dev\` took the default inspector port 9229 when it looked free, so all but one of
    // a simultaneous start exited with "Address already in use" and the test waited out its 60 s.
    const starts = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        startLocalWorker({
          cloudDir: resolve(import.meta.dir, "../../cloud"),
          stateDir: join(dir, `real-${n}`),
          attempts: 1,
        }),
      ),
    );
    const workers = starts.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    try {
      // One that didn't come up fails the test with its own message (and the others are still stopped below).
      for (const s of starts) if (s.status === "rejected") throw s.reason;
      for (const w of workers) expect((await fetch(`http://127.0.0.1:${w.port}/health`)).ok).toBe(true);
      expect(new Set(workers.map((w) => w.port)).size).toBe(3);
      // The locked version from cloud/bun.lock, not whatever bunx fetched as latest.
      const locked = (await Bun.file(
        resolve(import.meta.dir, "../../cloud/node_modules/wrangler/package.json"),
      ).json()) as {
        version: string;
      };
      expect(workers[0]?.output()).toContain(`wrangler ${locked.version}`);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }
  }, 90_000);
});

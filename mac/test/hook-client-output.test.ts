// The hook client must deliver a large reply whole: exiting right after writing cuts it at the pipe buffer.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLIENT = join(import.meta.dir, "../src/hook/client.ts");
const SIZE = 200_000;
const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-hook-"));
  dirs.push(dir);
  return dir;
}

function fakeDaemon(dir: string, stdout: string) {
  servers.push(Bun.serve({ unix: join(dir, "hook.sock"), fetch: () => Response.json({ stdout }) }));
}

const INPUT = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode" });
const run = (dir: string, pipeline: string) =>
  Bun.spawn(["sh", "-c", `bun ${CLIENT} | ${pipeline}`], {
    env: { ...process.env, RELAY_HOME: dir },
    stdin: new Blob([INPUT]),
    stdout: "pipe",
    stderr: "pipe",
  });

test("a 200,000 byte reply reaches a pipe read by wc -c", async () => {
  const dir = home();
  fakeDaemon(dir, "x".repeat(SIZE));
  const proc = run(dir, "wc -c");
  expect(Number((await new Response(proc.stdout).text()).trim())).toBe(SIZE);
  await proc.exited;
});

test.skipIf(!Bun.which("node"))("a 200,000 byte reply reaches a Node parent whole", async () => {
  const dir = home();
  fakeDaemon(dir, "y".repeat(SIZE));
  const script =
    "const {spawn}=require('node:child_process');let n=0;" +
    `const c=spawn('bun',[${JSON.stringify(CLIENT)}],{stdio:['pipe','pipe','inherit']});` +
    "c.stdout.on('data',d=>n+=d.length);c.on('close',()=>console.log(n));" +
    `c.stdin.end(${JSON.stringify(INPUT)});`;
  const proc = Bun.spawn(["node", "-e", script], {
    env: { ...process.env, RELAY_HOME: dir },
    stdout: "pipe",
  });
  expect(Number((await new Response(proc.stdout).text()).trim())).toBe(SIZE);
});

test("with the daemon down it prints nothing and exits promptly", async () => {
  const dir = home();
  const started = Date.now();
  const proc = run(dir, "wc -c");
  expect(Number((await new Response(proc.stdout).text()).trim())).toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
});

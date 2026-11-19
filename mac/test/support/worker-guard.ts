/** Runs a command in this process's own group and takes the whole group down when the test runner that started it is gone, however it died. */
const [parentArg, ...argv] = process.argv.slice(2);
const parentPid = Number(parentArg);
if (!parentPid || argv.length === 0) {
  console.error("usage: worker-guard.ts <parent pid> <command> [args...]");
  process.exit(2);
}

const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
let ending = false;

function killGroup(signal: NodeJS.Signals): void {
  try {
    process.kill(-process.pid, signal);
  } catch {}
}

async function end(code: number): Promise<never> {
  if (!ending) {
    ending = true;
    killGroup("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(3000)]);
    killGroup("SIGKILL");
  }
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    if (!ending) void end(143);
  });

setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") void end(143);
  }
}, 250);

child.exited.then(async (code) => {
  if (ending) return;
  ending = true;
  // esbuild and workerd can outlive wrangler itself; SIGKILL would take the exit code with it.
  killGroup("SIGTERM");
  await Bun.sleep(300);
  process.exit(code);
});

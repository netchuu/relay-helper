import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `relay pair` on a machine that isn't set up runs install() itself, then waits 5 more seconds for the
// helper. This runs the real cli.ts `pair` from a temp copy of the sources, where only platform/index.ts is
// changed: the service is a fake, so nothing touches launchd, and hook/client.ts is left out, so install()
// doesn't build. HOME and RELAY_HOME are temp dirs. A fake helper answers on the socket at once, only after
// install() has given up ("daemon did not start"), or never.

const HELPER = resolve(import.meta.dir, "../..");
const SENTINEL = "FAKE-SERVICE-INSTALL";

function copySources(): string {
  const root = mkdtempSync(join(tmpdir(), "ra-pair-"));
  cpSync(join(HELPER, "mac/src"), join(root, "mac/src"), { recursive: true });
  cpSync(join(HELPER, "protocol"), join(root, "protocol"), { recursive: true });
  cpSync(join(HELPER, "package.json"), join(root, "package.json"));
  symlinkSync(join(HELPER, "node_modules"), join(root, "node_modules"));
  rmSync(join(root, "mac/src/hook/client.ts")); // no build step in install()
  const index = join(root, "mac/src/platform/index.ts");
  const real = 'export const platform: Platform = process.platform === "linux" ? linux : darwin;';
  const src = readFileSync(index, "utf8");
  if (!src.includes(real)) throw new Error("platform/index.ts changed; refusing to run");
  writeFileSync(
    index,
    src.replace(
      real,
      `const base = process.platform === "linux" ? linux : darwin;
export const platform: Platform = {
  ...base,
  afterCopy: async () => {},
  service: {
    ...base.service,
    install: async () => { console.log("${SENTINEL}"); return { mode: "fake", notes: [] }; },
    uninstall: async () => { throw new Error("fake"); },
    restart: async () => { throw new Error("fake"); },
  },
} as Platform;`,
    ),
  );
  if (!readFileSync(index, "utf8").includes(SENTINEL)) throw new Error("fake service not in place");
  return root;
}

async function runPair(daemonStarts: "at once" | "after install gave up" | "never") {
  const root = copySources();
  const home = join(root, "h");
  const relayHome = join(root, "r");
  mkdirSync(home);
  mkdirSync(relayHome, { mode: 0o700 });
  // publicUrl set, so pair() doesn't ask tailscale.
  writeFileSync(join(relayHome, "config.json"), JSON.stringify({ publicUrl: "https://mac.example" }));
  const sock = join(relayHome, "hook.sock");
  let server: ReturnType<typeof Bun.serve> | undefined;
  const startDaemon = () => {
    server ??= Bun.serve({
      unix: sock,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/health") return new Response("ok");
        if (path === "/admin/pair")
          return Response.json({ code: "ABCD2345", expiresAt: Date.now() + 10 * 60_000 });
        return Response.json({});
      },
    });
  };

  const child = Bun.spawn(["bun", join(root, "mac/src/cli.ts"), "pair"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_HOME: relayHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    out += decoder.decode(chunk, { stream: true });
    if (!out.includes("Setting up Relay first.")) continue;
    if (daemonStarts === "at once" && out.includes(SENTINEL)) startDaemon();
    if (daemonStarts === "after install gave up" && out.includes("daemon did not start")) startDaemon();
  }
  const err = await new Response(child.stderr).text();
  const code = await child.exited;
  await server?.stop(true);
  const hooksWritten = existsSync(join(home, ".claude/settings.json"));
  rmSync(root, { recursive: true, force: true });
  return { code, out, err, hooksWritten };
}

test("control: helper answers during install, relay pair exits 0", async () => {
  const r = await runPair("at once");
  expect(r.out).toContain(SENTINEL);
  expect(r.hooksWritten).toBe(true);
  expect(r.out).toContain("Code: ABCD-2345");
  expect(r.code).toBe(0);
}, 60_000);

test("helper answers after install's wait but within pair's own: code shown, exit 0, last word is running", async () => {
  const r = await runPair("after install gave up");
  expect(r.out).toContain("daemon did not start");
  expect(r.out).toContain("Code: ABCD-2345");
  const helperLines = r.out.split("\n").filter((l) => l.startsWith("• daemon"));
  expect(helperLines[helperLines.length - 1]).toContain("daemon running");
  expect(r.code).toBe(0);
}, 60_000);

test("helper never starts: relay pair exits non-zero", async () => {
  const r = await runPair("never");
  expect(r.out).toContain("daemon did not start");
  expect(r.out).not.toContain("Code:");
  expect(r.code).not.toBe(0);
}, 60_000);

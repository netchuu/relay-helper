import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The settings file a person chose is saved only once Relay has written to it.
// Runs a copy of the sources without the build step, with its own HOME and RELAY_HOME.

const HELPER = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "relay-install-choice-"));
const home = join(root, "h");
const relayHome = join(root, "r");
const defaultFile = join(home, ".claude/settings.json");
const localFile = join(home, ".claude/settings.local.json");
const configFile = join(relayHome, "config.json");

cpSync(join(HELPER, "mac/src"), join(root, "mac/src"), { recursive: true });
cpSync(join(HELPER, "protocol"), join(root, "protocol"), { recursive: true });
cpSync(join(HELPER, "package.json"), join(root, "package.json"));
symlinkSync(join(HELPER, "node_modules"), join(root, "node_modules"));
rmSync(join(root, "mac/src/hook/client.ts"));

afterAll(() => {
  try {
    chmodSync(defaultFile, 0o644);
    chmodSync(localFile, 0o644);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

function reset(opts: { saved?: string }) {
  for (const f of [defaultFile, localFile]) {
    try {
      chmodSync(f, 0o644);
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(relayHome, { recursive: true, force: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(relayHome, { mode: 0o700 });
  writeFileSync(defaultFile, "{}\n");
  writeFileSync(localFile, "{}\n");
  if (opts.saved) writeFileSync(configFile, JSON.stringify({ settingsPath: opts.saved }));
}

async function install(...args: string[]) {
  const child = Bun.spawn(
    ["bun", join(root, "mac/src/cli.ts"), "install", "--no-service", "--no-zed", ...args],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_HOME: relayHome },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const text = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  return { code: await child.exited, text };
}

const saved = () => JSON.parse(readFileSync(configFile, "utf8")).settingsPath;

test("a plain install that can't write keeps the saved settings file", async () => {
  reset({ saved: localFile });
  chmodSync(defaultFile, 0o444);
  const r = await install();
  expect(r.code).not.toBe(0);
  expect(r.text).toContain("Nothing was changed");
  expect(saved()).toBe(localFile);
}, 60_000);

test("an install with --settings that can't write doesn't save the file", async () => {
  reset({});
  chmodSync(localFile, 0o444);
  const r = await install("--settings", localFile);
  expect(r.code).not.toBe(0);
  let path: string | undefined;
  try {
    path = saved();
  } catch {}
  expect(path).toBeUndefined();
}, 60_000);

test("a successful install saves the choice, and a plain one clears it", async () => {
  reset({});
  expect((await install("--settings", localFile)).code).toBe(0);
  expect(saved()).toBe(localFile);
  expect((await install()).code).toBe(0);
  expect(saved()).toBeUndefined();
}, 60_000);

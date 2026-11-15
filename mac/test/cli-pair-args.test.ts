import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./support/wait.ts";

// `relay pair` and `relay restart` with --help or bad arguments, in a temp HOME and RELAY_HOME. A `bun`
// stub on PATH fails and leaves a marker, so a command that went on to install would show it; the CLI
// itself runs through the real bun by its full path. Never a real install, pair or restart.
async function relay(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "rl-pair-args-"));
  const stubs = join(home, "stubs");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "bun"), `#!/bin/sh\necho "$@" >> "${home}/bun-called"\nexit 1\n`);
  chmodSync(join(stubs, "bun"), 0o755);
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: home,
      env: { HOME: home, RELAY_HOME: home, PATH: `${stubs}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 60_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return {
      out,
      err,
      code,
      buildStarted: existsSync(join(home, "bun-called")),
      settingsWritten: existsSync(join(home, ".claude", "settings.json")),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("relay pair --help and -h print the usage and set up nothing", async () => {
  for (const flag of ["--help", "-h"]) {
    const r = await relay("pair", flag);
    expect(r.out).toContain("Usage:");
    expect(r.out).not.toContain("Setting up Relay first.");
    expect(r.buildStarted).toBe(false);
    expect(r.settingsWritten).toBe(false);
    expect(r.code).toBe(0);
  }
}, 60_000);

test("relay pair and restart stop on an unknown flag or a leftover argument", async () => {
  for (const args of [
    ["pair", "--bogus"],
    ["pair", "--dryrun"],
    ["pair", "extra"],
    ["restart", "--bogus"],
    ["restart", "extra"],
  ]) {
    const r = await relay(...args);
    expect(r.err).toContain("relay:");
    expect(r.out).not.toContain("Setting up Relay first.");
    expect(r.out).not.toContain("daemon running");
    expect(r.buildStarted).toBe(false);
    expect(r.settingsWritten).toBe(false);
    expect(r.code).not.toBe(0);
  }
}, 60_000);

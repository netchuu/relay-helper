import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/cliArgs.ts";

const spec = { flags: ["--dry-run", "--no-service"], options: ["--settings"] };

test("known flags and options parse", () => {
  const p = parseArgs(["--settings", "/tmp/s.json", "--dry-run"], spec);
  expect(p.options.get("--settings")).toBe("/tmp/s.json");
  expect(p.flags.has("--dry-run")).toBe(true);
  expect(p.flags.has("--no-service")).toBe(false);
  expect(p.help).toBe(false);
});

test("an unknown flag is an error", () => {
  expect(() => parseArgs(["--dryrun"], spec)).toThrow("unknown option --dryrun");
});

test("a flag as an option's value is an error", () => {
  expect(() => parseArgs(["--settings", "--dry-run"], spec)).toThrow("--settings needs a value");
});

test("an option without a value is an error", () => {
  expect(() => parseArgs(["--settings"], spec)).toThrow("--settings needs a value");
});

test("leftover arguments are an error", () => {
  expect(() => parseArgs(["extra"], spec)).toThrow("unexpected argument extra");
});

test("--help wins over everything else", () => {
  expect(parseArgs(["--dryrun", "--help"], spec).help).toBe(true);
  expect(parseArgs(["-h"], spec).help).toBe(true);
});

// The CLI itself. Only arguments that stop before anything happens: never a real install, uninstall,
// pair or restart. RELAY_HOME is a temp folder, and the settings path would show a stray write.
const home = mkdtempSync("/tmp/rl-args-");
async function relay(...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    cwd: home,
    env: { ...process.env, RELAY_HOME: home, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

test("the CLI stops on a typo, a flag as a path and bad subcommands", async () => {
  try {
    for (const args of [
      ["install", "--dryrun"],
      ["install", "--settings", "--dry-run"],
      ["install", "--settings"],
      ["uninstall", "--bogus"],
      ["uninstall", "extra"],
      ["unistall"],
    ]) {
      const r = await relay(...args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("relay:");
    }
    expect(existsSync(join(home, "--dry-run"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--help after install or uninstall prints the usage and does nothing else", async () => {
  const h = mkdtempSync("/tmp/rl-args-h-");
  try {
    for (const cmd of ["install", "uninstall", "restart"]) {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), cmd, "--help"], {
        env: { ...process.env, RELAY_HOME: h, HOME: h },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain("Usage:");
    }
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

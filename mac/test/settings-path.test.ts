import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chooseSettingsPath, DEFAULT_SETTINGS } from "../src/install.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");

function run(home: string, cwd: string, args: string[]) {
  const res = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, RELAY_HOME: home },
  });
  return res.stdout.toString().trim().split("\n");
}

test("--settings is resolved against the current directory", () => {
  const p = chooseSettingsPath({ flag: ".claude/settings.local.json", byHelper: false });
  expect(isAbsolute(p)).toBe(true);
  expect(p).toBe(join(process.cwd(), ".claude/settings.local.json"));
});

test("a relative saved settingsPath is ignored by helper installs", () => {
  expect(chooseSettingsPath({ saved: "rel/settings.json", byHelper: true })).toBe(DEFAULT_SETTINGS);
  expect(chooseSettingsPath({ saved: "/abs/s.json", byHelper: true })).toBe("/abs/s.json");
});

test("install --settings with a relative path saves an absolute one", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "relay-relsettings-")));
  try {
    const proj = join(home, "proj");
    mkdirSync(proj);
    run(home, proj, ["install", "--no-service", "--settings", "rel/s.json"]);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).settingsPath;
    expect(saved).toBe(join(proj, "rel/s.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a saved relative settingsPath does not write into the current directory", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "relay-relsettings-")));
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ settingsPath: "rel/settings.json" }));
    const a = join(home, "a");
    mkdirSync(a);
    const out = run(home, a, ["install", "--no-service", "--dry-run", "--from-pair"]);
    expect(out[out.length - 1]).toBe(`(dry run) would write ${join(home, ".claude", "settings.json")}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

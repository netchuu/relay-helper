import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads RELAY_HOME once when it loads, so this file loads its own copy (the query makes it a new module)
// with RELAY_HOME in a scratch folder. The real ~/.relay is never touched.
const scratch = mkdtempSync(join(tmpdir(), "relay-config-"));
const home = join(scratch, "relay");
const savedHome = process.env.RELAY_HOME;
const savedPath = process.env.PATH;
let cfg: typeof import("../src/config.ts");

beforeAll(async () => {
  process.env.RELAY_HOME = home;
  const specifier = "../src/config.ts?config-test";
  cfg = (await import(specifier)) as typeof cfg;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.RELAY_HOME;
  else process.env.RELAY_HOME = savedHome;
  process.env.PATH = savedPath;
  rmSync(scratch, { recursive: true, force: true });
});

const reset = () => rmSync(home, { recursive: true, force: true });

describe("isTestHelper", () => {
  test("only a RELAY_HOME other than ~/.relay is a test helper", () => {
    expect(cfg.isTestHelper({}, "/Users/x")).toBe(false);
    expect(cfg.isTestHelper({ RELAY_HOME: "/Users/x/.relay" }, "/Users/x")).toBe(false);
    expect(cfg.isTestHelper({ RELAY_HOME: "/tmp/other" }, "/Users/x")).toBe(true);
  });
});

describe("paths and version", () => {
  test("paths live under RELAY_HOME", () => {
    expect(cfg.RELAY_HOME).toBe(home);
    expect(cfg.paths.db).toBe(join(home, "relay.db"));
    expect(cfg.paths.config).toBe(join(home, "config.json"));
    expect(cfg.paths.attachments).toBe(join(home, "attachments"));
    expect(typeof cfg.VERSION).toBe("string");
  });
});

describe("ensureHome", () => {
  test("creates the folder private", () => {
    reset();
    cfg.ensureHome();
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });
  test("tightens a folder others could read", () => {
    reset();
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o755);
    cfg.ensureHome();
    expect(statSync(home).mode & 0o077).toBe(0);
  });
  test("leaves a private folder alone", () => {
    cfg.ensureHome();
    cfg.ensureHome();
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });
});

describe("loadConfig", () => {
  test("no file gives the defaults", () => {
    reset();
    const c = cfg.loadConfig();
    expect(c).toMatchObject({
      port: 7878,
      claudeBin: null,
      publicUrl: null,
      relayUrl: null,
      idleAwaySeconds: 120,
      previewChars: 600,
      promptTimeoutSeconds: 86_400,
      preferTyping: true,
      zed: true,
    });
    expect(c.projectRoots).toHaveLength(1);
  });

  test("a partial file keeps the rest at their defaults", () => {
    reset();
    cfg.ensureHome();
    writeFileSync(cfg.paths.config, JSON.stringify({ port: 9000, zed: false }));
    expect(cfg.loadConfig()).toMatchObject({ port: 9000, zed: false, idleAwaySeconds: 120 });
  });

  test("invalid JSON names the file", () => {
    reset();
    cfg.ensureHome();
    writeFileSync(cfg.paths.config, "{ nope");
    expect(() => cfg.loadConfig()).toThrow(/Invalid JSON in .*config\.json/);
  });

  test("values out of range are refused", () => {
    cfg.ensureHome();
    for (const bad of [
      { port: 80 },
      { port: 70000 },
      { port: 1.5 },
      { idleAwaySeconds: 5 },
      { previewChars: 50 },
      { previewChars: 5000 },
      { promptTimeoutSeconds: 10 },
      { relayUrl: "not a url" },
      { preferTyping: "yes" },
    ]) {
      writeFileSync(cfg.paths.config, JSON.stringify(bad));
      expect(() => cfg.loadConfig()).toThrow(/Invalid .*config\.json/);
    }
  });

  test("an empty object and a non-object are handled", () => {
    cfg.ensureHome();
    writeFileSync(cfg.paths.config, "{}");
    expect(cfg.loadConfig().port).toBe(7878);
    writeFileSync(cfg.paths.config, "[1]");
    expect(() => cfg.loadConfig()).toThrow();
  });
});

describe("saveConfig", () => {
  test("writes a private file and merges patches", () => {
    reset();
    cfg.ensureHome();
    const first = cfg.saveConfig({ port: 8000 });
    expect(first.port).toBe(8000);
    expect(statSync(cfg.paths.config).mode & 0o777).toBe(0o600);
    cfg.saveConfig({ publicUrl: "https://a.example" });
    expect(cfg.loadConfig()).toMatchObject({ port: 8000, publicUrl: "https://a.example" });
  });

  test("an invalid patch throws and keeps the old file", () => {
    reset();
    cfg.ensureHome();
    cfg.saveConfig({ port: 8001 });
    expect(() => cfg.saveConfig({ port: 1 })).toThrow();
    expect(cfg.loadConfig().port).toBe(8001);
  });
});

describe("resolveClaudeBin", () => {
  const binDir = () => join(scratch, "bin");
  const fakeClaude = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return file;
  };
  const config = (claudeBin: string | null) => ({ ...cfg.loadConfig(), claudeBin });

  test("a configured path that exists wins", () => {
    reset();
    const file = fakeClaude(binDir());
    expect(cfg.resolveClaudeBin(config(file))).toBe(file);
  });

  test("a configured path inside versions/ is stale and skipped for PATH", () => {
    const stale = fakeClaude(join(scratch, "x", "versions", "1.2.3"));
    const onPath = fakeClaude(join(scratch, "pathdir"));
    process.env.PATH = `${join(scratch, "pathdir")}`;
    expect(cfg.resolveClaudeBin(config(stale))).toBe(onPath);
  });

  test("a missing configured path falls back to PATH", () => {
    const onPath = fakeClaude(join(scratch, "pathdir2"));
    process.env.PATH = join(scratch, "pathdir2");
    expect(cfg.resolveClaudeBin(config(join(scratch, "gone")))).toBe(onPath);
  });

  test("a dangling symlink is skipped", async () => {
    const { symlinkSync } = await import("node:fs");
    const dangling = join(scratch, "dangling");
    mkdirSync(dangling, { recursive: true });
    symlinkSync(join(scratch, "nowhere"), join(dangling, "claude"));
    const good = fakeClaude(join(scratch, "good"));
    process.env.PATH = `${dangling}:${join(scratch, "good")}`;
    expect(cfg.resolveClaudeBin(config(null))).toBe(good);
  });

  test("nothing on PATH goes on to the npm prefix and ends with a path or null", () => {
    process.env.PATH = join(scratch, "empty");
    const found = cfg.resolveClaudeBin(config(null));
    expect(found === null || found.endsWith("/claude")).toBe(true);
  });

  test("CHILD_PATH holds the base directories", () => {
    expect(cfg.CHILD_PATH.split(":")).toContain("/usr/bin");
  });
});

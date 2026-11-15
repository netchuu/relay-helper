import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettings } from "../src/install.ts";
import { addRelayShell, writeZedSettings } from "../src/integrations/zed.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-symlink-"));
  const real = join(dir, "dotfiles");
  mkdirSync(real);
  const target = join(real, "settings.json");
  const link = join(dir, "settings.json");
  return { dir, target, link };
}

describe("symlinked settings", () => {
  test("writeSettings keeps the link and changes the target", () => {
    const { target, link } = setup();
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    writeSettings(link, { a: 1 });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 1 });
    expect(existsSync(`${target}.relay-tmp`)).toBe(false);
  });

  test("writeZedSettings keeps the link and changes the target", () => {
    const { target, link } = setup();
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    writeZedSettings(link, (t) => addRelayShell(t, "/bin/relay"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("relay");
  });

  test("a read-only target gives an error and changes nothing", () => {
    const { dir, target, link } = setup();
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    chmodSync(target, 0o444);
    const before = readdirSync(dir).sort();
    expect(() => writeSettings(link, { a: 1 })).toThrow(/Can't write/);
    expect(() => writeZedSettings(link, (t) => addRelayShell(t, "/bin/relay"))).toThrow(/Can't write/);
    expect(readFileSync(target, "utf8")).toBe("{}\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readdirSync(join(dir, "dotfiles"))).toEqual(["settings.json"]);
  });

  test("an ordinary file is replaced atomically, no tmp left", () => {
    const { dir, link } = setup();
    writeFileSync(link, "{}\n");
    writeSettings(link, { b: 2 });
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(link, "utf8"))).toEqual({ b: 2 });
    expect(readdirSync(dir).some((f) => f.endsWith(".relay-tmp"))).toBe(false);
  });
});

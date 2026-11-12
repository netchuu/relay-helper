/**
 * release/entitlements.plist: the hardened-runtime exceptions the macOS binaries are signed with. relay holds the
 * Accessibility and Automation permissions, so an exception that lets other code into the process hands those
 * permissions to that code. allow-dyld-environment-variables with disable-library-validation did exactly that:
 * DYLD_INSERT_LIBRARIES loaded any dylib into the signed binary. Bun's docs still list them, so guard the file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLIST = join(import.meta.dir, "entitlements.plist");
const BUILD = join(import.meta.dir, "build-darwin.sh");

/** The entitlement keys set to <true/>, with XML comments removed first. */
function grantedEntitlements(xml: string): string[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  return [...body.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)].map((m) => m[1] as string);
}

describe("macOS entitlements", () => {
  const xml = readFileSync(PLIST, "utf8");
  const granted = grantedEntitlements(xml);

  test("grants only what Bun's JIT and bun:ffi need", () => {
    expect(granted.sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ]);
  });

  test("never lets other code into the signed process", () => {
    for (const forbidden of [
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.disable-executable-page-protection",
      "com.apple.security.get-task-allow",
    ]) {
      expect(xml.replace(/<!--[\s\S]*?-->/g, "")).not.toContain(forbidden);
    }
  });

  test("has no <false/> entries or other value types to hide a grant behind", () => {
    const body = xml.replace(/<!--[\s\S]*?-->/g, "");
    expect([...body.matchAll(/<key>/g)].length).toBe(granted.length);
  });

  test.skipIf(process.platform !== "darwin")("is a valid property list", () => {
    const r = Bun.spawnSync(["plutil", "-lint", PLIST]);
    expect(r.exitCode).toBe(0);
  });

  test("build-darwin.sh signs every binary with the hardened runtime and this file", () => {
    const script = readFileSync(BUILD, "utf8");
    expect(script).toContain('ENTITLEMENTS="$ROOT/release/entitlements.plist"');
    expect(script).toMatch(/codesign [^\n]*--options runtime [^\n]*--entitlements "\$ENTITLEMENTS"/);
  });
});

describe("compiled binaries", () => {
  // A bunfig.toml in the working directory can `preload` a script into a compiled binary, and a .env there sets
  // environment variables such as NODE_TLS_REJECT_UNAUTHORIZED. Every build turns both off.
  for (const file of ["release/build-darwin.sh", "release/build-linux.sh", "package.json"]) {
    test(`${file} builds without bunfig.toml or .env autoload`, () => {
      const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
      const builds = text.match(/bun build --compile/g) ?? [];
      expect(builds.length).toBeGreaterThan(0);
      expect(text.match(/--no-compile-autoload-bunfig/g)?.length).toBe(builds.length);
      expect(text.match(/--no-compile-autoload-dotenv/g)?.length).toBe(builds.length);
    });
  }
});

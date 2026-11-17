/** release/release.sh --publish takes the tap account's token before building, so a wrong active gh account fails early. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "release.sh");
let root: string;
let env: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-release-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.log");
  // gh: only `gh auth token --user netchuu` has a login. bun: logs the token it sees and fails, so the script
  // stops at its test step ("Tests failed; not releasing.") without building anything.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "gh $*" >> "${log}"
[ "$1 $2 $3 $4" = "auth token --user netchuu" ] && { echo tok-netchuu; exit 0; }
exit 1
`,
  );
  writeFileSync(join(bin, "bun"), `#!/bin/sh\necho "bun token=\${GH_TOKEN:-none}" >> "${log}"\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "bun"), 0o755);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}` } as Record<string, string>;
  delete env.GH_TOKEN;
  delete env.RELAY_GH_USER;
  delete env.RELAY_PLATFORMS;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const calls = () =>
  existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8") : "";
const release = (extra: Record<string, string> = {}, ...args: string[]) => {
  const r = Bun.spawnSync(["bash", SCRIPT, "0.0.0-test", ...args], {
    env: { ...env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
};

describe("release.sh --publish and the gh account", () => {
  test("takes the netchuu token before building", () => {
    const r = release({}, "--publish");
    expect(r.err).toContain("Tests failed; not releasing.");
    expect(calls()).toContain("gh auth token --user netchuu");
    expect(calls()).toContain("bun token=tok-netchuu");
  });

  test("stops at once, before the build, when that account has no login", () => {
    const r = release({ RELAY_GH_USER: "nobody" }, "--publish");
    expect(r.code).toBe(1);
    expect(r.err).toContain("gh has no login for nobody");
    expect(calls()).not.toContain("bun ");
  });

  test("a GH_TOKEN already set is used as it is", () => {
    release({ GH_TOKEN: "tok-given" }, "--publish");
    expect(calls()).not.toContain("gh auth token");
    expect(calls()).toContain("bun token=tok-given");
  });

  test("a build without --publish doesn't need gh", () => {
    release({ RELAY_GH_USER: "nobody" });
    expect(calls()).not.toContain("gh ");
  });
});

describe("tap-commit.sh", () => {
  test("commits with no git identity configured", () => {
    const repo = join(root, "tap");
    const clean = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const run = (...a: string[]) =>
      Bun.spawnSync(a, { env: clean, cwd: root, stdout: "pipe", stderr: "pipe" });
    run("git", "init", "-q", repo);
    writeFileSync(join(repo, "f"), "x");
    run("git", "-C", repo, "add", "f");
    const r = run("bash", join(import.meta.dir, "tap-commit.sh"), repo, "9.9.9");
    expect(r.stderr.toString()).toBe("");
    expect(run("git", "-C", repo, "log", "-1", "--format=%s").stdout.toString().trim()).toBe("Relay 9.9.9");
  });

  test("release.sh commits before it creates the release and pushes with gh's token", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s.indexOf("tap-commit.sh")).toBeGreaterThan(0);
    expect(s.indexOf("tap-commit.sh")).toBeLessThan(s.indexOf("gh release create"));
    expect(s).toContain("credential.helper='!gh auth git-credential'");
  });
});

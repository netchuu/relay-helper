import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the publish block of release.sh against a local bare repository with a stub gh.
const releaseSh = join(import.meta.dir, "../../release/release.sh");

function publishBlock(): string {
  const lines = readFileSync(releaseSh, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith('if [[ "$PUBLISH" == "--publish" ]]; then'));
  const end = lines.findIndex((l, i) => i > start && l === "fi");
  expect(start).toBeGreaterThan(0);
  return lines.slice(start + 1, end).join("\n");
}

function run(failCommit: boolean, dropFormula = false) {
  const tmp = mkdtempSync(join(tmpdir(), "release-publish-"));
  const home = join(tmp, "home");
  const bin = join(tmp, "bin");
  const hooks = join(tmp, "hooks");
  const dist = join(tmp, "dist");
  const root = join(tmp, "root");
  for (const d of [home, bin, hooks, dist, join(root, "release")]) mkdirSync(d, { recursive: true });
  const gitconfig = join(tmp, "gitconfig");
  writeFileSync(
    gitconfig,
    `[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n` +
      (failCommit ? `[core]\n\thooksPath = ${hooks}\n` : ""),
  );
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'hook refuses' >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const sh = (cmd: string) =>
    Bun.spawnSync(["bash", "-c", cmd], { cwd: tmp, env, stdout: "pipe", stderr: "pipe" });
  const tap = join(tmp, "tap.git");
  const seed = sh(
    `git init -q --bare tap.git && git clone -q tap.git seed 2>/dev/null && mkdir seed/Formula && echo 'version "0.0.1"' > seed/Formula/relay.rb && git -C seed add -A && git -C seed -c core.hooksPath=/dev/null commit -qm old && git -C seed push -q origin HEAD:main`,
  );
  expect(seed.exitCode).toBe(0);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nif [ "$1 $2" = "repo clone" ]; then exec git clone -q "${tap}" "$4"; fi\nexit 0\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  if (!dropFormula) writeFileSync(join(dist, "relay.rb"), 'version "9.9.9"\n');
  writeFileSync(join(dist, "install.sh"), "#!/bin/sh\n");
  writeFileSync(join(dist, "relay-9.9.9-darwin-arm64.tar.gz"), "x");
  writeFileSync(join(dist, "SHA256SUMS"), "x");
  writeFileSync(join(root, "release", "tap-README.md"), "# tap\n");
  const script = join(tmp, "publish.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nset -euo pipefail\nVERSION=9.9.9\nTAP_REPO=example/homebrew-tap\nROOT="${root}"\nDIST="${dist}"\n${publishBlock()}\n`,
  );
  const r = Bun.spawnSync(["bash", script], { cwd: tmp, env, stdout: "pipe", stderr: "pipe" });
  const show = (f: string) => sh(`git --git-dir=tap.git show main:${f}`).stdout.toString().trim();
  const out = {
    exit: r.exitCode,
    stdout: r.stdout.toString(),
    formula: show("Formula/relay.rb"),
    install: show("install.sh"),
    readme: show("README.md"),
  };
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

test("the new formula, install.sh and README reach the tap, then it says published", () => {
  const r = run(false);
  expect(r.exit).toBe(0);
  expect(r.formula).toBe('version "9.9.9"');
  expect(r.install).toBe("#!/bin/sh");
  expect(r.readme).toBe("# tap");
  expect(r.stdout).toContain("• published");
});

test("a tap commit that fails exits non-zero without saying published", () => {
  const r = run(true);
  expect(r.formula).toBe('version "0.0.1"');
  expect(r.stdout).not.toContain("• published");
  expect(r.exit).not.toBe(0);
});

test("a formula that cannot be copied exits non-zero without saying published", () => {
  const r = run(false, true);
  expect(r.formula).toBe('version "0.0.1"');
  expect(r.stdout).not.toContain("• published");
  expect(r.exit).not.toBe(0);
});

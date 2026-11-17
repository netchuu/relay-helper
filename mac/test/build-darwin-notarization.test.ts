import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../release/build-darwin.sh");
const ID = "00000000-0000-0000-0000-000000000000";
const tmp = mkdtempSync(join(tmpdir(), "build-darwin-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Everything that signs, builds or talks to Apple is a stub.
function run(name: string, xcrunBody: string) {
  const bin = join(tmp, name, "bin");
  const dist = join(tmp, name, "dist");
  const log = join(tmp, name, "xcrun.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dist, { recursive: true });
  const stub = (file: string, body: string) => {
    writeFileSync(join(bin, file), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, file), 0o755);
  };
  stub("xcrun", `echo "$@" >> "${log}"\n${xcrunBody}`);
  stub("security", `echo '  1) FAKEFAKE "Developer ID Application: Stub (XXXXXXXXXX)"'`);
  stub("codesign", "exit 0");
  stub("bun", `while [ $# -gt 0 ]; do if [ "$1" = "--outfile" ]; then echo stub > "$2"; fi; shift; done`);
  const p = Bun.spawnSync(["/bin/bash", SCRIPT, "9.9.9", dist], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      RELAY_SIGN_IDENTITY: "FAKEFAKE",
      RELAY_NOTARY_PROFILE: "no-such-profile",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const tarballs = ["arm64", "x64"].filter((a) => existsSync(join(dist, `relay-9.9.9-darwin-${a}.tar.gz`)));
  return {
    code: p.exitCode,
    out: p.stdout.toString() + p.stderr.toString(),
    calls: existsSync(log) ? readFileSync(log, "utf8") : "",
    tarballs,
  };
}

const verdict = (status: string) =>
  `echo '{"id":"${ID}","message":"Processing complete","status":"${status}"}'`;

test("an accepted submission packs both tarballs", () => {
  const r = run("accepted", verdict("Accepted"));
  expect(r.code).toBe(0);
  expect(r.calls).toContain("--output-format json");
  expect(r.tarballs).toEqual(["arm64", "x64"]);
});

for (const status of ["Invalid", "Rejected"]) {
  test(`${status} with exit 0 stops the build and names the submission`, () => {
    const r = run(status, verdict(status));
    expect(r.code).not.toBe(0);
    expect(r.tarballs).toEqual([]);
    expect(r.out).toContain(`status: ${status}`);
    expect(r.out).toContain(`notarytool log ${ID}`);
  });
}

test("a missing verdict stops the build", () => {
  const r = run("empty", "exit 0");
  expect(r.code).not.toBe(0);
  expect(r.tarballs).toEqual([]);
});

test("a failing notarytool stops the build and shows its error", () => {
  const r = run("fail", "echo 'Error: HTTP status code: 401.' >&2; exit 1");
  expect(r.code).not.toBe(0);
  expect(r.tarballs).toEqual([]);
  expect(r.out).toContain("HTTP status code: 401");
});

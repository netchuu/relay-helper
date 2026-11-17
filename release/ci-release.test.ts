/** The release workflow's guards: tag and version check, secrets preflight, and the keychain and profile used when building. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const run = (cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  const r = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (cwd: string, ...args: string[]) =>
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

describe("check-tag.sh", () => {
  let repo: string;
  const check = (tag: string, commit?: string) =>
    run(["bash", join(here, "check-tag.sh"), tag, ...(commit ? [commit] : [])], { cwd: repo });
  const commit = (version: string) => {
    writeFileSync(join(repo, "package.json"), `{\n  "name": "x",\n  "version": "${version}"\n}\n`);
    git(repo, "add", "package.json");
    git(repo, "commit", "-qm", version);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "relay-tag-test-"));
    git(repo, "init", "-q", "-b", "main");
    commit("1.2.3");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("passes when the tag is the version and the commit is on main", () => {
    expect(check("v1.2.3").code).toBe(0);
  });

  test("fails when the tag names another version", () => {
    const r = check("v1.2.4");
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not match");
  });

  test("fails without the v prefix", () => {
    expect(check("1.2.3").code).toBe(1);
  });

  test("fails when the commit is not on main", () => {
    git(repo, "checkout", "-q", "-b", "topic");
    commit("1.2.4");
    const r = check("v1.2.4");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not on main");
  });

  test("fails when main is unknown", () => {
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    expect(check("v1.2.3").code).toBe(1);
  });
});

describe("check-secrets.sh", () => {
  const all = {
    RELAY_SIGN_CERT_P12_BASE64: "p12-value",
    RELAY_SIGN_CERT_PASSWORD: "pw-value",
    RELAY_NOTARY_APPLE_ID: "id-value",
    RELAY_NOTARY_TEAM_ID: "team-value",
    RELAY_NOTARY_PASSWORD: "notary-value",
    RELAY_TAP_TOKEN: "tap-value",
  };
  const check = (secrets: Record<string, string>, ...args: string[]) => {
    const env = { PATH: process.env.PATH ?? "", ...secrets };
    return run(["bash", join(here, "check-secrets.sh"), ...args], { env });
  };

  test("a complete set passes, and no value is printed", () => {
    const r = check(all, "--publish");
    expect(r.code).toBe(0);
    for (const v of Object.values(all)) expect(r.out + r.err).not.toContain(v);
  });

  test("a missing secret fails and is named", () => {
    const { RELAY_NOTARY_PASSWORD: _, ...rest } = all;
    const r = check(rest, "--publish");
    expect(r.code).toBe(1);
    expect(r.err).toContain("RELAY_NOTARY_PASSWORD");
  });

  test("an empty secret fails", () => {
    const r = check({ ...all, RELAY_SIGN_CERT_PASSWORD: "" }, "--publish");
    expect(r.code).toBe(1);
    expect(r.err).toContain("RELAY_SIGN_CERT_PASSWORD");
  });

  test("the tap token is needed only to publish", () => {
    const { RELAY_TAP_TOKEN: _, ...rest } = all;
    expect(check(rest).code).toBe(0);
    expect(check(rest, "--publish").code).toBe(1);
  });
});

describe("build-darwin.sh keychain and profile", () => {
  let root: string;
  let env: Record<string, string>;
  const calls = () => readFileSync(join(root, "calls.log"), "utf8");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "relay-darwin-test-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Every tool logs its arguments; bun fails so the script stops before any build.
    for (const tool of ["security", "bun"]) {
      writeFileSync(
        join(bin, tool),
        `#!/bin/sh\necho "${tool} $*" >> "${root}/calls.log"\n[ "${tool}" = security ] && echo '  1) ABCDEF "Developer ID Application: Test"'\n[ "${tool}" = bun ] && exit 1\nexit 0\n`,
      );
      chmodSync(join(bin, tool), 0o755);
    }
    env = { PATH: `${bin}:${process.env.PATH}` };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const build = (extra: Record<string, string> = {}) =>
    run(["bash", join(here, "build-darwin.sh"), "0.0.0-test", join(root, "dist")], {
      env: { ...env, ...extra },
    });

  test("by hand it looks in the default keychain", () => {
    build();
    expect(calls()).toContain("security find-identity -v -p codesigning\n");
  });

  test("RELAY_KEYCHAIN makes the identity lookup use that keychain", () => {
    build({ RELAY_KEYCHAIN: "/tmp/ci.keychain-db" });
    expect(calls()).toContain("security find-identity -v -p codesigning /tmp/ci.keychain-db");
  });

  test("RELAY_SIGN_IDENTITY is used as given", () => {
    const r = build({ RELAY_SIGN_IDENTITY: "ABCDEF" });
    expect(r.out).toContain("signing with: Developer ID Application: Test");
  });
});

describe("release.yml", () => {
  const text = readFileSync(join(here, "../.github/workflows/release.yml"), "utf8");
  const wf = Bun.YAML.parse(text) as any;

  test("runs only on v* tags and manual dispatch, publish off by default", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ tags: ["v*"] });
    expect(wf.on.workflow_dispatch.inputs.publish.default).toBe(false);
  });

  test("minimal permissions, no pull_request_target", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(text).not.toContain("pull_request_target");
  });

  test("every action is pinned to a full commit SHA", () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  test("the guards run before the tests and the build", () => {
    const steps: any[] = wf.jobs.release.steps;
    const at = (needle: string) => steps.findIndex((s) => String(s.run ?? "").includes(needle));
    expect(at("check-tag.sh")).toBeLessThan(at("bun run test"));
    expect(at("check-secrets.sh")).toBeLessThan(at("bun run test"));
    expect(at("keychain.sh setup")).toBeLessThan(at("release.sh"));
    expect(steps.at(-1).if).toBe("always()");
    expect(steps.at(-1).run).toContain("keychain.sh teardown");
  });

  test("the tap token reaches only the publishing step", () => {
    const withToken = wf.jobs.release.steps.filter((s: any) => JSON.stringify(s).includes("RELAY_TAP_TOKEN"));
    expect(withToken.map((s: any) => s.name)).toEqual([
      "Release secrets are set",
      "Build, sign, notarize and publish",
    ]);
  });
});

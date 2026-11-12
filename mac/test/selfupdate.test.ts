import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  brewCandidates,
  compareVersions,
  parseVersion,
  SelfUpdater,
  underServiceManager,
} from "../src/daemon/selfUpdate.ts";
import { run } from "../src/platform/exec.ts";

const DIR = join(process.env.RELAY_TEST_ROOT ?? "/tmp", `relay-selfupdate-${process.pid}`);
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** A stand-in `relay` that prints a version and records the commands it was given. */
function fakeRelay(name: string, version: string, opts: { failInstall?: boolean } = {}): string {
  const dir = join(DIR, name);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "relay");
  const log = join(dir, "calls.log");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
if [ "$1" = "--version" ]; then echo "relay ${version} (protocol 1)"; exit 0; fi
${opts.failInstall ? 'echo "boom" >&2; exit 3' : "exit 0"}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const calls = (bin: string) => {
  try {
    return readFileSync(join(bin, "..", "calls.log"), "utf8")
      .trim()
      .split("\n");
  } catch {
    return [];
  }
};

const runner = async (cmd: string[]) => {
  const r = await run(cmd, { timeoutMs: 10_000 });
  return { code: r.code, out: r.out || r.err };
};

function updater(candidates: string[], over: Partial<ConstructorParameters<typeof SelfUpdater>[0]> = {}) {
  let exited = 0;
  const u = new SelfUpdater({
    current: "0.5.0",
    candidates,
    ownBin: join(DIR, "own", "relay"),
    run: runner,
    restartsOnExit: true,
    busy: () => false,
    exit: () => {
      exited++;
    },
    ...over,
  });
  return { u, exited: () => exited };
}

describe("self-update from Homebrew", () => {
  test("versions compare numerically", () => {
    expect(compareVersions("0.10.0", "0.9.3")).toBe(1);
    expect(compareVersions("0.5.0", "0.5.0")).toBe(0);
    expect(compareVersions("0.5", "0.5.1")).toBe(-1);
    expect(parseVersion("relay 0.6.0 (protocol 1)\n")).toBe("0.6.0");
    expect(parseVersion("something else")).toBeNull();
  });

  test("a newer Homebrew relay is installed with its own install, then the daemon exits", async () => {
    const brew = fakeRelay("newer", "0.6.0");
    const { u, exited } = updater([join(DIR, "missing", "relay"), brew]);
    expect(await u.check()).toBe("updated");
    expect(calls(brew)).toEqual(["--version", "install --no-service --from-update"]);
    expect(exited()).toBe(1);
  });

  test("the same or an older version does nothing, and --version runs once per binary", async () => {
    const same = fakeRelay("same", "0.5.0");
    const older = fakeRelay("older", "0.4.0");
    const { u, exited } = updater([same, older]);
    expect(await u.check()).toBe("none");
    expect(await u.check()).toBe("none");
    expect(calls(same)).toEqual(["--version"]);
    expect(calls(older)).toEqual(["--version"]);
    expect(exited()).toBe(0);
  });

  test("waits while a prompt is open, then updates", async () => {
    const brew = fakeRelay("busy", "0.6.0");
    let open = true;
    const { u, exited } = updater([brew], { busy: () => open });
    expect(await u.check()).toBe("busy");
    expect(exited()).toBe(0);
    open = false;
    expect(await u.check()).toBe("updated");
    expect(exited()).toBe(1);
  });

  test("a failed install keeps the daemon running and isn't retried every tick", async () => {
    const brew = fakeRelay("broken", "0.6.0", { failInstall: true });
    const { u, exited } = updater([brew]);
    expect(await u.check()).toBe("failed");
    expect(await u.check()).toBe("none");
    expect(calls(brew).filter((c) => c.startsWith("install"))).toHaveLength(1);
    expect(exited()).toBe(0);
  });

  test("the copy the service runs is never its own update source", async () => {
    const own = fakeRelay("own", "9.9.9");
    const link = join(DIR, "brew-link");
    mkdirSync(link, { recursive: true });
    symlinkSync(own, join(link, "relay"));
    const { u } = updater([join(link, "relay")], { ownBin: own });
    expect(await u.check()).toBe("none");
  });

  test("off when nothing would restart the helper", () => {
    const { u } = updater([fakeRelay("unused", "0.6.0")], { restartsOnExit: false });
    u.start(60_000);
    u.stop();
    expect(underServiceManager({ XPC_SERVICE_NAME: "dev.relay.daemon" })).toBe(true);
    expect(underServiceManager({ INVOCATION_ID: "abc" })).toBe(true);
    expect(underServiceManager({ XPC_SERVICE_NAME: "0" })).toBe(false);
    expect(brewCandidates({ HOMEBREW_PREFIX: "/opt/homebrew" }, "/home/a")).toEqual([
      "/opt/homebrew/bin/relay",
      "/usr/local/bin/relay",
      "/home/linuxbrew/.linuxbrew/bin/relay",
      "/home/a/.linuxbrew/bin/relay",
    ]);
  });
});

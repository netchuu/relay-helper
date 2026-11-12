import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { purgeData } from "../src/install.ts";
import { type LaunchdDeps, launchdService } from "../src/platform/darwin.ts";
import type { RunResult } from "../src/platform/exec.ts";
import { type LinuxDeps, linuxService } from "../src/platform/linux.ts";

// `relay uninstall` has to remove what starts the helper at login, or it comes back at the next login and phones
// paired with it keep working. Every system call goes to a fake; nothing touches this machine's launchd or systemd.

const tmp = () => mkdtempSync(join(tmpdir(), "relay-uninstall-"));

const ctx = (home: string) => ({
  relayBin: join(home, "bin", "relay"),
  home,
  logPath: join(home, "daemon.log"),
  path: "/usr/bin:/bin",
});

function fakeRun(commands: Record<string, Partial<RunResult>> = {}) {
  const calls: string[] = [];
  const run = async (cmd: string[]): Promise<RunResult> => {
    const key = cmd.join(" ");
    calls.push(key);
    const hit = commands[key];
    return hit ? { code: 0, out: "", err: "", ...hit } : { code: 127, out: "", err: "not found" };
  };
  return { calls, run };
}

describe("launchd (macOS)", () => {
  const deps = (dir: string, commands: Record<string, Partial<RunResult>> = {}) => {
    const fake = fakeRun(commands);
    const d: LaunchdDeps = {
      run: fake.run,
      plistPath: join(dir, "LaunchAgents", "dev.relay.daemon.plist"),
      uid: 501,
      sleep: async () => {},
    };
    return { ...d, calls: fake.calls };
  };

  test("install writes the plist that starts the helper at login", async () => {
    const dir = tmp();
    const d = deps(dir, {
      "launchctl bootout gui/501/dev.relay.daemon": {},
      [`launchctl bootstrap gui/501 ${join(dir, "LaunchAgents", "dev.relay.daemon.plist")}`]: {},
    });
    await launchdService(d).install(ctx(dir));
    expect(existsSync(d.plistPath)).toBe(true);
    expect(d.calls).toContain(`launchctl bootstrap gui/501 ${d.plistPath}`);
  });

  test("uninstall stops the helper and removes the login item", async () => {
    const dir = tmp();
    const d = deps(dir, { "launchctl bootout gui/501/dev.relay.daemon": {} });
    mkdirSync(join(dir, "LaunchAgents"), { recursive: true });
    writeFileSync(d.plistPath, "<plist/>");
    const service = launchdService(d);
    await service.uninstall(ctx(dir));
    expect(d.calls).toEqual(["launchctl bootout gui/501/dev.relay.daemon"]);
    expect(existsSync(d.plistPath)).toBe(false);
    expect((await service.status(ctx(dir))).state).toBe("missing");
  });

  test("uninstall works when the helper is already stopped or was never installed", async () => {
    const dir = tmp();
    // bootout fails (nothing loaded) and there's no plist: no error.
    const d = deps(dir, {
      "launchctl bootout gui/501/dev.relay.daemon": { code: 3, err: "No such process" },
    });
    await launchdService(d).uninstall(ctx(dir));
    expect(existsSync(d.plistPath)).toBe(false);
  });
});

describe("systemd (Linux)", () => {
  const deps = (dir: string, commands: Record<string, Partial<RunResult>> = {}) => {
    const fake = fakeRun(commands);
    const d: LinuxDeps = {
      run: fake.run,
      env: { XDG_CONFIG_HOME: join(dir, "config") },
      uid: 1000,
      user: "ana",
      now: () => 0,
      atime: () => null,
    };
    return { ...d, calls: fake.calls };
  };

  test("uninstall disables the unit and removes it", async () => {
    const dir = tmp();
    const units = join(dir, "config", "systemd", "user");
    const d = deps(dir, {
      "systemctl --user disable --now relay.service": {},
      "systemctl --user daemon-reload": {},
    });
    mkdirSync(units, { recursive: true });
    writeFileSync(join(units, "relay.service"), "[Unit]\n");
    await linuxService(d).uninstall(ctx(dir));
    expect(d.calls).toContain("systemctl --user disable --now relay.service");
    expect(d.calls).toContain("systemctl --user daemon-reload");
    expect(existsSync(join(units, "relay.service"))).toBe(false);
  });

  test("without a working systemctl, the unit and its enable link still go", async () => {
    const dir = tmp();
    const units = join(dir, "config", "systemd", "user");
    const d = deps(dir); // every systemctl call fails
    mkdirSync(join(units, "default.target.wants"), { recursive: true });
    writeFileSync(join(units, "relay.service"), "[Unit]\n");
    symlinkSync(join(units, "relay.service"), join(units, "default.target.wants", "relay.service"));
    await linuxService(d).uninstall(ctx(dir));
    expect(existsSync(join(units, "relay.service"))).toBe(false);
    expect(existsSync(join(units, "default.target.wants", "relay.service"))).toBe(false);
  });

  test("the background-process fallback: its pidfile goes", async () => {
    const dir = tmp();
    // A pid that isn't a relay daemon: nothing is killed, the stale pidfile is removed.
    writeFileSync(join(dir, "daemon.pid"), `${process.pid}\n`);
    await linuxService(deps(dir)).uninstall(ctx(dir));
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });
});

describe("relay uninstall --purge", () => {
  test("deletes the data directory with the paired phones and keys", () => {
    const home = join(tmp(), ".relay");
    mkdirSync(join(home, "attachments", "s1"), { recursive: true });
    writeFileSync(join(home, "relay.db"), "");
    writeFileSync(join(home, "identity.json"), "{}");
    expect(purgeData(home, tmp())).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(purgeData(home, tmp())).toBe(false);
  });

  test("refuses the home directory or the filesystem root", () => {
    const userHome = tmp();
    expect(() => purgeData(userHome, userHome)).toThrow("refusing");
    expect(() => purgeData(`${userHome}/`, userHome)).toThrow("refusing");
    expect(() => purgeData("/", userHome)).toThrow("refusing");
    expect(existsSync(userHome)).toBe(true);
  });

  test("won't go with --no-service, and then changes nothing", async () => {
    const dir = tmp();
    const settings = join(dir, "settings.json");
    writeFileSync(settings, '{"hooks":{}}\n');
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "uninstall",
        "--purge",
        "--no-service",
        "--settings",
        settings,
      ],
      {
        env: {
          ...process.env,
          HOME: dir,
          RELAY_HOME: join(dir, ".relay"),
          XDG_CONFIG_HOME: join(dir, "config"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain("--no-service");
    // The settings weren't touched: no backup was written.
    expect(readdirSync(dir).filter((f) => f.startsWith("settings.json"))).toEqual(["settings.json"]);
  });
});

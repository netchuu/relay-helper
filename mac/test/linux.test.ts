import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketDirs } from "../src/daemon/registry.ts";
import type { RunResult } from "../src/platform/exec.ts";
import {
  desktopPresence,
  type LinuxDeps,
  lingerNote,
  linuxService,
  loginTtys,
  newestActivity,
  parseProperties,
  readPresence,
  systemdUnit,
  tmuxIdle,
  unitPath,
} from "../src/platform/linux.ts";

const NOW = 1_800_000_000_000; // ms

/** A fake system: maps a command line (joined with spaces) to its result; anything else is "not found". */
function fakeDeps(
  commands: Record<string, Partial<RunResult>>,
  extra: Partial<LinuxDeps> = {},
): LinuxDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd) => {
      const key = cmd.join(" ");
      calls.push(key);
      const hit = commands[key];
      return hit ? { code: 0, out: "", err: "", ...hit } : { code: 127, out: "", err: "not found" };
    },
    env: {},
    uid: 1000,
    user: "ana",
    now: () => NOW,
    atime: () => null,
    ...extra,
  };
}

const SESSION_PROPS = "-p Type -p Active -p Remote -p IdleHint -p IdleSinceHint -p LockedHint";
const ctx = (home: string) => ({
  relayBin: "/home/ana/.relay/bin/relay",
  home,
  logPath: join(home, "daemon.log"),
  path: "/home/ana/.local/bin:/usr/bin:/bin",
});

describe("linux service", () => {
  test("the systemd unit runs `relay daemon`, restarts on failure and logs to daemon.log", () => {
    const unit = systemdUnit(ctx("/home/ana/.relay"), {});
    expect(unit).toContain('ExecStart="/home/ana/.relay/bin/relay" daemon');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=2");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('Environment="PATH=/home/ana/.local/bin:/usr/bin:/bin"');
    expect(unit).toContain("StandardError=append:/home/ana/.relay/daemon.log");
    expect(unit).not.toContain("RELAY_HOME");
  });

  test("the unit escapes systemd specifiers and passes a custom RELAY_HOME through", () => {
    const unit = systemdUnit({ ...ctx("/tmp/r"), relayBin: "/opt/100%/relay" }, { RELAY_HOME: "/tmp/r" });
    expect(unit).toContain('ExecStart="/opt/100%%/relay" daemon');
    expect(unit).toContain('Environment="RELAY_HOME=/tmp/r"');
  });

  test("the unit goes under XDG_CONFIG_HOME when it is set", () => {
    expect(unitPath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/systemd/user/relay.service");
    expect(unitPath({})).toEndWith("/.config/systemd/user/relay.service");
  });

  test("with a systemd user session, install writes the unit, enables and restarts it", async () => {
    const home = mkdtempSync(join(tmpdir(), "relay-linux-"));
    const deps = fakeDeps(
      {
        "systemctl --user show-environment": { out: "PATH=/usr/bin" },
        "systemctl --user daemon-reload": {},
        "systemctl --user enable relay.service": {},
        "systemctl --user restart relay.service": {},
        "loginctl show-user 1000 -p Linger": { out: "Linger=no" },
      },
      { env: { XDG_CONFIG_HOME: join(home, "config") } },
    );
    const res = await linuxService(deps).install(ctx(home));
    expect(res.mode).toBe("systemd");
    expect(readFileSync(join(home, "config/systemd/user/relay.service"), "utf8")).toContain("ExecStart=");
    expect(deps.calls).toContain("systemctl --user restart relay.service");
    expect(res.notes[0]?.level).toBe("warn");
    expect(res.notes[0]?.text).toContain("sudo loginctl enable-linger ana");
    // Relay never runs sudo itself.
    expect(deps.calls.some((c) => c.startsWith("sudo"))).toBe(false);
  });

  test("without a systemd user session, install falls back to a background process", async () => {
    const home = mkdtempSync(join(tmpdir(), "relay-linux-"));
    const deps = fakeDeps({}, { env: { XDG_CONFIG_HOME: join(home, "config") } });
    // /bin/sh stands in for the relay binary: `sh daemon` exits at once, which is fine for this test.
    const res = await linuxService(deps).install({ ...ctx(home), relayBin: "/bin/sh" });
    expect(res.mode).toBe("background process");
    expect(res.notes[0]?.text).toContain("won't start again after a reboot");
    expect(Number(readFileSync(join(home, "daemon.pid"), "utf8"))).toBeGreaterThan(1);
    expect(deps.calls.some((c) => c.includes("enable"))).toBe(false);
  });

  test("a failing systemctl is reported, not swallowed", async () => {
    const home = mkdtempSync(join(tmpdir(), "relay-linux-"));
    const deps = fakeDeps(
      {
        "systemctl --user show-environment": {},
        "systemctl --user daemon-reload": { code: 1, err: "Failed to connect to bus" },
      },
      { env: { XDG_CONFIG_HOME: join(home, "config") } },
    );
    await expect(linuxService(deps).install(ctx(home))).rejects.toThrow("Failed to connect to bus");
  });

  test("lingering notes", () => {
    expect(lingerNote(true, "ana").level).toBe("ok");
    expect(lingerNote(false, "ana").text).toContain("sudo loginctl enable-linger ana");
    expect(lingerNote(null, "ana").level).toBe("warn");
  });
});

describe("linux presence", () => {
  test("parses loginctl properties", () => {
    expect(parseProperties("Type=wayland\nActive=yes\nIdleSinceHint=0\n")).toEqual({
      Type: "wayland",
      Active: "yes",
      IdleSinceHint: "0",
    });
  });

  const desktop = (props: string, extra: Record<string, Partial<RunResult>> = {}, env = {}) =>
    fakeDeps(
      {
        "loginctl show-user 1000 -p Sessions": { out: "Sessions=c1 4" },
        [`loginctl show-session c1 ${SESSION_PROPS}`]: {
          out: "Type=tty\nActive=yes\nRemote=yes\nIdleHint=no\nIdleSinceHint=0\nLockedHint=no",
        },
        [`loginctl show-session 4 ${SESSION_PROPS}`]: { out: props },
        ...extra,
      },
      { env },
    );

  test("an idle desktop reports how long it has been idle", async () => {
    const since = (NOW / 1000 - 300) * 1e6; // idle for 5 minutes, in microseconds
    const r = await desktopPresence(
      desktop(`Type=wayland\nActive=yes\nRemote=no\nIdleHint=yes\nIdleSinceHint=${since}\nLockedHint=yes`),
    );
    expect(r?.idleSeconds).toBeCloseTo(300, 0);
    expect(r?.locked).toBe(true);
  });

  test("a desktop that has never set the idle hint doesn't count as 'here'", async () => {
    const r = await desktopPresence(
      desktop("Type=x11\nActive=yes\nRemote=no\nIdleHint=no\nIdleSinceHint=0\nLockedHint=no"),
    );
    expect(r).toBeNull();
  });

  test("xprintidle wins on X11 when it is installed", async () => {
    const r = await desktopPresence(
      desktop(
        "Type=x11\nActive=yes\nRemote=no\nIdleHint=no\nIdleSinceHint=0\nLockedHint=no",
        { xprintidle: { out: "4500" } },
        { DISPLAY: ":0" },
      ),
    );
    expect(r).toEqual({ idleSeconds: 4.5, locked: false, source: "desktop (xprintidle)" });
  });

  test("SSH sessions and desktops in the background are skipped", async () => {
    const r = await desktopPresence(
      desktop("Type=wayland\nActive=no\nRemote=no\nIdleHint=no\nIdleSinceHint=5\nLockedHint=no"),
    );
    expect(r).toBeNull();
  });

  test("tmux: the newest client activity across servers", async () => {
    expect(newestActivity(["100\n250", "", "180"])).toBe(250);
    expect(newestActivity(["", "\n"])).toBeNull();
    const deps = fakeDeps({
      "tmux list-clients -F #{client_activity}": { out: String(NOW / 1000 - 40) },
      "tmux -S /tmp/tmux-1000/work list-clients -F #{client_activity}": { out: String(NOW / 1000 - 12) },
    });
    expect(await tmuxIdle(deps, ["/tmp/tmux-1000/work", "/tmp/tmux-1000/work"])).toBe(12);
  });

  test("login terminals come from `who`, for this user only", () => {
    const who = [
      "ana      pts/0        2026-11-02 10:00 (203.0.113.7)",
      "bob      pts/1        2026-11-02 10:05 (198.51.100.2)",
      "ana      tty2         2026-11-02 09:00",
      "ana      :0           2026-11-02 09:00 (:0)",
    ].join("\n");
    expect(loginTtys(who, "ana")).toEqual(["/dev/pts/0", "/dev/tty2"]);
  });

  test("falls back from desktop to tmux to terminal to 'can't tell'", async () => {
    const tmux = fakeDeps({ "tmux list-clients -F #{client_activity}": { out: String(NOW / 1000 - 3) } });
    expect(await readPresence(tmux)).toEqual({ idleSeconds: 3, locked: null, source: "tmux" });

    const tty = fakeDeps(
      { who: { out: "ana pts/3 2026-11-02 10:00 (203.0.113.7)" } },
      { atime: (p) => (p === "/dev/pts/3" ? NOW - 90_000 : null) },
    );
    expect(await readPresence(tty)).toEqual({ idleSeconds: 90, locked: null, source: "terminal" });

    expect(await readPresence(fakeDeps({}))).toEqual({ idleSeconds: null, locked: null, source: "none" });
  });
});

describe("inbox socket location", () => {
  test("Linux logins use $XDG_RUNTIME_DIR, the Mac uses /tmp", () => {
    expect(socketDirs({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000)).toEqual([
      "/run/user/1000/cc-socks",
      "/tmp/cc-socks",
      "/tmp/cc-socks-1000",
    ]);
    expect(socketDirs({}, 501)).toEqual(["/run/user/501/cc-socks", "/tmp/cc-socks", "/tmp/cc-socks-501"]);
    expect(socketDirs({ CLAUDE_CODE_TMPDIR: "/scratch" }, undefined)).toEqual([
      "/scratch/cc-socks",
      "/tmp/cc-socks",
    ]);
  });
});

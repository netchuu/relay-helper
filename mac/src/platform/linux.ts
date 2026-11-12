import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { type Runner, run as realRun } from "./exec.ts";
import type {
  Check,
  Platform,
  PresenceContext,
  PresenceReading,
  ServiceContext,
  ServiceStatus,
} from "./types.ts";

export const UNIT_NAME = "relay.service";

/** Things the Linux code reads from the system, swappable in tests. */
export interface LinuxDeps {
  run: Runner;
  env: Record<string, string | undefined>;
  uid: number;
  user: string;
  now: () => number;
  /** Last access time of a file in ms, or null if it can't be read. */
  atime: (path: string) => number | null;
}

/** The login name for messages. Bun's userInfo() says "unknown" when $USER isn't set (docker exec, cron). */
function userName(): string {
  const fromEnv = process.env.USER || process.env.LOGNAME;
  if (fromEnv) return fromEnv;
  const name = userInfo().username;
  return name && name !== "unknown" ? name : "$USER";
}

const defaultDeps = (): LinuxDeps => ({
  run: realRun,
  env: process.env,
  uid: process.getuid?.() ?? 0,
  user: userName(),
  now: Date.now,
  atime: (path) => {
    try {
      return statSync(path).atimeMs;
    } catch {
      return null;
    }
  },
});

// ---------------------------------------------------------------------------------------------------
// Service: a systemd user unit, or a plain background process when there's no systemd user session.
// ---------------------------------------------------------------------------------------------------

/** The unit lives under $XDG_CONFIG_HOME, the one place Relay respects it. Everything else is ~/.relay. */
export function unitPath(env: LinuxDeps["env"] = process.env): string {
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "systemd", "user", UNIT_NAME);
}

/** Quotes a value for a systemd unit file: `%` is a specifier there, so it's doubled. */
function sdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function systemdUnit(ctx: ServiceContext, env: LinuxDeps["env"] = process.env): string {
  const lines = [
    "[Unit]",
    "Description=Relay helper for Claude Code",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${sdQuote(ctx.relayBin)} daemon`,
    "Restart=always",
    "RestartSec=2",
    `Environment=${sdQuote(`PATH=${ctx.path}`)}`,
  ];
  // A custom data directory (tests, or someone who moved it) has to reach the daemon too.
  if (env.RELAY_HOME) lines.push(`Environment=${sdQuote(`RELAY_HOME=${env.RELAY_HOME}`)}`);
  lines.push(
    // The daemon logs to stderr; keep it in daemon.log like on the Mac, so the docs hold for both.
    `StandardOutput=append:${ctx.logPath.replace(/%/g, "%%")}`,
    `StandardError=append:${ctx.logPath.replace(/%/g, "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

/**
 * `systemctl --user` needs a running user manager and a D-Bus session bus to reach it. Containers,
 * WSL without systemd and some `su` shells have neither.
 */
export async function hasSystemdUser(deps: Pick<LinuxDeps, "run">): Promise<boolean> {
  const res = await deps.run(["systemctl", "--user", "show-environment"]);
  return res.code === 0;
}

/** Linger keeps user services running after the last login session ends (SSH logout). */
export async function lingerEnabled(deps: Pick<LinuxDeps, "run" | "uid">): Promise<boolean | null> {
  const res = await deps.run(["loginctl", "show-user", String(deps.uid), "-p", "Linger"]);
  if (res.code !== 0) return null;
  const m = res.out.match(/^Linger=(yes|no)$/m);
  return m ? m[1] === "yes" : null;
}

export function lingerNote(linger: boolean | null, user: string): Check {
  if (linger === true)
    return { level: "ok", text: "lingering is on: the helper keeps running after you log out" };
  const how = `sudo loginctl enable-linger ${user}`;
  if (linger === false)
    return {
      level: "warn",
      text: `lingering is off: the helper stops when your last session ends (an SSH logout, for example). On a server, run \`${how}\``,
    };
  return { level: "warn", text: `couldn't check lingering. On a server, make sure it's on: \`${how}\`` };
}

const pidFile = (home: string) => join(home, "daemon.pid");

/** The pid in the pidfile, if that process is still a running `relay daemon`. */
export function backgroundPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile(home), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    // /proc/<pid>/cmdline is NUL-separated; make sure the pid wasn't reused by something else.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmdline.includes("daemon") && cmdline.some((a) => a.endsWith("relay") || a.endsWith("cli.ts"))
      ? pid
      : null;
  } catch {
    return null;
  }
}

/** Stops a background daemon and waits up to 5 s for it to exit, so it releases the hook socket. */
async function stopBackground(home: string): Promise<void> {
  const pid = backgroundPid(home);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 50 && backgroundPid(home) === pid; i++) await Bun.sleep(100);
    } catch {
      // already gone
    }
  }
  if (existsSync(pidFile(home))) unlinkSync(pidFile(home));
}

/** True for a symbolic link, dangling or not (existsSync follows links). */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Starts the daemon in its own session (setsid), so closing the terminal doesn't stop it. */
function startBackground(ctx: ServiceContext): number {
  mkdirSync(dirname(ctx.logPath), { recursive: true, mode: 0o700 });
  const fd = openSync(ctx.logPath, "a", 0o600);
  try {
    const child = spawn(ctx.relayBin, ["daemon"], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, PATH: ctx.path },
    });
    if (!child.pid) throw new Error(`couldn't start ${ctx.relayBin}`);
    child.unref();
    writeFileSync(pidFile(ctx.home), `${child.pid}\n`, { mode: 0o600 });
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

const BACKGROUND_NOTE: Check = {
  level: "warn",
  text: "no systemd user session, so the helper runs as a plain background process. It won't start again after a reboot; run `relay restart` then",
};

async function systemctl(deps: Pick<LinuxDeps, "run">, ...args: string[]): Promise<void> {
  const res = await deps.run(["systemctl", "--user", ...args], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${res.err || res.out}`);
}

export function linuxService(deps: LinuxDeps): Platform["service"] {
  return {
    async install(ctx) {
      // An earlier fallback install may have left a background daemon; only one may own the socket.
      await stopBackground(ctx.home);
      if (await hasSystemdUser(deps)) {
        const path = unitPath(deps.env);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, systemdUnit(ctx, deps.env));
        await systemctl(deps, "daemon-reload");
        await systemctl(deps, "enable", UNIT_NAME);
        // restart, not start: after an upgrade the old binary must be replaced by the new one.
        await systemctl(deps, "restart", UNIT_NAME);
        return {
          state: "running",
          mode: "systemd",
          notes: [lingerNote(await lingerEnabled(deps), deps.user)],
        };
      }
      startBackground(ctx);
      return { state: "running", mode: "background process", notes: [BACKGROUND_NOTE] };
    },

    /**
     * Stops the daemon and removes what starts it at login: the unit and its enable link, or the background
     * process. The link goes too when `systemctl --user` doesn't work at the moment (no user bus).
     */
    async uninstall(ctx) {
      const path = unitPath(deps.env);
      if (existsSync(path)) {
        await deps.run(["systemctl", "--user", "disable", "--now", UNIT_NAME], { timeoutMs: 20_000 });
        unlinkSync(path);
        await deps.run(["systemctl", "--user", "daemon-reload"]);
      }
      const wants = join(dirname(path), "default.target.wants", UNIT_NAME);
      if (existsSync(wants) || isLink(wants)) unlinkSync(wants);
      await stopBackground(ctx.home);
    },

    async restart(ctx) {
      if (existsSync(unitPath(deps.env)) && (await hasSystemdUser(deps))) {
        await systemctl(deps, "restart", UNIT_NAME);
        return;
      }
      await stopBackground(ctx.home);
      startBackground(ctx);
    },

    async status(ctx): Promise<ServiceStatus> {
      if (existsSync(unitPath(deps.env))) {
        if (!(await hasSystemdUser(deps)))
          return {
            state: "stopped",
            mode: "systemd",
            notes: [
              {
                level: "bad",
                text: "the systemd unit is installed but `systemctl --user` doesn't work here",
              },
            ],
          };
        const active = await deps.run(["systemctl", "--user", "is-active", UNIT_NAME]);
        return {
          state: active.out === "active" ? "running" : "stopped",
          mode: "systemd",
          notes: [lingerNote(await lingerEnabled(deps), deps.user)],
        };
      }
      if (backgroundPid(ctx.home))
        return { state: "running", mode: "background process", notes: [BACKGROUND_NOTE] };
      return { state: "missing", mode: "none", notes: [] };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Presence. Deciding "here" wrongly means a missed prompt, so when in doubt the answer is "can't tell",
// which the daemon treats as away.
// ---------------------------------------------------------------------------------------------------

/** Parses `loginctl show-session -p …` output (Key=Value lines). */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Reads the person's local desktop session from logind. Returns null when there's no desktop session in
 * front, or when the desktop doesn't report idleness (logind then says "not idle" forever).
 */
export async function desktopPresence(deps: LinuxDeps): Promise<PresenceReading | null> {
  const user = await deps.run(["loginctl", "show-user", String(deps.uid), "-p", "Sessions"]);
  if (user.code !== 0) return null;
  const ids = (parseProperties(user.out).Sessions ?? "").split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const res = await deps.run([
      "loginctl",
      "show-session",
      id,
      "-p",
      "Type",
      "-p",
      "Active",
      "-p",
      "Remote",
      "-p",
      "IdleHint",
      "-p",
      "IdleSinceHint",
      "-p",
      "LockedHint",
    ]);
    if (res.code !== 0) continue;
    const p = parseProperties(res.out);
    if (!(p.Type === "x11" || p.Type === "wayland") || p.Remote === "yes" || p.Active !== "yes") continue;
    const locked = p.LockedHint === "yes";
    // X11 with xprintidle installed is exact. Wayland has nothing like it without extra packages.
    if (deps.env.DISPLAY) {
      const x = await deps.run(["xprintidle"]);
      if (x.code === 0 && /^\d+$/.test(x.out))
        return { idleSeconds: Number(x.out) / 1000, locked, source: "desktop (xprintidle)" };
    }
    const since = Number(p.IdleSinceHint ?? "0"); // microseconds since the epoch
    if (p.IdleHint === "yes" && since > 0)
      return {
        idleSeconds: Math.max(0, deps.now() / 1000 - since / 1e6),
        locked,
        source: "desktop (logind)",
      };
    // "Not idle" only means something if the desktop has ever set the hint; logind's default is "no".
    if (p.IdleHint === "no" && since > 0) return { idleSeconds: 0, locked, source: "desktop (logind)" };
    if (locked) return { idleSeconds: null, locked, source: "desktop (logind)" };
  }
  return null;
}

/** Seconds since anyone typed in an attached tmux client, from `#{client_activity}` (epoch seconds). */
export function newestActivity(outputs: string[]): number | null {
  const stamps = outputs
    .flatMap((o) => o.split("\n"))
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return stamps.length ? Math.max(...stamps) : null;
}

export async function tmuxIdle(deps: LinuxDeps, sockets: string[] = []): Promise<number | null> {
  const targets: string[][] = [[], ...[...new Set(sockets)].map((s) => ["-S", s])];
  const outs = await Promise.all(
    targets.map(async (t) => {
      const res = await deps.run(["tmux", ...t, "list-clients", "-F", "#{client_activity}"]);
      return res.code === 0 ? res.out : "";
    }),
  );
  const newest = newestActivity(outs);
  return newest === null ? null : Math.max(0, deps.now() / 1000 - newest);
}

/** The person's login terminals from `who` (SSH sessions and consoles; tmux panes aren't listed). */
export function loginTtys(whoOutput: string, user: string): string[] {
  return whoOutput
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols[0] === user && cols[1] && /^(pts\/\d+|tty\d+)$/.test(cols[1]))
    .map((cols) => `/dev/${cols[1]}`);
}

/**
 * A terminal's access time moves when someone types into it, which is what `w` shows as IDLE. Only
 * login terminals count: tmux panes are read by the programs inside them, including when Relay itself
 * types a reply, so their times would make an away person look present.
 */
export async function ttyIdle(deps: LinuxDeps): Promise<number | null> {
  const who = await deps.run(["who"]);
  if (who.code !== 0) return null;
  const times = loginTtys(who.out, deps.user)
    .map(deps.atime)
    .filter((t): t is number => t !== null);
  return times.length ? Math.max(0, (deps.now() - Math.max(...times)) / 1000) : null;
}

export async function readPresence(deps: LinuxDeps, ctx: PresenceContext = {}): Promise<PresenceReading> {
  const desktop = await desktopPresence(deps);
  if (desktop) return desktop;
  const tmux = await tmuxIdle(deps, ctx.tmuxSockets);
  if (tmux !== null) return { idleSeconds: tmux, locked: null, source: "tmux" };
  const tty = await ttyIdle(deps);
  if (tty !== null) return { idleSeconds: tty, locked: null, source: "terminal" };
  return { idleSeconds: null, locked: null, source: "none" };
}

// ---------------------------------------------------------------------------------------------------

export function createLinux(deps: LinuxDeps = defaultDeps()): Platform {
  const home = homedir();
  return {
    name: "linux",
    service: linuxService(deps),
    presence: { read: (ctx) => readPresence(deps, ctx) },
    // No typing outside tmux: TIOCSTI is off on current kernels, and X11 keystroke injection would go to
    // whatever window has focus. Everything that isn't in tmux uses Claude Code's inbox.
    typing: { routes: () => [], peek: async () => null, type: async () => false, key: async () => false },
    async afterCopy() {},
    // The short hostname: that's what people see in their shell prompt and SSH config.
    computerName: async () => hostname().split(".")[0] || hostname(),
    extraPath: [
      join(home, ".local", "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".bun", "bin"),
      "/home/linuxbrew/.linuxbrew/bin",
    ],
  };
}

export const linux = createLinux();

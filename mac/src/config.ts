import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { z } from "zod";
import { BASE_PATH } from "./platform/exec.ts";
import { platform } from "./platform/index.ts";

/** Set at build time for releases (see release/build-*.sh). */
export const VERSION = process.env.RELAY_VERSION ?? "0.1.0";

export const RELAY_HOME = process.env.RELAY_HOME ?? join(homedir(), ".relay");

/**
 * A helper with its own RELAY_HOME (a UI-test server, a scheduled test run, a test daemon) is a test helper:
 * it never asks macOS for permissions, since nobody is there to answer and the answer would land on the real app.
 */
export function isTestHelper(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): boolean {
  const relayHome = env.RELAY_HOME;
  return relayHome !== undefined && resolve(relayHome) !== join(home, ".relay");
}

export const paths = {
  home: RELAY_HOME,
  db: join(RELAY_HOME, "relay.db"),
  hookSock: join(RELAY_HOME, "hook.sock"),
  config: join(RELAY_HOME, "config.json"),
  identity: join(RELAY_HOME, "identity.json"),
  log: join(RELAY_HOME, "daemon.log"),
  /** Photos and files from the phone (attachments): <session>/<id8>-<name>, and .partial/ while uploading. */
  attachments: join(RELAY_HOME, "attachments"),
} as const;

const ConfigSchema = z.object({
  /** TCP port for the app API. Bound to 127.0.0.1 only; exposed to the phone via `tailscale serve`. */
  port: z.number().int().min(1024).max(65535).default(7878),
  /** Absolute path of the real `claude` binary (the shell alias is not visible to launchd). */
  claudeBin: z.string().nullable().default(null),
  /** Public base URL the phone uses, e.g. https://my-mac.tailnet.ts.net (set by `relay doctor`/`pair`). */
  publicUrl: z.string().nullable().default(null),
  /** Cloudflare relay, e.g. wss://relay.example.workers.dev. When set, the phone pairs through it (no VPN). */
  relayUrl: z.string().url().nullable().default(null),
  /** Seconds without keyboard/mouse input after which you count as away (presence mode "auto"). */
  idleAwaySeconds: z.number().int().min(10).default(120),
  /** Characters of the final assistant message shown in a compact turn summary. */
  previewChars: z.number().int().min(100).max(4000).default(600),
  /** Prompts older than this are closed with resolvedBy "timeout". */
  promptTimeoutSeconds: z.number().int().min(60).default(86_400),
  /** Directories the manager agent may start sessions in (Phase 3). */
  projectRoots: z.array(z.string()).default([join(homedir(), "Projects")]),
  /**
   * Deliver free text as real typing (tmux, iTerm2, Terminal.app) when possible, so Claude sees an
   * ordinary prompt; otherwise the session inbox. Never types while you are typing at the Mac.
   */
  preferTyping: z.boolean().default(true),
  /** Start Zed's terminal through `relay shell`. `relay install --no-zed` turns it off, and updates keep that. */
  zed: z.boolean().default(true),
});
export type RelayConfig = z.infer<typeof ConfigSchema>;

export function ensureHome(): void {
  if (!existsSync(RELAY_HOME)) mkdirSync(RELAY_HOME, { recursive: true, mode: 0o700 });
  // The hook socket's only access control is this directory's permissions.
  if ((statSync(RELAY_HOME).mode & 0o077) !== 0) chmodSync(RELAY_HOME, 0o700);
}

export function loadConfig(): RelayConfig {
  ensureHome();
  let raw: unknown = {};
  if (existsSync(paths.config)) {
    try {
      raw = JSON.parse(readFileSync(paths.config, "utf8"));
    } catch (err) {
      throw new Error(`Invalid JSON in ${paths.config}: ${(err as Error).message}`);
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${paths.config}: ${parsed.error.message}`);
  return parsed.data;
}

export function saveConfig(patch: Partial<RelayConfig>): RelayConfig {
  const current = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : {};
  const next = ConfigSchema.parse({ ...current, ...patch });
  writeFileSync(paths.config, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/**
 * Finds the real `claude` executable on PATH, resolving symlinks. Shell aliases (like the user's
 * `claude --append-system-prompt-file …`) are deliberately ignored: daemon-spawned processes must not
 * depend on interactive shell configuration.
 */
export function resolveClaudeBin(config: RelayConfig): string | null {
  if (config.claudeBin && existsSync(config.claudeBin) && !config.claudeBin.includes("/versions/"))
    return config.claudeBin;
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    ...platform.extraPath,
    "/usr/local/bin",
  ];
  const found = (dir: string): string | null => {
    const candidate = join(dir, "claude");
    try {
      // Keep the symlink itself (e.g. ~/.local/bin/claude): it follows Claude Code updates, while the
      // resolved versions/<x.y.z> path goes stale. realpath only proves it isn't dangling.
      return existsSync(candidate) && realpathSync(candidate) ? candidate : null;
    } catch {
      return null; // dangling symlink; keep looking
    }
  };
  for (const dir of new Set(dirs.filter(Boolean))) {
    const hit = found(dir);
    if (hit) return hit;
  }
  // Only ask npm when nothing else worked: it takes a moment to start.
  for (const dir of npmGlobalBin()) {
    const hit = found(dir);
    if (hit) return hit;
  }
  return null;
}

/** Last resort: wherever `npm install -g` puts binaries (a custom prefix is common on Linux). */
function npmGlobalBin(): string[] {
  try {
    const res = Bun.spawnSync(["npm", "prefix", "-g"], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, PATH: CHILD_PATH },
    });
    const prefix = res.stdout.toString().trim();
    return res.exitCode === 0 && prefix ? [join(prefix, "bin")] : [];
  } catch {
    return []; // npm isn't installed
  }
}

/** PATH for child processes (tmux, git) when running under launchd's or systemd's minimal environment. */
export const CHILD_PATH = [...platform.extraPath, ...BASE_PATH].join(delimiter);

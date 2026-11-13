import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../log.ts";
import { cleanTypedText } from "../shell/typedText.ts";
import { type Runner, run } from "./exec.ts";
import { readKeyIdleSeconds } from "./keyIdle.ts";
import type {
  Platform,
  PresenceReading,
  ServiceContext,
  ServiceStatus,
  TabView,
  TypingRoute,
} from "./types.ts";

// ---------------------------------------------------------------------------------------------------
// Service: a launchd agent in ~/Library/LaunchAgents.
// ---------------------------------------------------------------------------------------------------

export const LAUNCHD_LABEL = "dev.relay.daemon";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

/** What the launchd code touches, swappable in tests. */
export interface LaunchdDeps {
  run: Runner;
  plistPath: string;
  uid: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultLaunchdDeps = (): LaunchdDeps => ({
  run,
  plistPath: PLIST_PATH,
  uid: process.getuid?.() ?? 501,
  sleep: (ms) => Bun.sleep(ms),
});

export function launchdPlist(ctx: ServiceContext): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(ctx.relayBin)}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(ctx.path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(ctx.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(ctx.logPath)}</string>
</dict>
</plist>
`;
}

export function launchdService(deps: LaunchdDeps): Platform["service"] {
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  return {
    async install(ctx) {
      mkdirSync(dirname(deps.plistPath), { recursive: true });
      writeFileSync(deps.plistPath, launchdPlist(ctx));
      await deps.run(["launchctl", "bootout", target]);
      // bootout returns before the old service is gone; bootstrapping too early fails with an I/O error.
      for (let i = 0; i < 40; i++) {
        if ((await deps.run(["launchctl", "print", target])).code !== 0) break;
        await deps.sleep(250);
      }
      let boot = { code: 1, out: "", err: "" };
      for (let attempt = 0; attempt < 5 && boot.code !== 0; attempt++) {
        if (attempt) await deps.sleep(500 * attempt);
        boot = await deps.run(["launchctl", "bootstrap", domain, deps.plistPath]);
      }
      if (boot.code !== 0) throw new Error(`launchctl bootstrap failed: ${boot.err || boot.out}`);
      return { state: "running", mode: "launchd", notes: [] };
    },

    /**
     * Stops the daemon and removes the login item. Without the plist, RunAtLoad would start the daemon again at
     * the next login, and phones paired with it would keep working.
     */
    async uninstall() {
      await deps.run(["launchctl", "bootout", target]);
      if (existsSync(deps.plistPath)) unlinkSync(deps.plistPath);
    },

    async restart() {
      await deps.run(["launchctl", "kickstart", "-k", target]);
    },

    async status(): Promise<ServiceStatus> {
      if (!existsSync(deps.plistPath)) return { state: "missing", mode: "launchd", notes: [] };
      const res = await deps.run(["launchctl", "print", target]);
      const running = res.code === 0 && /state = running/.test(res.out);
      return { state: running ? "running" : "stopped", mode: "launchd", notes: [] };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Presence: idle time and screen lock from the I/O Registry.
// ---------------------------------------------------------------------------------------------------

/** Seconds since the last keyboard or mouse event, from IOHIDSystem's HIDIdleTime (nanoseconds). */
export async function readIdleSeconds(): Promise<number> {
  const { out } = await run(["ioreg", "-c", "IOHIDSystem", "-d", "4"]);
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m?.[1] ? Number(m[1]) / 1e9 : 0;
}

export async function readLocked(): Promise<boolean> {
  const { out } = await run(["ioreg", "-n", "Root", "-d1"]);
  return /"IOConsoleLocked"\s*=\s*Yes/.test(out);
}

/**
 * A test helper (its own RELAY_HOME, never ~/.relay) may pin how long the Mac has been idle and say it isn't locked,
 * with RELAY_TEST_IDLE_SECONDS: an end-to-end run must not wait for the developer
 * typing at the Mac it runs on. The helper at ~/.relay ignores it.
 */
export function pinnedIdleSeconds(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): number | null {
  const relayHome = env.RELAY_HOME;
  const pinned = Number(env.RELAY_TEST_IDLE_SECONDS);
  if (!relayHome || relayHome === join(home, ".relay") || env.RELAY_TEST_IDLE_SECONDS === undefined)
    return null;
  return Number.isFinite(pinned) ? pinned : null;
}

async function readPresence(): Promise<PresenceReading> {
  const pinned = pinnedIdleSeconds();
  if (pinned !== null) return { idleSeconds: pinned, locked: false, source: "pinned for a test" };
  const [idleSeconds, locked] = await Promise.all([readIdleSeconds(), readLocked()]);
  return { idleSeconds, locked, source: "keyboard and mouse" };
}

// ---------------------------------------------------------------------------------------------------
// Typing into terminal apps.
// ---------------------------------------------------------------------------------------------------

/** Try the terminal the hook reported first; sessions found only by reconcile don't report one. */
export function terminalOrder(termProgram: string | null): TypingRoute[] {
  // Terminal.app's `do script` reports success but never reaches a program that is running in the tab
  // (verified with Claude Code 2.1.316), so Terminal sessions use the inbox.
  if (termProgram === "iTerm.app" || !termProgram) return ["iterm"];
  return []; // Terminal.app, VS Code, Warp, Ghostty…: no reliable typing route
}

/**
 * The text for `write text`: cleaned of control characters (shell/typedText.ts), so it can't press Enter, end the
 * paste or send keys, then wrapped in bracketed-paste markers when it has a newline or a tab, so they don't submit
 * the prompt early or press Tab.
 */
export function asTyped(text: string): string {
  const clean = cleanTypedText(text);
  return /[\n\t]/.test(clean) ? `\u001b[200~${clean}\u001b[201~` : clean;
}

/**
 * AppleScript, with the tty and text passed as arguments (never interpolated into the script). The
 * apps are addressed by bundle id and only if already running, so nothing gets launched. The first use
 * asks once for permission to control the app (System Settings › Privacy & Security › Automation).
 *
 * Typing no longer steps aside when you're in that tab: the caller waits for a pause in your typing instead
 * (inject.ts), and looks first with PEEK_SCRIPTS.
 */
const SCRIPTS: Record<TypingRoute, string> = {
  iterm: `on run argv
  set targetTty to item 1 of argv
  set msg to item 2 of argv
  if application id "com.googlecode.iterm2" is not running then return "no-app"
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            tell s to write text msg newline no
            delay 0.15
            tell s to write text ""
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`,
  terminal: `on run argv
  set targetTty to item 1 of argv
  set msg to item 2 of argv
  if application id "com.apple.Terminal" is not running then return "no-app"
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          do script msg in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`,
};

/**
 * Looks at one tab: "front" or "back" on the first line (whether it's the tab in front of you), then its visible
 * text. "no-app" or "not-found" when there's no such tab.
 */
export const PEEK_SCRIPTS: Record<TypingRoute, string> = {
  iterm: `on run argv
  set targetTty to item 1 of argv
  if application id "com.googlecode.iterm2" is not running then return "no-app"
  tell application id "com.googlecode.iterm2"
    set place to "back"
    if frontmost then
      try
        if tty of current session of current window is targetTty then set place to "front"
      end try
    end if
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            set screen to ""
            try
              set screen to contents of s
            end try
            return place & linefeed & screen
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`,
  terminal: `on run argv
  set targetTty to item 1 of argv
  if application id "com.apple.Terminal" is not running then return "no-app"
  tell application id "com.apple.Terminal"
    set place to "back"
    if frontmost then
      try
        if tty of selected tab of front window is targetTty then set place to "front"
      end try
    end if
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          set screen to ""
          try
            set screen to contents of t
          end try
          return place & linefeed & screen
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`,
};

/** Reads PEEK_SCRIPTS' answer. */
export function parsePeek(out: string): TabView | null {
  const nl = out.indexOf("\n");
  const place = nl === -1 ? out : out.slice(0, nl);
  if (place !== "front" && place !== "back") return null;
  return { front: place === "front", screen: nl === -1 ? null : out.slice(nl + 1) };
}

export async function peekTerminalApp(app: TypingRoute, tty: string): Promise<TabView | null> {
  const res = await run(["osascript", "-e", PEEK_SCRIPTS[app], tty], { timeoutMs: 10_000 });
  const view = parsePeek(res.out);
  if (!view)
    log.info("tab not found", {
      app,
      result: res.out.slice(0, 40) || null,
      error: res.err.slice(0, 200) || null,
    });
  return view;
}

export async function typeIntoTerminalApp(app: TypingRoute, tty: string, text: string): Promise<boolean> {
  const res = await run(["osascript", "-e", SCRIPTS[app], tty, asTyped(text)], { timeoutMs: 10_000 });
  if (res.out !== "ok")
    log.info("typing failed", { app, result: res.out || null, error: res.err.slice(0, 200) || null });
  return res.out === "ok";
}

/**
 * Esc for iTerm2: the ESC byte through `write text … newline no`, and none of the Enter that typing sends
 * after the text. Not skipped when you're in that tab: you asked for the stop on purpose, and Esc doesn't mix
 * into what you type. Terminal.app can't reach a running program at all (see terminalOrder).
 */
export const ITERM_ESCAPE_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  if application id "com.googlecode.iterm2" is not running then return "no-app"
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            tell s to write text (character id 27) newline no
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

/**
 * Enter alone, for when a typed message sat in the prompt unsent (inject.ts presses it once more): iTerm2's
 * `write text ""` is a bare Return, Terminal's `do script ""` too.
 */
export const ENTER_SCRIPTS: Record<TypingRoute, string> = {
  iterm: `on run argv
  set targetTty to item 1 of argv
  if application id "com.googlecode.iterm2" is not running then return "no-app"
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            tell s to write text ""
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`,
  terminal: `on run argv
  set targetTty to item 1 of argv
  if application id "com.apple.Terminal" is not running then return "no-app"
  tell application id "com.apple.Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          do script "" in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`,
};

export async function keyIntoTerminalApp(
  app: TypingRoute,
  tty: string,
  key: "escape" | "enter",
): Promise<boolean> {
  if (key === "escape" && app !== "iterm") return false;
  const script = key === "enter" ? ENTER_SCRIPTS[app] : ITERM_ESCAPE_SCRIPT;
  const res = await run(["osascript", "-e", script, tty], { timeoutMs: 10_000 });
  if (res.out !== "ok")
    log.info("key skipped", { app, key, result: res.out || null, error: res.err.slice(0, 200) || null });
  return res.out === "ok";
}

// ---------------------------------------------------------------------------------------------------

export const darwin: Platform = {
  name: "darwin",
  service: launchdService(defaultLaunchdDeps()),
  presence: { read: readPresence },
  typing: {
    routes: terminalOrder,
    peek: peekTerminalApp,
    type: typeIntoTerminalApp,
    key: keyIntoTerminalApp,
    keyIdleSeconds: readKeyIdleSeconds,
  },
  async computerName() {
    const res = await run(["scutil", "--get", "ComputerName"]);
    return res.code === 0 && res.out ? res.out : hostname().replace(/\.local$/, "");
  },
  // macOS kills ad-hoc signed binaries that were modified in place; re-sign the copies.
  async afterCopy(path) {
    await run(["codesign", "--force", "--sign", "-", path]);
  },
  extraPath: ["/opt/homebrew/bin"],
};

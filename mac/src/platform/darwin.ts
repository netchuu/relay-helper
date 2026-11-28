import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../log.ts";
import { cleanTypedText } from "../shell/typedText.ts";
import { type Runner, run } from "./exec.ts";
import { readInputIdleSeconds, readKeyIdleSeconds } from "./keyIdle.ts";
import type {
  Platform,
  PresenceReading,
  ServiceContext,
  ServiceStatus,
  TabView,
  TypingRoute,
} from "./types.ts";

// Service: a launchd agent in ~/Library/LaunchAgents.

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
  <key>AbandonProcessGroup</key><true/>
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

    /** Stops the daemon and removes the plist, or RunAtLoad would start it again at the next login. */
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

// Presence: idle time and screen lock from the I/O Registry.

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

/** RELAY_TEST_IDLE_SECONDS pins the idle time for a test helper (own RELAY_HOME); ~/.relay ignores it. */
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
  const [idleSeconds, locked] = await Promise.all([
    Promise.resolve(readInputIdleSeconds()).then((s) => s ?? readIdleSeconds()),
    readLocked(),
  ]);
  return { idleSeconds, locked, source: "keyboard and mouse" };
}

// Typing into terminal apps.

/** Try the terminal the hook reported first; sessions found only by reconcile don't report one. */
export function terminalOrder(termProgram: string | null): TypingRoute[] {
  // Terminal.app's `do script` reports success but never reaches a program running in the tab: use the inbox.
  if (termProgram === "iTerm.app" || !termProgram) return ["iterm"];
  return []; // Terminal.app, VS Code, Warp, Ghostty…: no reliable typing route
}

/** The text for `write text`: cleaned, and a bracketed paste when it has a newline or tab. */
export function asTyped(text: string): string {
  const clean = cleanTypedText(text);
  return /[\n\t]/.test(clean) ? `\u001b[200~${clean}\u001b[201~` : clean;
}

/** AppleScript with tty and text passed as arguments, never interpolated; only for apps already running. */
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
};

/** Looks at one tab: "front" or "back" on the first line, then its visible text; "no-app" or "not-found". */
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
};

/** Reads PEEK_SCRIPTS' answer. */
export function parsePeek(out: string): TabView | null {
  const nl = out.indexOf("\n");
  const place = nl === -1 ? out : out.slice(0, nl);
  if (place !== "front" && place !== "back") return null;
  return { front: place === "front", screen: nl === -1 ? null : out.slice(nl + 1) };
}

const automationDenied = new Set<TypingRoute>();

/** Apps macOS Automation has refused to `relay` since their last success. */
export function deniedAutomation(): TypingRoute[] {
  return [...automationDenied];
}

/** AppleScript error -1743: the person answered No to "relay wants to control <app>", or reset it. */
export function isAutomationDenial(err: string): boolean {
  return /-1743\b|not authorized to send apple events/i.test(err);
}

/** Remembers a denial (logged once, until the next success) or clears it. */
function noteAutomation(app: TypingRoute, err: string, succeeded: boolean): void {
  if (isAutomationDenial(err)) {
    if (!automationDenied.has(app))
      log.warn("automation denied", { app, hint: "System Settings > Privacy & Security > Automation" });
    automationDenied.add(app);
  } else if (succeeded) automationDenied.delete(app);
}

export async function peekTerminalApp(app: TypingRoute, tty: string): Promise<TabView | null> {
  const res = await run(["osascript", "-e", PEEK_SCRIPTS[app], tty], { timeoutMs: 10_000 });
  const view = parsePeek(res.out);
  noteAutomation(app, res.err, view !== null);
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
  noteAutomation(app, res.err, res.out === "ok");
  if (res.out !== "ok")
    log.info("typing failed", { app, result: res.out || null, error: res.err.slice(0, 200) || null });
  return res.out === "ok";
}

/** Esc for iTerm2: the ESC byte through `write text … newline no`, with no Enter after. */
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

/** Ctrl+S (Claude Code's stash key) for iTerm2: the byte through `write text … newline no`. */
export const ITERM_STASH_SCRIPT = ITERM_ESCAPE_SCRIPT.replace("character id 27", "character id 19");

/** Ctrl+C for iTerm2: Claude Code clears a prompt that has text in it. */
export const ITERM_CLEAR_SCRIPT = ITERM_ESCAPE_SCRIPT.replace("character id 27", "character id 3");

/** An arrow key for iTerm2: ESC and the rest of its sequence, with no Enter after. */
export const ITERM_ARROW_SCRIPTS = {
  up: ITERM_ESCAPE_SCRIPT.replace("(character id 27)", '((character id 27) & "[A")'),
  down: ITERM_ESCAPE_SCRIPT.replace("(character id 27)", '((character id 27) & "[B")'),
};

/** Enter alone, for a typed message that sat unsent: `write text ""` is a bare Return. */
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
};

export async function keyIntoTerminalApp(
  app: TypingRoute,
  tty: string,
  key: "escape" | "enter" | "stash" | "clear" | "up" | "down",
): Promise<boolean> {
  if (key !== "enter" && app !== "iterm") return false;
  const script =
    key === "enter"
      ? ENTER_SCRIPTS[app]
      : key === "stash"
        ? ITERM_STASH_SCRIPT
        : key === "clear"
          ? ITERM_CLEAR_SCRIPT
          : key === "up" || key === "down"
            ? ITERM_ARROW_SCRIPTS[key]
            : ITERM_ESCAPE_SCRIPT;
  const res = await run(["osascript", "-e", script, tty], { timeoutMs: 10_000 });
  noteAutomation(app, res.err, res.out === "ok");
  if (res.out !== "ok")
    log.info("key skipped", { app, key, result: res.out || null, error: res.err.slice(0, 200) || null });
  return res.out === "ok";
}

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

/**
 * Typing a phone reply into a Claude Code session in the Claude desktop app (Code tab), in the background,
 * through Accessibility. The app stays where it is: no activation and no
 * `claude://` link (links only switch sessions when the app comes forward).
 *
 * Steps: find the session's title in the app's own session files, press its row in the sidebar, check the
 * header shows it, make sure the composer is empty (a draft means the person is mid-message), put the text in,
 * press Send, check the composer emptied, then switch back to the session that was showing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHILD_PATH, isTestHelper, paths } from "../config.ts";
import { withoutIdeContext } from "../daemon/render.ts";
import { AxElement, requestTrust as axRequestTrust, trusted as axTrusted } from "../platform/ax.ts";

export const DESKTOP_BUNDLE_ID = "com.anthropic.claudefordesktop";
const SESSIONS_DIR = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

export type DesktopResult =
  | "sent"
  /** Accessibility isn't allowed for relay. */
  | "no-permission"
  | "not-running"
  /** The app doesn't know this session (not a desktop session, or archived). */
  | "not-found"
  /** More than one sidebar row has this title, or none is visible. */
  | "ambiguous"
  /** The composer had text in it: never overwritten. */
  | "draft"
  /** The window shows no content: the screen is locked (macOS hides it then). */
  | "locked"
  | "failed";

interface DesktopSession {
  cliSessionId: string;
  title: string;
  isArchived: boolean;
}

/** The desktop app's Code sessions, from its own files (`local_*.json`, two folders down). */
export function desktopSessions(dir = SESSIONS_DIR): DesktopSession[] {
  const out: DesktopSession[] = [];
  const list = (d: string) => {
    try {
      return readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const a of list(dir)) {
    if (!a.isDirectory()) continue;
    for (const b of list(join(dir, a.name))) {
      if (!b.isDirectory()) continue;
      for (const f of list(join(dir, a.name, b.name))) {
        if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
        try {
          const d = JSON.parse(readFileSync(join(dir, a.name, b.name, f.name), "utf8"));
          if (typeof d.cliSessionId === "string" && typeof d.title === "string")
            out.push({ cliSessionId: d.cliSessionId, title: d.title, isArchived: d.isArchived === true });
        } catch {
          // A file the app is writing right now: skip it this time.
        }
      }
    }
  }
  return out;
}

let cache: { at: number; sessions: DesktopSession[] } | null = null;

/** desktopSessions(), read again at most every 10 s (session lists are published often). */
function cachedSessions(): DesktopSession[] {
  if (!cache || Date.now() - cache.at > 10_000) cache = { at: Date.now(), sessions: desktopSessions() };
  return cache.sessions;
}

/** The title the desktop app shows for this Claude Code session, or null when it isn't a desktop session. */
export function desktopTitle(sessionId: string, sessions = cachedSessions()): string | null {
  const s = sessions.find((x) => x.cliSessionId === sessionId && !x.isArchived);
  return s ? s.title : null;
}

let allowed: { at: number; value: boolean } | null = null;

/** Accessibility allowed for this process; checked again at most every 10 s. macOS only. */
export function axAllowed(): boolean {
  if (process.platform !== "darwin") return false;
  if (!allowed || Date.now() - allowed.at > 10_000) {
    let value = false;
    try {
      value = axTrusted();
    } catch {
      value = false;
    }
    allowed = { at: Date.now(), value };
  }
  return allowed.value;
}

/** An editor the Claude Code extension runs in (kept here to avoid an import cycle with ideExtension.ts). */
function ideEditorInstalled(): boolean {
  return [
    "/Applications/Visual Studio Code.app",
    "/Applications/Visual Studio Code - Insiders.app",
    "/Applications/Cursor.app",
    "/Applications/Windsurf.app",
    "/Applications/Devin.app", // Windsurf, renamed; still com.exafunction.windsurf
    "/Applications/Antigravity IDE.app",
    "/Applications/VSCodium.app",
  ].some((p) => existsSync(p));
}

/** The Claude desktop app is installed (system-wide or for this user). */
export function desktopInstalled(home = homedir()): boolean {
  return existsSync("/Applications/Claude.app") || existsSync(join(home, "Applications", "Claude.app"));
}

/** How often Relay may ask again after the person said no (or ignored the dialog). */
export const ASK_AGAIN_MS = 24 * 3_600_000;

/** Ask when never asked, when forced, or when the last ask was at least ASK_AGAIN_MS ago. */
export function shouldAsk(lastAskedAt: number | null, now: number, force: boolean): boolean {
  return force || lastAskedAt === null || now - lastAskedAt >= ASK_AGAIN_MS;
}

/** Where the time of the last ask is kept (the daemon's settings table); set once at startup. */
let askStore: { get(): number | null; set(at: number): void } | null = null;

export function setAccessibilityAskStore(store: { get(): number | null; set(at: number): void }): void {
  askStore = store;
}

/**
 * Asks macOS for Accessibility the system way (its own dialog with a button to System Settings, relay already
 * listed there), when the Claude desktop app is installed and relay isn't allowed. Runs in the service, since
 * the permission belongs to the process that uses it.
 *
 * Not nagging: without `force`, at most once every ASK_AGAIN_MS. The service asks when it starts and when a
 * phone reply to a desktop session finds the permission missing; `relay install`/`relay pair` force it, since
 * the person is at the terminal on purpose then.
 */
export function askForAccessibility(
  opts: { force?: boolean; now?: number } = {},
): "allowed" | "asked" | "skipped" {
  // A test helper (its own RELAY_HOME) never asks: nobody is there to answer.
  if (isTestHelper()) return "skipped";
  if (process.platform !== "darwin" || !(desktopInstalled() || ideEditorInstalled())) return "skipped";
  if (axAllowed()) return "allowed";
  const now = opts.now ?? Date.now();
  if (!shouldAsk(askStore?.get() ?? null, now, opts.force === true)) return "skipped";
  askStore?.set(now);
  try {
    const value = axRequestTrust();
    allowed = { at: Date.now(), value };
    return value ? "allowed" : "asked";
  } catch {
    return "skipped";
  }
}

/** A Claude desktop session whose replies could be typed in, if only relay had Accessibility. */
export function desktopSessionWithoutPermission(sessionId: string): boolean {
  return process.platform === "darwin" && desktopTitle(sessionId) !== null && !axAllowed();
}

/** True when replies to this session can be typed into the desktop app (macOS, a desktop session, allowed). */
export async function desktopReady(sessionId: string): Promise<boolean> {
  return process.platform === "darwin" && desktopTitle(sessionId) !== null && axAllowed();
}

async function desktopPid(): Promise<number | null> {
  const proc = Bun.spawn(["lsappinfo", "info", "-only", "pid", "-app", DESKTOP_BUNDLE_ID], {
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const m = /"pid"=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

const HEADER_SUFFIX = ", rename session";
/** RELAY_AX_DEBUG=1 prints each step to stderr, for diagnosing a delivery by hand. */
const trace = (...a: unknown[]) => {
  if (process.env.RELAY_AX_DEBUG === "1") console.error("[desktop]", ...a);
};
/** Returns `result`, noting where it came from when tracing. */
const fail = (result: DesktopResult, where: string = result): DesktopResult => {
  trace(where);
  return result;
};
const sleep = (ms: number) => Bun.sleep(ms);

/** Types `text` into the desktop session `sessionId` and sends it. Never throws. */
/** Text as Claude Code records it: without the IDE extension's context blocks, \n line breaks, trimmed. */
export function promptText(text: string): string {
  return withoutIdeContext(text.replace(/\r\n?/g, "\n")).trim();
}

/** The text of a user message's content (a string, or text parts joined). */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((x) => ((x as { type?: string }).type === "text" ? ((x as { text?: string }).text ?? "") : ""))
      .join("\n");
  return "";
}

/**
 * The prompt a transcript line records, or null: a user message (not a tool result), or one Claude Code queued
 * because it was busy (`queue-operation` enqueue, or the `queued_command` attachment it becomes).
 */
function recordedPrompt(line: string): { text: string; at: number } | null {
  if (
    !line.includes('"type":"user"') &&
    !line.includes('"queue-operation"') &&
    !line.includes('"queued_command"')
  )
    return null;
  let e: {
    type?: string;
    operation?: string;
    content?: unknown;
    timestamp?: string;
    message?: { content?: unknown };
    attachment?: { type?: string; prompt?: unknown };
  };
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  const at = Date.parse(e.timestamp ?? "");
  if (e.type === "user") {
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((x) => (x as { type?: string }).type === "tool_result")) return null;
    return { text: contentText(c), at };
  }
  if (e.type === "queue-operation" && e.operation === "enqueue") return { text: contentText(e.content), at };
  if (e.attachment?.type === "queued_command") return { text: contentText(e.attachment.prompt), at };
  return null;
}

async function transcriptTail(path: string, bytes: number): Promise<string> {
  const file = Bun.file(path);
  return await file.slice(Math.max(0, file.size - bytes), file.size).text();
}

/**
 * True once the session's transcript records this prompt, written after `since`: as a user message, or queued
 * while Claude is busy (a queued prompt only becomes a user message when Claude gets to it, maybe minutes later).
 */
export async function waitForPrompt(
  path: string,
  text: string,
  since: number,
  timeoutMs = 6000,
): Promise<boolean> {
  const want = promptText(text);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      for (const line of (await transcriptTail(path, 256 * 1024)).split("\n").reverse()) {
        const p = recordedPrompt(line);
        if (!p) continue;
        if (Number.isFinite(p.at) && p.at < since - 2000) break;
        if (promptText(p.text) === want) return true;
      }
    } catch {
      // Not written yet.
    }
    await Bun.sleep(200);
  }
  return false;
}

/** The texts of the session's recent prompts in its transcript (newest first, as promptText). */
export async function recentUserMessages(path: string | null, limit = 50): Promise<string[]> {
  if (!path) return [];
  const out: string[] = [];
  try {
    for (const line of (await transcriptTail(path, 512 * 1024)).split("\n").reverse()) {
      if (out.length >= limit) break;
      const p = recordedPrompt(line);
      const text = p ? promptText(p.text) : "";
      if (text) out.push(text);
    }
  } catch {
    // no transcript yet
  }
  return out;
}

/** The text of the session's last user message in its transcript, or null. */
export async function lastUserMessage(path: string | null): Promise<string | null> {
  return (await recentUserMessages(path, 1))[0] ?? null;
}

const TYPED_FILE = () => join(paths.home, "typed.json");

/**
 * What Relay itself typed into each session lately (kept on disk, so a helper restart remembers). The app's
 * Accessibility tree goes stale in the background and keeps showing the sent text; only text Relay typed can be
 * that. Anything else in the composer is the person's draft, even if it equals an earlier message ("yes").
 */
export function rememberTyped(sessionId: string, text: string): void {
  try {
    const all = readTyped();
    all[sessionId] = [
      promptText(text),
      ...(all[sessionId] ?? []).filter((t) => t !== promptText(text)),
    ].slice(0, 10);
    mkdirSync(paths.home, { recursive: true });
    const tmp = `${TYPED_FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, TYPED_FILE());
  } catch {
    // only affects recognising stale text
  }
}

export function typedByRelay(sessionId: string, text: string): boolean {
  return (readTyped()[sessionId] ?? []).includes(promptText(text));
}

function readTyped(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(TYPED_FILE(), "utf8"));
  } catch {
    return {};
  }
}

/** What sendToDesktop uses from the outside world; tests pass fakes. */
export interface DesktopDeps {
  /** The app's Accessibility root (AxElement.app). */
  app(pid: number): AxElement;
  allowed(): boolean;
  sessions(): DesktopSession[];
  pid(): Promise<number | null>;
  typed: { has(sessionId: string, text: string): boolean; remember(sessionId: string, text: string): void };
}

const realDeps: DesktopDeps = {
  app: (pid) => AxElement.app(pid),
  allowed: () => axAllowed(),
  sessions: () => cachedSessions(),
  pid: () => desktopPid(),
  typed: { has: (id, t) => typedByRelay(id, t), remember: (id, t) => rememberTyped(id, t) },
};

export async function sendToDesktop(
  sessionId: string,
  text: string,
  /** The session's transcript, to confirm the message went out. */
  transcript: string | null,
  deps: DesktopDeps = realDeps,
): Promise<DesktopResult> {
  if (process.platform !== "darwin") return fail("not-running");
  const title = desktopTitle(sessionId, deps.sessions());
  if (!title) return fail("not-found");
  if (!deps.allowed()) return fail("no-permission");
  const pid = await deps.pid();
  if (!pid) return fail("not-running");

  const app = deps.app(pid);
  try {
    // Chromium only exposes web content once asked, and needs a moment to build the tree.
    app.setBool("AXManualAccessibility", true);
    // The app reports no AXWindows; its window is reachable as the main or focused window.
    let window = null;
    for (let i = 0; i < 20 && !window; i++) {
      window =
        [app.element("AXMainWindow"), app.element("AXFocusedWindow"), ...app.elements("AXWindows")].find(
          (w) => w !== null && w.string("AXTitle") === "Claude",
        ) ?? null;
      if (!window) await sleep(150);
    }
    if (!window) return fail("failed");

    const buttons = () => window.findAll((e) => e.role === "AXButton");
    const current = () =>
      buttons()
        .map((b) => b.label)
        .find((l) => l.endsWith(HEADER_SUFFIX))
        ?.slice(0, -HEADER_SUFFIX.length) ?? null;
    const composer = () => window.findAll((e) => e.role === "AXTextArea")[0] ?? null;

    let before = current();
    if (before === null && !composer()) {
      // Settle once more: a cold tree can be empty for a moment. Still nothing means the screen is locked.
      await sleep(500);
      before = current();
      if (before === null && !composer()) return fail("locked");
    }

    const open = async (t: string) => {
      const rows = buttons().filter((b) => b.label === t);
      if (rows.length !== 1) return false;
      rows[0]?.press();
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        if (current() === t) return true;
      }
      return false;
    };

    // Exactly one row with this title, even when it's already on screen: two sessions can share a title.
    if (buttons().filter((b) => b.label === title).length !== 1) return fail("ambiguous");
    if (before !== title && !(await open(title))) return fail("ambiguous");
    const restore = async () => {
      if (before && before !== title) await open(before);
    };

    const box = composer();
    if (!box) {
      await restore();
      return fail("failed");
    }
    // Text Relay typed itself shows on in a stale tree; anything else is the person's draft and stays.
    const existing = box.string("AXValue").trim();
    if (existing !== "" && !deps.typed.has(sessionId, existing)) {
      await restore();
      return fail("draft");
    }

    window.setBool("AXMain", true);
    box.setBool("AXFocused", true);
    let typed = false;
    for (let i = 0; i < 20 && !typed; i++) {
      if (box.string("AXValue") === text) typed = true;
      else {
        box.setString("AXValue", text);
        await sleep(200);
      }
    }
    const clear = async () => {
      // An empty string alone doesn't clear it; a space first does.
      box.setString("AXValue", " ");
      await sleep(200);
      box.setString("AXValue", "");
    };
    if (!typed) {
      await clear();
      await restore();
      return fail("failed");
    }

    let send = null;
    for (let i = 0; i < 15 && !send; i++) {
      send = buttons().find((b) => b.label === "Send") ?? null;
      if (!send) await sleep(150);
    }
    const started = Date.now();
    if (!send?.press()) {
      await clear();
      await restore();
      return fail("failed");
    }
    // Confirmed only by Claude Code itself: the composer can't be trusted in the background (stale tree).
    const confirmed = transcript ? await waitForPrompt(transcript, text, started) : true;
    if (confirmed) deps.typed.remember(sessionId, text);
    else await clear();
    await restore();
    return confirmed ? "sent" : fail("failed", "failed at confirm");
  } catch {
    return fail("failed");
  } finally {
    app.release();
  }
}

/**
 * Typing a phone reply into a Claude Code session in the IDE extension (VS Code, Cursor, Windsurf, Antigravity
 * IDE), in the background. The extension's composer is a rich editor two
 * frames deep in a webview and ignores text set through Accessibility, so Relay focuses it through Accessibility
 * and then sends real keystrokes to that app's process (CGEventPostToPid): the app stays where it is.
 *
 * Steps: the session's last answer (from its transcript) picks the Claude Code tab showing it; the composer must
 * be empty (Send disabled; otherwise the person is mid-message); focus it, type, press Return, and confirm by the
 * transcript.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { CHILD_PATH } from "../config.ts";
import { type AxElement as Ax, AxElement, typeToPid } from "../platform/ax.ts";
import { axAllowed, rememberTyped, typedByRelay, waitForPrompt } from "./claudeDesktop.ts";

/** Editors the Claude Code extension runs in. */
export const IDE_BUNDLE_IDS = [
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.todesktop.230313mzl4w4u92", // Cursor
  "com.exafunction.windsurf", // Windsurf, and Devin (its new name)
  "com.google.antigravity-ide",
  "com.vscodium",
];

export type IdeResult =
  | "sent"
  | "no-permission"
  /** No running editor shows a Claude Code tab with this session. */
  | "not-found"
  /** More than one tab could be this session. */
  | "ambiguous"
  /** The composer has text in it (Send is enabled): never touched. */
  | "draft"
  /** The editor is in front and in use: typing now would mix into the person's typing. */
  | "busy"
  /** No editor content is visible: the screen is locked. */
  | "locked"
  | "failed";

const trace = (...a: unknown[]) => {
  if (process.env.RELAY_AX_DEBUG === "1") console.error("[ide]", ...a);
};

const ideCache = new Map<string, { size: number; value: boolean }>();

/**
 * isIdeSession, synchronously: where the session ran last, from the newest `entrypoint` in its transcript (a
 * session started in the editor can be resumed in a terminal, and the other way round). Cached by file size.
 */
export function isIdeSessionSync(transcript: string | null): boolean {
  if (!transcript) return false;
  try {
    const size = statSync(transcript).size;
    const known = ideCache.get(transcript);
    if (known && known.size === size) return known.value;
    const fd = openSync(transcript, "r");
    let value = false;
    try {
      const length = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, size - length);
      const tail = buf.toString("utf8", 0, n);
      const all = [...tail.matchAll(/^\{[^\n]*?"entrypoint":"([a-z-]+)"/gm)];
      value = all.length > 0 && all[all.length - 1]?.[1] === "claude-vscode";
    } finally {
      closeSync(fd);
    }
    ideCache.set(transcript, { size, value });
    return value;
  } catch {
    return false;
  }
}

/** An IDE editor the Claude Code extension runs in is installed. */
export function ideInstalled(): boolean {
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

/** True when the transcript says this session runs in the IDE extension (where it ran last). */
export async function isIdeSession(transcript: string | null): Promise<boolean> {
  return isIdeSessionSync(transcript);
}

/**
 * The starts of the session's recent answers, one line each, newest first: what its Claude Code tab shows. Several,
 * because the tab's Accessibility tree goes stale in the background and may still show an older answer.
 */
export async function recentAnswerSnippets(transcript: string | null, limit = 10): Promise<string[]> {
  if (!transcript) return [];
  const out: string[] = [];
  try {
    const file = Bun.file(transcript);
    const tail = await file.slice(Math.max(0, file.size - 512 * 1024), file.size).text();
    for (const line of tail.split("\n").reverse()) {
      if (out.length >= limit) break;
      if (!line.includes('"type":"assistant"')) continue;
      try {
        const c = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
        const text = Array.isArray(c)
          ? c
              .map((x) =>
                (x as { type?: string }).type === "text" ? ((x as { text?: string }).text ?? "") : "",
              )
              .join("")
          : typeof c === "string"
            ? c
            : "";
        const first = text.trim().split("\n")[0]?.trim() ?? "";
        // Very short answers ("Done.") could be in any tab; they don't identify one.
        if (first.length >= 8 && !out.includes(first.slice(0, 60))) out.push(first.slice(0, 60));
      } catch {
        // a line still being written
      }
    }
  } catch {
    // no transcript
  }
  return out;
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", env: { PATH: CHILD_PATH } });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function pidOf(bundleId: string): Promise<number | null> {
  const m = /"pid"=(\d+)/.exec(await run(["lsappinfo", "info", "-only", "pid", "-app", bundleId]));
  return m ? Number(m[1]) : null;
}

/** The bundle id of the app in front. */
async function frontBundleId(): Promise<string | null> {
  const asn = (await run(["lsappinfo", "front"])).trim();
  if (!asn) return null;
  const m = /"CFBundleIdentifier"="([^"]+)"/.exec(await run(["lsappinfo", "info", "-only", "bundleid", asn]));
  return m ? (m[1] ?? null) : null;
}

const isButton = (label: string) => (e: Ax) => e.role === "AXButton" && e.label === label;
const isComposer = (e: Ax) =>
  (e.role === "AXTextArea" || e.role === "AXTextField") && e.label === "Message input";

/** Claude Code tabs in a window: the innermost web areas with Claude's own controls and a composer. */
function claudeTabs(window: Ax): Ax[] {
  const areas = window.findAll((e) => e.role === "AXWebArea", 90);
  const claude = areas.filter(
    (a) =>
      a.findAll(isButton("Show command menu (/)"), 90).length > 0 && a.findAll(isComposer, 90).length > 0,
  );
  // A tab is nested web areas; keep the innermost ones (no other Claude web area inside them).
  return claude.filter(
    (a) => !claude.some((b) => !b.equals(a) && a.findAll((e) => e.equals(b), 90).length > 0),
  );
}

/**
 * Types `text` into the Claude Code tab showing session `sessionId` and sends it. `userActive` is the
 * person's recent typing (idle under a few seconds). Never throws.
 */
export async function sendToIde(
  sessionId: string,
  text: string,
  transcript: string | null,
  userActive: boolean,
): Promise<IdeResult> {
  if (process.platform !== "darwin") return "not-found";
  if (!axAllowed()) return "no-permission";
  const snippets = await recentAnswerSnippets(transcript);
  if (snippets.length === 0) return "not-found";

  const roots: Ax[] = [];
  try {
    type Match = { pid: number; bundleId: string; window: Ax; tab: Ax };
    const matches: Match[] = [];
    let sawContent = false;
    for (const bundleId of IDE_BUNDLE_IDS) {
      const pid = await pidOf(bundleId);
      if (!pid) continue;
      const app = AxElement.app(pid);
      roots.push(app);
      app.setBool("AXManualAccessibility", true);
      await Bun.sleep(300);
      const windows = [
        app.element("AXMainWindow"),
        app.element("AXFocusedWindow"),
        ...app.elements("AXWindows"),
      ].filter((w): w is Ax => w !== null);
      const seen: Ax[] = [];
      for (const window of windows) {
        if (seen.some((s) => s.equals(window))) continue;
        seen.push(window);
        for (const tab of claudeTabs(window)) {
          sawContent = true;
          const texts = tab.findAll((e) => e.role === "AXStaticText", 90).map((t) => t.string("AXValue"));
          if (snippets.some((sn) => texts.some((t) => t.includes(sn))))
            matches.push({ pid, bundleId, window, tab });
        }
      }
    }
    trace("matches", matches.length, "snippets", snippets.length);
    if (matches.length === 0) return sawContent ? "not-found" : "locked";
    if (matches.length > 1) return "ambiguous";
    const { pid, bundleId, window, tab } = matches[0] as Match;

    if (userActive && (await frontBundleId()) === bundleId) return "busy";
    const send = tab.findAll(isButton("Send message"), 90)[0];
    const box = tab.findAll(isComposer, 90)[0];
    if (!send || !box) {
      trace("no send button or composer", Boolean(send), Boolean(box));
      return "failed";
    }
    // Send is enabled only while the editor holds text: the person's draft, unless it's text Relay typed itself
    // that a stale tree still shows.
    if (send.bool("AXEnabled") && !typedByRelay(sessionId, box.string("AXValue"))) return "draft";

    // The editor takes a moment to accept focus from the background: ask again for up to a second.
    window.setBool("AXMain", true);
    let focused = false;
    for (let i = 0; i < 7 && !focused; i++) {
      box.setBool("AXFocused", true);
      await Bun.sleep(150);
      focused = box.bool("AXFocused");
    }
    if (!focused) {
      trace("composer didn't take focus");
      return "failed";
    }
    const started = Date.now();
    await typeToPid(pid, text, { submit: true });
    const sent = transcript ? await waitForPrompt(transcript, text, started) : false;
    if (sent) rememberTyped(sessionId, text);
    trace("confirmed", sent);
    return sent ? "sent" : "failed";
  } catch (err) {
    trace("error", err);
    return "failed";
  } finally {
    for (const r of roots) r.release();
  }
}

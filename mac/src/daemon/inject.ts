import { connect } from "node:net";
import { CHILD_PATH } from "../config.ts";
import {
  askForAccessibility,
  axAllowed,
  desktopReady,
  desktopSessionWithoutPermission,
  sendToDesktop,
} from "../integrations/claudeDesktop.ts";
import { isIdeSessionSync, sendToIde } from "../integrations/ideExtension.ts";
import { log } from "../log.ts";
import { claudeInFront } from "../platform/foreground.ts";
import { platform } from "../platform/index.ts";
import type { TabView, TypingRoute } from "../platform/types.ts";
import type { TypeReply, TypeRequest } from "../shell/ptyShell.ts";
import { cleanTypedText } from "../shell/typedText.ts";
import { afterBreak, promptDraft } from "./promptLine.ts";
import type { SessionRecord } from "./registry.ts";
import { transcriptPathFor } from "./transcript.ts";

export type DeliveryRoute = "pty" | "tmux" | "iterm" | "terminal" | "desktop" | "ide" | "socket";

export interface DeliveryResult {
  via: DeliveryRoute;
  /**
   * False when the message was typed into a terminal but never submitted: it still sits in the prompt after Enter
   * was pressed twice. Absent when it went through or couldn't be checked.
   */
  submitted?: false;
}

export class DeliveryError extends Error {}

/**
 * The session is in the Claude desktop app, Relay may type there, and the Mac is locked: macOS hides the app's
 * contents then. The reply waits for the unlock (`session.send` answers `via: "queued"`).
 */
export class WaitForUnlock extends Error {}

/**
 * The session has a terminal Relay types into, and typing now could mix into what the person at the Mac is typing
 * there, or into a draft in the prompt line. The message waits for a pause and is typed then, never sent through
 * the inbox instead (`session.send` waits a little, then answers `via: "queued"` and the reply queue types it).
 */
export class WaitForPause extends Error {
  constructor(
    /** The terminal it waits to be typed into; null when it waits for something else (an open prompt). */
    readonly route: TerminalRoute | null,
    readonly reason: "typing" | "draft" | "prompt",
  ) {
    super(`waiting to type into ${route ?? "the session"}: ${reason}`);
  }
}

/** Terminals Relay types into, as opposed to the desktop app, the editor extension and the inbox. */
export type TerminalRoute = "pty" | "tmux" | TypingRoute;

/** The keyboard has to be still this long before Relay types into a tab you are in front of. */
export const PAUSE_SECONDS = 3;

/** A message that has waited this long for a pause is typed anyway (after a clean break from a draft). */
export const TYPE_ANYWAY_MS = 120_000;

/** Honest provenance line; Claude Code itself frames socket messages as coming from a peer session. */
export const PHONE_PREFIX = "📱 From the user, sent from their phone via Relay:";

export interface DeliverOptions {
  /** Seconds since the last keyboard or mouse input at the Mac (a fresh reading); null when unknown. */
  idleSeconds: number | null;
  /** The editor extension's own rule (active in the last 8 s): it steps aside then, to the inbox. */
  userTypingNow: boolean;
  preferTyping: boolean;
  locked?: boolean;
  /** It waited TYPE_ANYWAY_MS for a pause: type it now, after a clean break when the prompt holds a draft. */
  typeAnyway?: boolean;
  /**
   * Whether the message's UserPromptSubmit hook has arrived (the prompt was submitted). Given, a message typed into a
   * terminal is checked: no hook within `submitWaitMs` and the text still in the prompt, Enter is pressed once more.
   */
  submitted?: () => boolean;
  /** How long to wait for the hook before pressing Enter again (SUBMIT_WAIT_MS). */
  submitWaitMs?: number;
}

/** Claude Code needs this long after an Esc before it takes keys as a new message (it is still handling the interrupt). */
export const ESC_SETTLE_MS = 1500;

/** A typed message whose prompt hook hasn't arrived by now is checked, and gets Enter once more. */
export const SUBMIT_WAIT_MS = 4000;

/** When Relay last pressed Esc in a session's terminal (pressEscape). */
const lastEscape = new Map<string, number>();

/** How `deliver` reaches terminals; tests swap them. */
export interface TypeOps {
  pty(socketPath: string, token: string, pid: number, text: string, force: boolean): Promise<TypeReply>;
  /** The pane's visible text; null when the pane can't be read (it's gone). */
  tmuxScreen(socket: string, pane: string): Promise<string | null>;
  tmux(socket: string, pane: string, text: string): Promise<void>;
  routes(termProgram: string | null): TypingRoute[];
  ttyOf(pid: number | null): Promise<string | null>;
  /**
   * The tty of the terminal tab a session is shown in when Claude Code runs it in a background host (`--bg-pty-host`,
   * after a resume): the process then has a pseudo-terminal of its own, which no tab has. Null when it isn't hosted
   * or the tab can't be told for certain.
   */
  viewerTtyOf?(pid: number, cwd: string): Promise<string | null>;
  peek(route: TypingRoute, tty: string): Promise<TabView | null>;
  type(route: TypingRoute, tty: string, text: string): Promise<boolean>;
  /**
   * Whether the Claude Code process `pid` is the program in front of its terminal (`tty` null: tmux) or of the tab
   * on `tty` (platform/foreground.ts). Relay types into tmux and terminal apps only then: otherwise the keys would
   * go to a shell (Claude suspended or exited) or another program. `relay shell` checks this itself.
   */
  inFront(pid: number, tty: string | null): Promise<boolean>;
  /** Enter alone, for a message that sat typed and unsent. Absent: no check is made. */
  enterPty?(socketPath: string, token: string, pid: number): Promise<TypeReply>;
  tmuxEnter?(socket: string, pane: string): Promise<void>;
  enter?(route: TypingRoute, tty: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
}

export const defaultTypeOps: TypeOps = {
  pty: (socketPath, token, pid, text, force) => typeIntoPty(socketPath, token, pid, text, { force }),
  tmuxScreen,
  tmux: tmuxType,
  routes: (t) => platform.typing.routes(t),
  ttyOf: (pid) => ttyOf(pid),
  viewerTtyOf: (pid, cwd) => viewerTtyOf(pid, cwd),
  peek: (route, tty) => platform.typing.peek(route, tty),
  type: (route, tty, text) => platform.typing.type(route, tty, text),
  inFront: claudeInFront,
  enterPty: (socketPath, token, pid) => requestPty(socketPath, { token, pid, key: "enter" }),
  tmuxEnter,
  enter: (route, tty) => platform.typing.key(route, tty, "enter"),
  sleep: (ms) => Bun.sleep(ms),
};

/**
 * Delivers free text from the phone into a session, preferring real keyboard input:
 *
 * 1. The session's own terminal, so Claude Code sees an ordinary prompt (no "another session" label, pasted image
 *    paths become images) and the history is exactly as if you typed it: `relay shell` (Zed's terminal) through its
 *    pseudo-terminal, tmux, then iTerm2. When typing now could mix into what you're typing there (you're in front of
 *    that tab and used the keyboard in the last PAUSE_SECONDS; for tmux, any input, as it can't tell which pane you
 *    look at), or into a draft in the prompt line, it throws WaitForPause: the message waits and is typed later,
 *    never sent through the inbox instead. `relay shell` makes the same check itself, per tab. Relay types only
 *    while Claude Code is the program in front of that terminal; when it isn't (suspended with Ctrl-Z, exited,
 *    another program in front), the message goes on to the next route, so keys never reach a shell.
 * 2. The Claude desktop app (Code tab), when Accessibility is allowed: typed in and sent in the
 *    background (integrations/claudeDesktop.ts). While the Mac is locked it can't be, so the reply waits.
 * 3. Otherwise the inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`): works for IDE panels, the desktop app
 *    and background sessions. Claude Code labels it as a message from another session.
 *
 * The text is cleaned first (shell/typedText.ts): no control characters reach any route, only text, newlines and
 * tabs; Relay presses Enter itself.
 */
export async function deliver(
  session: SessionRecord,
  raw: string,
  opts: DeliverOptions,
  ops: TypeOps = defaultTypeOps,
): Promise<DeliveryResult> {
  const text = cleanTypedText(raw);
  if (opts.preferTyping) {
    await settleAfterEscape(session.id, ops);
    const typed = await typeIntoTerminal(session, text, opts, ops);
    if (typed) {
      const submitted = await confirmSubmitted(session, text, typed, opts, ops);
      return submitted === false ? { via: typed, submitted } : { via: typed };
    }
    if (desktopSessionWithoutPermission(session.id)) {
      const asked = askForAccessibility();
      if (asked !== "skipped") log.info("accessibility", { result: asked, for: session.id });
    }
    if (await desktopReady(session.id)) {
      if (opts.locked) throw new WaitForUnlock("the Mac is locked");
      const result = await sendToDesktop(session.id, text, transcriptPathFor(session));
      log.info("desktop route", { sessionId: session.id, result });
      if (result === "sent") return { via: "desktop" };
      if (result === "locked") throw new WaitForUnlock("the Mac is locked");
      // A draft in the composer, no unique sidebar row, or anything unexpected: the inbox, below.
    }
    const transcript = transcriptPathFor(session);
    if (process.platform === "darwin" && isIdeSessionSync(transcript)) {
      if (!axAllowed()) {
        const asked = askForAccessibility();
        if (asked !== "skipped") log.info("accessibility", { result: asked, for: session.id });
      } else {
        if (opts.locked) throw new WaitForUnlock("the Mac is locked");
        const result = await sendToIde(session.id, text, transcript, opts.userTypingNow);
        log.info("ide route", { sessionId: session.id, result });
        if (result === "sent") return { via: "ide" };
        if (result === "locked") throw new WaitForUnlock("the Mac is locked");
        // Someone's draft, the editor in use, the tab not open, or anything unexpected: the inbox, below.
      }
    }
  }
  if (!session.socketPath) throw new DeliveryError("this session has no inbox socket Relay can reach");
  await postToInbox(session.socketPath, session.socketToken, `${PHONE_PREFIX}\n${text}`);
  return { via: "socket" };
}

/** A message sent right after a Stop waits until Claude Code is done with the Esc: keys typed into it meanwhile get lost. */
async function settleAfterEscape(sessionId: string, ops: TypeOps): Promise<void> {
  const at = lastEscape.get(sessionId);
  if (at === undefined) return;
  const wait = ESC_SETTLE_MS - (Date.now() - at);
  if (wait > 0) await (ops.sleep ?? Bun.sleep)(wait);
}

/** Whether `draft` (the prompt's text) still holds the message that was typed. */
function holdsMessage(draft: string | null, text: string): boolean {
  if (!draft) return false;
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  const head = squash(text.split("\n").find((l) => l.trim()) ?? text).slice(0, 30);
  return head !== "" && squash(draft).includes(head);
}

/** The prompt's text after typing, when the route can show it (tmux, iTerm2, Terminal); undefined for `relay shell`. */
async function promptAfterTyping(
  session: SessionRecord,
  route: TerminalRoute,
  ops: TypeOps,
): Promise<string | null | undefined> {
  if (route === "pty") return undefined;
  if (route === "tmux") {
    const screen =
      session.tmuxSocket && session.tmuxPane
        ? await ops.tmuxScreen(session.tmuxSocket, session.tmuxPane)
        : null;
    return screen === null ? null : promptDraft(screen);
  }
  const tty = foundTty.get(session.id) ?? (await ops.ttyOf(session.pid));
  const tab = tty ? await ops.peek(route, tty) : null;
  return tab?.screen == null ? null : promptDraft(tab.screen);
}

async function pressEnter(session: SessionRecord, route: TerminalRoute, ops: TypeOps): Promise<boolean> {
  try {
    if (route === "pty")
      return session.ptySocket && session.ptyToken && session.pid && ops.enterPty
        ? (await ops.enterPty(session.ptySocket, session.ptyToken, session.pid)).ok
        : false;
    if (route === "tmux") {
      if (!session.tmuxSocket || !session.tmuxPane || !ops.tmuxEnter) return false;
      if (!(await claudeIsInFront(session, null, ops))) return false;
      await ops.tmuxEnter(session.tmuxSocket, session.tmuxPane);
      return true;
    }
    const tty = foundTty.get(session.id) ?? (await ops.ttyOf(session.pid));
    if (!tty || !ops.enter || !(await claudeIsInFront(session, tty, ops))) return false;
    return await ops.enter(route, tty);
  } catch {
    return false;
  }
}

/**
 * A message typed into a terminal is submitted when its prompt hook arrives, normally within a moment. When it
 * doesn't (the Enter was lost, e.g. Claude Code was still handling a Stop), looks at the prompt: text still
 * there, or a terminal that can't be read (`relay shell`, where an Enter on an empty prompt does nothing), gets
 * Enter once more. Returns false when the message still sat in the prompt after that, so the caller can say so.
 */
async function confirmSubmitted(
  session: SessionRecord,
  text: string,
  route: TerminalRoute,
  opts: DeliverOptions,
  ops: TypeOps,
): Promise<boolean | null> {
  const { submitted } = opts;
  if (!submitted || !ops.sleep) return null;
  const waitFor = async (): Promise<boolean> => {
    const until = Date.now() + (opts.submitWaitMs ?? SUBMIT_WAIT_MS);
    while (Date.now() < until) {
      if (submitted()) return true;
      await ops.sleep?.(Math.min(100, Math.max(0, until - Date.now())));
    }
    return submitted();
  };
  if (await waitFor()) return true;
  const shown = await promptAfterTyping(session, route, ops);
  // Readable and the text is gone: it went in some other way (the hook was late); nothing to press.
  if (shown !== undefined && !holdsMessage(shown, text)) return null;
  log.warn("typed message not submitted, pressing Enter again", { sessionId: session.id, route });
  if (!(await pressEnter(session, route, ops))) return null;
  if (await waitFor()) return true;
  const after = await promptAfterTyping(session, route, ops);
  if (after !== undefined && holdsMessage(after, text)) {
    log.warn("typed message still unsent", { sessionId: session.id, route });
    return false;
  }
  return null;
}

/**
 * Types into the session's own terminal. Null when it has none Relay can reach (no such tab, the app isn't
 * running, the pane is gone), so the other routes get their turn. Throws WaitForPause instead of typing into
 * what you're typing.
 */
async function typeIntoTerminal(
  session: SessionRecord,
  text: string,
  opts: DeliverOptions,
  ops: TypeOps,
): Promise<TerminalRoute | null> {
  const anyway = opts.typeAnyway === true;
  const active = opts.idleSeconds !== null && opts.idleSeconds < PAUSE_SECONDS;
  if (session.ptySocket && session.ptyToken && session.pid) {
    let reply: TypeReply | null = null;
    try {
      reply = await ops.pty(session.ptySocket, session.ptyToken, session.pid, text, anyway);
    } catch {
      // the tab is gone; try the next route
    }
    if (reply?.ok) return "pty";
    // `relay shell` waited for a quiet moment in that tab and none came, or its prompt holds a draft. One from
    // before `force` keeps refusing while you type; after TYPE_ANYWAY_MS that one gives way to the next route.
    if (reply && !reply.ok && (reply.reason === "typing" || reply.reason === "draft") && !anyway)
      throw new WaitForPause("pty", reply.reason);
  }
  if (session.tmuxPane && session.tmuxSocket) {
    const screen = await ops.tmuxScreen(session.tmuxSocket, session.tmuxPane);
    if (screen !== null && (await claudeIsInFront(session, null, ops))) {
      const draft = promptDraft(screen);
      if (!anyway && (draft || active)) throw new WaitForPause("tmux", draft ? "draft" : "typing");
      try {
        await ops.tmux(session.tmuxSocket, session.tmuxPane, draft ? afterBreak(text) : text);
        return "tmux";
      } catch {
        // try the next route
      }
    }
  }
  const routes = ops.routes(session.terminal);
  if (!routes.length) return null;
  const found = await findTab(session, routes, ops);
  if (!found) return null;
  const { app, tty, tab } = found;
  if (!(await claudeIsInFront(session, tty, ops))) return null;
  const draft = tab.screen === null ? null : promptDraft(tab.screen);
  if (!anyway && (draft || (tab.front && active))) throw new WaitForPause(app, draft ? "draft" : "typing");
  if (await ops.type(app, tty, draft ? afterBreak(text) : text)) return app;
  log.info("typing failed, no route left", { sessionId: session.id, app, tty });
  return null;
}

/**
 * Whether the session's Claude Code is the program in front of its terminal (TypeOps.inFront). Logs when it isn't:
 * the message then goes on to the next route, the inbox at the latest.
 */
async function claudeIsInFront(session: SessionRecord, tty: string | null, ops: TypeOps): Promise<boolean> {
  const front = session.pid ? await ops.inFront(session.pid, tty).catch(() => false) : false;
  if (!front)
    log.info("not typing: Claude Code isn't the program in front of its terminal", {
      sessionId: session.id,
      pid: session.pid,
      tty,
    });
  return front;
}

/** The tty a session's tab was last found by, so the follow-up checks (Enter, the prompt's text) use the same one. */
const foundTty = new Map<string, string>();

/**
 * The terminal tabs a session may be in, in the order to try: the tty of its Claude Code process (every hook
 * reports the process, so a resumed, continued or cleared session, or one from before a helper restart, is found
 * again), then the tty it was last typed into, then the tab it is shown in when its process runs in a background
 * host (the process then has a pseudo-terminal that no tab has).
 */
export async function candidateTtys(
  session: SessionRecord,
  ops: Pick<TypeOps, "ttyOf" | "viewerTtyOf">,
): Promise<{ ttys: { tty: string; by: string }[]; missing: string[] }> {
  const ttys: { tty: string; by: string }[] = [];
  const missing: string[] = [];
  const add = (tty: string | null, by: string) => {
    if (tty && !ttys.some((t) => t.tty === tty)) ttys.push({ tty, by });
  };
  const own = await ops.ttyOf(session.pid);
  add(own, "process");
  if (!own)
    missing.push(session.pid ? `process ${session.pid} has no terminal (it ended?)` : "no process known");
  add(foundTty.get(session.id) ?? null, "earlier tab");
  if (session.pid && ops.viewerTtyOf) {
    const viewer = await ops.viewerTtyOf(session.pid, session.cwd).catch(() => null);
    add(viewer, "attached tab");
  }
  return { ttys, missing };
}

/** The first terminal tab that exists for the session; logs which lookups failed when none does. */
async function findTab(
  session: SessionRecord,
  routes: TypingRoute[],
  ops: TypeOps,
): Promise<{ app: TypingRoute; tty: string; tab: TabView } | null> {
  const { ttys, missing } = await candidateTtys(session, ops);
  const failed = [...missing];
  for (const { tty, by } of ttys)
    for (const app of routes) {
      const tab = await ops.peek(app, tty);
      if (tab) {
        foundTty.set(session.id, tty);
        return { app, tty, tab };
      }
      failed.push(`${app} has no tab on ${tty} (from the ${by})`);
    }
  foundTty.delete(session.id);
  log.info("no terminal tab for the session", { sessionId: session.id, pid: session.pid, tried: failed });
  return null;
}

/** The route a message to this session would be typed through right now, without typing; null when there is none. */
export async function typingRouteFor(
  session: SessionRecord,
  ops: TypeOps = defaultTypeOps,
): Promise<TerminalRoute | null> {
  if (session.ptySocket && session.ptyToken && session.pid) return "pty";
  if (
    session.tmuxPane &&
    session.tmuxSocket &&
    (await ops.tmuxScreen(session.tmuxSocket, session.tmuxPane)) !== null
  )
    return "tmux";
  const routes = ops.routes(session.terminal);
  const found = routes.length ? await findTab(session, routes, ops) : null;
  return found ? found.app : null;
}

/** What Claude reads when the phone's Stop goes through the inbox (session.interrupt). */
export const STOP_TEXT = "Stop what you're doing now and wait for my next message.";
export const STOP_MESSAGE = `${PHONE_PREFIX}\n${STOP_TEXT}`;

export type EscapeRoute = "pty" | "tmux" | TypingRoute;

/** The transports `pressEscape` uses; tests swap them. */
export interface KeyOps {
  pty(socketPath: string, token: string, pid: number): Promise<TypeReply>;
  tmux(socket: string, pane: string): Promise<void>;
  routes(termProgram: string | null): TypingRoute[];
  app(route: TypingRoute, tty: string): Promise<boolean>;
  ttyOf(pid: number | null): Promise<string | null>;
  viewerTtyOf?(pid: number, cwd: string): Promise<string | null>;
}

export const defaultKeyOps: KeyOps = {
  pty: (socketPath, token, pid) => requestPty(socketPath, { token, pid, key: "escape" }),
  tmux: tmuxEscape,
  routes: (t) => platform.typing.routes(t),
  app: (route, tty) => platform.typing.key(route, tty, "escape"),
  ttyOf,
  viewerTtyOf: (pid, cwd) => viewerTtyOf(pid, cwd),
};

/**
 * Presses Esc in the session's own terminal, the way you'd stop Claude at the keyboard: `relay shell` (Zed),
 * tmux, then iTerm2. Unlike typing it ignores `preferTyping` (a stop has no inbox equivalent of a key) and
 * the "you're active at the Mac" rules (you asked for it, and Esc doesn't mix into what you type). Returns the
 * route that took it, or null when none could.
 */
export async function pressEscape(
  session: SessionRecord,
  ops: KeyOps = defaultKeyOps,
): Promise<EscapeRoute | null> {
  if (session.ptySocket && session.ptyToken && session.pid) {
    try {
      // A `relay shell` from before key requests answers bad_request (no text): try the next route.
      if ((await ops.pty(session.ptySocket, session.ptyToken, session.pid)).ok)
        return pressed(session, "pty");
    } catch {
      // the tab is gone
    }
  }
  if (session.tmuxPane && session.tmuxSocket) {
    try {
      await ops.tmux(session.tmuxSocket, session.tmuxPane);
      return pressed(session, "tmux");
    } catch {
      // try the next route
    }
  }
  const routes = ops.routes(session.terminal);
  if (routes.length) {
    const { ttys } = await candidateTtys(session, ops);
    for (const { tty } of ttys)
      for (const app of routes) if (await ops.app(app, tty)) return pressed(session, app);
  }
  return null;
}

/** Notes the Esc, so a message sent right after it waits (ESC_SETTLE_MS). */
function pressed(session: SessionRecord, route: EscapeRoute): EscapeRoute {
  lastEscape.set(session.id, Date.now());
  return route;
}

/**
 * Asks `relay shell` to type `text` into its tab. It waits up to 15 s for you to stop typing there and refuses a
 * draft in the prompt line, unless `force` (the message waited long enough): then it types at once, after a clean
 * break from a draft. A `relay shell` from before `force` ignores it.
 */
export function typeIntoPty(
  socketPath: string,
  token: string,
  pid: number,
  text: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<TypeReply> {
  return requestPty(socketPath, { token, text, pid, ...(opts.force ? { force: true } : {}) }, opts.timeoutMs);
}

function requestPty(socketPath: string, req: TypeRequest, timeoutMs = 20_000): Promise<TypeReply> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new DeliveryError("timed out typing into the terminal"));
    }, timeoutMs);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(new DeliveryError(`terminal unreachable: ${err.message}`));
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
    });
    sock.once("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()) as TypeReply);
      } catch {
        reject(new DeliveryError("no answer from the terminal"));
      }
    });
    sock.once("connect", () => {
      sock.write(`${JSON.stringify(req)}\n`);
    });
  });
}

/** The controlling terminal of the Claude Code process, e.g. /dev/ttys003. */
export async function ttyOf(pid: number | null): Promise<string | null> {
  if (!pid) return null;
  const proc = Bun.spawn(["ps", "-o", "tty=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return /^ttys\d+$/.test(out) ? `/dev/${out}` : null;
}

/**
 * The tab a session running in a background host is shown in. Claude Code (2.1.32x) resumes a session as a
 * `--bg-pty-host` child whose pseudo-terminal belongs to no tab; the `claude` the person sees in the tab is a viewer
 * that talks to it through Claude Code's daemon. Nothing links the two but the folder, so the viewer is taken only when
 * it is the one `claude` process in that folder, on a terminal, that no other known session is running as.
 */
export async function viewerTtyOf(
  pid: number,
  cwd: string,
  /** Processes of other sessions Relay knows, which are not this session's viewer. */
  others: number[] = knownPids(),
): Promise<string | null> {
  const ps = await sh(["ps", "-ax", "-o", "pid=,ppid=,tty=,command="]);
  const procs = ps
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3] ?? "", command: m[4] ?? "" }));
  const mine = procs.find((p) => p.pid === pid);
  const host = mine ? procs.find((p) => p.pid === mine.ppid) : undefined;
  if (!host?.command.includes("--bg-pty-host")) return null;
  const viewers = procs.filter(
    (p) =>
      /^ttys\d+$/.test(p.tty) &&
      p.pid !== pid &&
      !others.includes(p.pid) &&
      /^(\S*\/)?claude(\s|$)/.test(p.command) &&
      !p.command.includes("--bg-pty-host"),
  );
  if (!viewers.length) return null;
  const cwds = await sh(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", viewers.map((v) => v.pid).join(",")]);
  const inFolder = new Set<number>();
  let cur = 0;
  for (const line of cwds.split("\n")) {
    if (line.startsWith("p")) cur = Number(line.slice(1));
    else if (line.startsWith("n") && line.slice(1) === cwd) inFolder.add(cur);
  }
  const hits = viewers.filter((v) => inFolder.has(v.pid));
  return hits.length === 1 ? `/dev/${hits[0]?.tty}` : null;
}

let knownPidsProvider: () => number[] = () => [];
/** The daemon tells where to look up the processes of the sessions it tracks. */
export function setKnownPids(provider: () => number[]): void {
  knownPidsProvider = provider;
}
const knownPids = () => knownPidsProvider();

async function sh(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", env: { PATH: CHILD_PATH } });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/**
 * Wire format confirmed in Claude Code 2.1.316: an optional auth line, then one JSON line per message.
 * Open the connection only when the message is ready: Claude Code closes connections that send no
 * complete line within 30 seconds.
 */
export function postToInbox(
  socketPath: string,
  token: string | null,
  text: string,
  timeoutMs = 5000,
  /** "now" makes Claude Code act on it at once, aborting the turn it is working on (session.interrupt). */
  priority?: "now",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new DeliveryError("timed out writing to the session inbox"));
    }, timeoutMs);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(new DeliveryError(`session inbox unreachable: ${err.message}`));
    });
    sock.once("connect", () => {
      const lines = [];
      if (token) lines.push(JSON.stringify({ type: "auth", token }));
      lines.push(
        JSON.stringify({
          type: "user",
          ...(priority ? { priority } : {}),
          message: { role: "user", content: text },
        }),
      );
      sock.end(`${lines.join("\n")}\n`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

/** The pane's visible text (`capture-pane -p`), or null when tmux can't read it. */
async function tmuxScreen(socket: string, pane: string): Promise<string | null> {
  const proc = Bun.spawn(["tmux", "-S", socket, "capture-pane", "-p", "-t", pane], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out : null;
}

/**
 * A message that ends in attachment paths, split: the text, then each path (one per line, `"`-quoted or not, inside
 * an `attachments` folder). Claude Code turns a pasted prompt into "[Image #N]" only when the paste is one path and
 * nothing else; a paste of text and paths on several lines stays text, and Claude reads the file with a tool.
 */
export function splitAttachmentPaths(text: string): { body: string; paths: string[] } {
  const lines = text.split("\n");
  const paths: string[] = [];
  while (lines.length > 0) {
    const line = lines[lines.length - 1] ?? "";
    if (!/^"?\/[^\n]*\/attachments\/[^/\n]+\/[^/\n]+"?$/.test(line)) break;
    paths.unshift(line);
    lines.pop();
  }
  return { body: lines.join("\n"), paths };
}

export type TmuxStep = { args: string[]; stdin?: string; waitMs?: number };

/** The tmux commands that type a message: text, then each attachment path pasted on its own, then Enter. */
export function tmuxTypeSteps(socket: string, pane: string, text: string): TmuxStep[] {
  const base = ["tmux", "-S", socket];
  const { body, paths } = splitAttachmentPaths(cleanTypedText(text));
  const paste = (t: string): TmuxStep[] => [
    { args: [...base, "load-buffer", "-b", "relay", "-"], stdin: t },
    { args: [...base, "paste-buffer", "-p", "-d", "-b", "relay", "-t", pane] },
  ];
  const steps: TmuxStep[] = [];
  if (body)
    steps.push(
      // A newline or a tab goes in as a paste: typed, it would be Enter or Tab.
      ...(/[\n\t]/.test(body)
        ? paste(body)
        : [{ args: [...base, "send-keys", "-t", pane, "-l", "--", body] }]),
    );
  // Each path is a paste of its own, so Claude Code makes it "[Image #N]" for an image.
  for (const path of paths) {
    if (steps.length > 0) steps.push({ args: [...base, "send-keys", "-t", pane, "-l", "--", " "] });
    steps.push(...paste(path));
  }
  // Let Claude Code turn the pasted path into its image before Enter (an Enter right after it is lost).
  steps.push({
    args: [...base, "send-keys", "-t", pane, "Enter"],
    ...(paths.length > 0 ? { waitMs: 300 } : {}),
  });
  return steps;
}

export async function tmuxType(socket: string, pane: string, text: string): Promise<void> {
  for (const step of tmuxTypeSteps(socket, pane, text)) {
    if (step.waitMs) await Bun.sleep(step.waitMs);
    const proc = Bun.spawn(step.args, {
      stdin: step.stdin === undefined ? "ignore" : new Blob([step.stdin]),
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: CHILD_PATH },
    });
    const code = await proc.exited;
    if (code !== 0) throw new DeliveryError(`tmux ${step.args[3]} failed (${code})`);
  }
}

async function tmuxEnter(socket: string, pane: string): Promise<void> {
  const proc = Bun.spawn(["tmux", "-S", socket, "send-keys", "-t", pane, "Enter"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const code = await proc.exited;
  if (code !== 0) throw new DeliveryError(`tmux send-keys failed (${code})`);
}

/** Esc in a tmux pane: the key alone, no Enter. */
export function tmuxEscapeArgs(socket: string, pane: string): string[] {
  return ["tmux", "-S", socket, "send-keys", "-t", pane, "Escape"];
}

async function tmuxEscape(socket: string, pane: string): Promise<void> {
  const proc = Bun.spawn(tmuxEscapeArgs(socket, pane), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const code = await proc.exited;
  if (code !== 0) throw new DeliveryError(`tmux send-keys failed (${code})`);
}

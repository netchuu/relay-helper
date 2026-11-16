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
import {
  type PaneInfo,
  type PaneTarget,
  paneEnter,
  paneInfo,
  paneScreen,
  paneTargetOf,
  paneType,
} from "./paneTerminals.ts";
import { afterBreak, noKeySincePrompt, promptDraft, promptSuggestionRead } from "./promptLine.ts";
import type { SessionRecord } from "./registry.ts";
import { transcriptPathFor } from "./transcript.ts";

export type DeliveryRoute =
  | "pty"
  | "tmux"
  | "wezterm"
  | "kitty"
  | "iterm"
  | "desktop"
  | "ide"
  | "socket"
  | "headless";

/** The Claude Code processes the helper owns (headless.ts): a message for one of their sessions goes to its stdin. */
export interface HeadlessRoute {
  has(sessionId: string): boolean;
  send(sessionId: string, text: string): Promise<void>;
}

export interface DeliveryResult {
  via: DeliveryRoute;
  /**
   * False when the message was typed into a terminal but never submitted: it still sits in the prompt after Enter
   * was pressed twice. Absent when it went through or couldn't be checked.
   */
  submitted?: false;
}

export class DeliveryError extends Error {}

/** The session is in the desktop app and the Mac is locked (macOS hides its contents): the reply waits for the unlock. */
export class WaitForUnlock extends Error {}

/** Typing now could mix into what the person at the Mac types, or into a prompt draft: the message waits for a pause. */
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
export type TerminalRoute = "pty" | "tmux" | PaneTarget["kind"] | TypingRoute;

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
  /**
   * Only the session's own terminal (a slash command like `/model` means nothing to the desktop app, the editor or
   * the inbox): none Relay can type into throws a DeliveryError.
   */
  terminalOnly?: boolean;
  /** Processes the helper runs itself: a session among them gets the message on its stdin, before any other route. */
  headless?: HeadlessRoute;
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
  /** The tty of the pane's own terminal; null when tmux can't tell. Absent: the pane isn't checked against the process. */
  tmuxPaneTty?(socket: string, pane: string): Promise<string | null>;
  /** WezTerm panes and kitty windows (paneTerminals.ts): the pane's text, typing, Enter, and what it tells about itself. */
  paneScreen?(target: PaneTarget): Promise<string | null>;
  paneType?(target: PaneTarget, text: string): Promise<void>;
  paneEnter?(target: PaneTarget): Promise<void>;
  paneInfo?(target: PaneTarget): Promise<PaneInfo | null>;
  routes(termProgram: string | null): TypingRoute[];
  ttyOf(pid: number | null): Promise<string | null>;
  /** The tty of the tab showing a session that runs in a background host (`--bg-pty-host`); null when unknown. */
  viewerTtyOf?(pid: number, cwd: string): Promise<string | null>;
  peek(route: TypingRoute, tty: string): Promise<TabView | null>;
  type(route: TypingRoute, tty: string, text: string): Promise<boolean>;
  /** Whether process `pid` is in front in its terminal (`tty` null: tmux) or tab; otherwise keys would reach a shell. */
  inFront(pid: number, tty: string | null, others?: number[]): Promise<boolean>;
  /** Enter alone, for a message that sat typed and unsent. Absent: no check is made. */
  enterPty?(socketPath: string, token: string, pid: number): Promise<TypeReply>;
  tmuxEnter?(socket: string, pane: string): Promise<void>;
  enter?(route: TypingRoute, tty: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  /** Whether no key was pressed at this Mac since the session's prompt was last submitted. Absent: false. */
  noKeySincePrompt?(sessionId: string): boolean;
}

export const defaultTypeOps: TypeOps = {
  pty: (socketPath, token, pid, text, force) => typeIntoPty(socketPath, token, pid, text, { force }),
  tmuxScreen,
  tmux: tmuxType,
  tmuxPaneTty,
  paneScreen,
  paneType: (target, text) => paneType(target, text, splitAttachmentPaths),
  paneEnter,
  paneInfo,
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
  noKeySincePrompt: (sessionId) => noKeySincePrompt(sessionId, platform.typing.keyIdleSeconds?.() ?? null),
};

/**
 * Delivers free text from the phone into a session: its own terminal (throws WaitForPause rather than mix into typing),
 * then the desktop app, then the inbox socket. The text is cleaned first; Relay presses Enter itself.
 */
export async function deliver(
  session: SessionRecord,
  raw: string,
  opts: DeliverOptions,
  ops: TypeOps = defaultTypeOps,
): Promise<DeliveryResult> {
  const text = cleanTypedText(raw);
  if (opts.headless?.has(session.id)) {
    if (opts.terminalOnly) throw new DeliveryError("This session runs in Relay, without a terminal.");
    await opts.headless.send(session.id, text).catch((err) => {
      throw new DeliveryError(err instanceof Error ? err.message : "the session didn't take the message");
    });
    return { via: "headless" };
  }
  if (opts.preferTyping) {
    await settleAfterEscape(session.id, ops);
    const typed = await typeIntoTerminal(session, text, opts, ops);
    if (typed) {
      const submitted = await confirmSubmitted(session, text, typed, opts, ops);
      return submitted === false ? { via: typed, submitted } : { via: typed };
    }
    if (opts.terminalOnly) throw new DeliveryError("Relay can't type into this session's terminal.");
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

/** The prompt's text after typing, when the route can show it (tmux, iTerm2); undefined for `relay shell`. */
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
  if (route === "wezterm" || route === "kitty") {
    const target = paneTargetOf(session);
    const screen = target && ops.paneScreen ? await ops.paneScreen(target) : null;
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
      if (!(await claudeIsInFrontInPane(session, ops))) return false;
      await ops.tmuxEnter(session.tmuxSocket, session.tmuxPane);
      return true;
    }
    if (route === "wezterm" || route === "kitty") {
      const target = paneTargetOf(session);
      if (!target || !ops.paneEnter || !(await claudeIsInPaneTerminal(session, target, ops))) return false;
      await ops.paneEnter(target);
      return true;
    }
    const tty = foundTty.get(session.id) ?? (await ops.ttyOf(session.pid));
    if (!tty || !ops.enter || !(await claudeIsInFront(session, tty, ops))) return false;
    return await ops.enter(route, tty);
  } catch {
    return false;
  }
}

/** If the prompt hook hasn't arrived, presses Enter once more when the text still sits in the prompt (or can't be read). */
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

/** Types into the session's own terminal; null when none is reachable. Throws WaitForPause rather than mix into typing. */
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
    if (screen !== null && (await claudeIsInFrontInPane(session, ops))) {
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
  const pane = paneTargetOf(session);
  if (pane && ops.paneScreen && ops.paneType) {
    const screen = await ops.paneScreen(pane);
    if (screen !== null && (await claudeIsInPaneTerminal(session, pane, ops))) {
      const draft = promptDraft(screen);
      if (!anyway && (draft || active)) throw new WaitForPause(pane.kind, draft ? "draft" : "typing");
      try {
        await ops.paneType(pane, draft ? afterBreak(text) : text);
        return pane.kind;
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
  // The tab's text has no attributes: with no key pressed here since the prompt was submitted, what it shows in
  // the prompt is Claude Code's grey suggestion, not typing.
  const draft =
    tab.screen === null
      ? null
      : promptDraft(tab.screen, { noKeySincePrompt: ops.noKeySincePrompt?.(session.id) === true });
  if (!anyway && (draft || (tab.front && active))) throw new WaitForPause(app, draft ? "draft" : "typing");
  if (await ops.type(app, tty, draft ? afterBreak(text) : text)) return app;
  log.info("typing failed, no route left", { sessionId: session.id, app, tty });
  return null;
}

/**
 * Whether the session's Claude Code is the program in front of its terminal (TypeOps.inFront). Logs when it isn't:
 * the message then goes on to the next route, the inbox at the latest.
 */
async function claudeIsInFront(
  session: SessionRecord,
  tty: string | null,
  ops: Pick<TypeOps, "inFront" | "ttyOf" | "viewerTtyOf">,
  what = "typing",
): Promise<boolean> {
  let front = session.pid ? await ops.inFront(session.pid, tty, knownPids()).catch(() => false) : false;
  // A tab that isn't the process's own terminal (the one it was typed into before, or its viewer's) is this
  // session's only while its viewer is still there: another session may run in it now, in a background host too.
  if (front && tty !== null && session.pid && ops.viewerTtyOf) {
    const own = await ops.ttyOf(session.pid).catch(() => null);
    if (own !== tty) {
      const viewer = await ops.viewerTtyOf(session.pid, session.cwd).catch(() => null);
      front = viewer === tty;
    }
  }
  if (!front)
    log.info(`not ${what}: Claude Code isn't the program in front of its terminal`, {
      sessionId: session.id,
      pid: session.pid,
      tty,
    });
  return front;
}

/** Whether the session's Claude Code is the foreground program on its stored tmux pane's tty (a resume elsewhere differs). */
async function claudeIsInFrontInPane(
  session: SessionRecord,
  ops: Pick<TypeOps, "tmuxPaneTty" | "ttyOf" | "inFront">,
): Promise<boolean> {
  if (!session.tmuxSocket || !session.tmuxPane || !session.pid) return false;
  if (ops.tmuxPaneTty) {
    const [paneTty, procTty] = await Promise.all([
      ops.tmuxPaneTty(session.tmuxSocket, session.tmuxPane).catch(() => null),
      ops.ttyOf(session.pid).catch(() => null),
    ]);
    if (!sameTty(paneTty, procTty)) {
      log.info("not typing into tmux: Claude Code isn't running in that pane", {
        sessionId: session.id,
        pid: session.pid,
        paneTty,
        procTty,
      });
      return false;
    }
  }
  return ops.inFront(session.pid, null).catch(() => false);
}

/** Whether the session's Claude Code is the foreground program in its WezTerm pane or kitty window. */
async function claudeIsInPaneTerminal(
  session: SessionRecord,
  target: PaneTarget,
  ops: Pick<TypeOps, "paneInfo" | "ttyOf" | "inFront">,
): Promise<boolean> {
  if (!session.pid || !ops.paneInfo) return false;
  const [info, procTty] = await Promise.all([
    ops.paneInfo(target).catch(() => null),
    ops.ttyOf(session.pid).catch(() => null),
  ]);
  const inPane = info
    ? info.tty !== undefined
      ? sameTty(info.tty, procTty)
      : (info.pids ?? []).includes(session.pid)
    : false;
  if (!inPane) {
    log.info(`not typing into ${target.kind}: Claude Code isn't running in that pane`, {
      sessionId: session.id,
      pid: session.pid,
    });
    return false;
  }
  return ops.inFront(session.pid, null).catch(() => false);
}

/** The tty a session's tab was last found by, so the follow-up checks (Enter, the prompt's text) use the same one. */
const foundTty = new Map<string, string>();

/** The ttys a session may be in, in order: its process's, the last one typed into, then its background host's tab. */
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
  const pane = paneTargetOf(session);
  if (pane && ops.paneScreen && (await ops.paneScreen(pane)) !== null) return pane.kind;
  const routes = ops.routes(session.terminal);
  const found = routes.length ? await findTab(session, routes, ops) : null;
  return found ? found.app : null;
}

/** Claude Code's suggested next message on screen: null when none, undefined when the screen can't be read. Quiet. */
export async function readSuggestion(
  session: SessionRecord,
  ops: TypeOps = defaultTypeOps,
): Promise<string | null | undefined> {
  try {
    if (session.tmuxPane && session.tmuxSocket) {
      const screen = await ops.tmuxScreen(session.tmuxSocket, session.tmuxPane);
      if (screen !== null) return promptSuggestionRead(screen);
    }
    const routes = ops.routes(session.terminal);
    if (!routes.length) return undefined;
    const { ttys } = await candidateTtys(session, ops);
    for (const { tty } of ttys)
      for (const app of routes) {
        const tab = await ops.peek(app, tty);
        if (!tab) continue;
        foundTty.set(session.id, tty);
        // No attributes in the tab's text: with no key pressed here since the prompt was submitted, what the prompt
        // shows is the suggestion, not typing.
        return tab.screen === null
          ? undefined
          : promptSuggestionRead(tab.screen, {
              noKeySincePrompt: ops.noKeySincePrompt?.(session.id) === true,
            });
      }
  } catch {
    // the screen can't be read right now
  }
  return undefined;
}

/** What Claude reads when the phone's Stop goes through the inbox (session.interrupt). */
export const STOP_TEXT = "Stop what you're doing now and wait for my next message.";
export const STOP_MESSAGE = `${PHONE_PREFIX}\n${STOP_TEXT}`;

export type EscapeRoute = "pty" | "tmux" | TypingRoute;

/** The transports `pressEscape` uses; tests swap them. */
export interface KeyOps {
  pty(socketPath: string, token: string, pid: number): Promise<TypeReply>;
  tmux(socket: string, pane: string): Promise<void>;
  /** As in TypeOps: when present, Esc goes to the pane only if Claude Code is in front there. */
  tmuxPaneTty?(socket: string, pane: string): Promise<string | null>;
  inFront?(pid: number, tty: string | null, others?: number[]): Promise<boolean>;
  routes(termProgram: string | null): TypingRoute[];
  app(route: TypingRoute, tty: string): Promise<boolean>;
  ttyOf(pid: number | null): Promise<string | null>;
  viewerTtyOf?(pid: number, cwd: string): Promise<string | null>;
}

export const defaultKeyOps: KeyOps = {
  pty: (socketPath, token, pid) => requestPty(socketPath, { token, pid, key: "escape" }),
  tmux: tmuxEscape,
  tmuxPaneTty,
  inFront: claudeInFront,
  routes: (t) => platform.typing.routes(t),
  app: (route, tty) => platform.typing.key(route, tty, "escape"),
  ttyOf,
  viewerTtyOf: (pid, cwd) => viewerTtyOf(pid, cwd),
};

/** Presses Esc in the session's terminal; ignores `preferTyping` and the activity rules. Returns the route, or null. */
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
  if (
    session.tmuxPane &&
    session.tmuxSocket &&
    (await claudeIsInFrontInPane(session, {
      tmuxPaneTty: ops.tmuxPaneTty,
      ttyOf: ops.ttyOf,
      inFront: ops.inFront ?? (async () => true),
    }))
  ) {
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
    const frontOps = {
      inFront: ops.inFront ?? (async () => true),
      ttyOf: ops.ttyOf,
      viewerTtyOf: ops.viewerTtyOf,
    };
    for (const { tty } of ttys) {
      // Esc goes only to a tab where this session's Claude Code is the program in front, as typing does: the
      // remembered tab may run another session now, and a suspended Claude Code leaves the tab to vim or the shell.
      if (!(await claudeIsInFront(session, tty, frontOps, "pressing Esc"))) continue;
      for (const app of routes) if (await ops.app(app, tty)) return pressed(session, app);
    }
  }
  return null;
}

/** Notes the Esc, so a message sent right after it waits (ESC_SETTLE_MS). */
function pressed(session: SessionRecord, route: EscapeRoute): EscapeRoute {
  lastEscape.set(session.id, Date.now());
  return route;
}

/** Asks `relay shell` to type `text`; it waits up to 15 s for a pause and refuses a draft unless `force`. */
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
  return fullTty(out);
}

/** A terminal name as `ps` prints it (`ttys003` on macOS, `pts/0` or `tty1` on Linux), or null for none (`??`, `?`). */
const PS_TTY = /^(ttys\d+|pts\/\d+|tty\d+)$/;

/** The device path of a `ps` terminal name (`ttys003` is `/dev/ttys003`), or null when it names no terminal. */
export function fullTty(psName: string): string | null {
  return PS_TTY.test(psName) ? `/dev/${psName}` : null;
}

/** Whether two terminal names are the same one: tmux's `pane_tty` is `/dev/pts/0`, `ps` prints `pts/0`. */
export function sameTty(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/^\/dev\//, "") === b.replace(/^\/dev\//, "");
}

/**
 * The tab of a session in a background host: its pty has no tab, and only the folder links it to the viewer `claude`.
 * The viewer counts only when it is the one such process in that folder that no other known session uses.
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
      PS_TTY.test(p.tty) &&
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

/** Wire format: an optional auth line, then one JSON line per message. Claude Code drops idle connections after 30 s. */
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

/** The pane's visible text with its escape codes (`capture-pane -p -e`: the dim attribute marks a suggestion), or null when tmux can't read it. */
async function tmuxScreen(socket: string, pane: string): Promise<string | null> {
  const proc = Bun.spawn(["tmux", "-S", socket, "capture-pane", "-p", "-e", "-t", pane], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out : null;
}

/** The tty of a pane's terminal (`#{pane_tty}`), or null when tmux can't tell. */
async function tmuxPaneTty(socket: string, pane: string): Promise<string | null> {
  const proc = Bun.spawn(["tmux", "-S", socket, "display-message", "-p", "-t", pane, "#{pane_tty}"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out ? out : null;
}

/** Splits a message ending in attachment paths into text and paths; Claude makes "[Image #N]" only from a lone path paste. */
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
  if (body) {
    // A newline or a tab goes in as a paste: typed, it would be Enter or Tab.
    if (/[\n\t]/.test(body)) steps.push(...paste(body));
    else {
      // tmux reads an argument that ends in ";" as a command separator and drops it, so trailing semicolons go
      // in as hex keys (0x3b) instead.
      const text = body.replace(/;+$/, "");
      const semis = body.length - text.length;
      if (text) steps.push({ args: [...base, "send-keys", "-t", pane, "-l", "--", text] });
      if (semis > 0)
        steps.push({ args: [...base, "send-keys", "-t", pane, "-H", ...Array<string>(semis).fill("3b")] });
    }
  }
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

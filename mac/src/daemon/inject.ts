import { connect } from "node:net";
import { CHILD_PATH } from "../config.ts";
import {
  askForAccessibility,
  axAllowed,
  type DesktopResult,
  desktopReady,
  desktopSessionWithoutPermission,
  sendToDesktop,
} from "../integrations/claudeDesktop.ts";
import { type IdeResult, isIdeSessionSync, sendToIde } from "../integrations/ideExtension.ts";
import { log } from "../log.ts";
import {
  claudeInFront,
  type Proc,
  PS_SNAPSHOT_ARGS,
  parseProcs,
  snapshotProcs,
  wrapperTtys,
} from "../platform/foreground.ts";
import { platform } from "../platform/index.ts";
import type { TabView, TypingRoute } from "../platform/types.ts";
import type { TypeReply, TypeRequest } from "../shell/ptyShell.ts";
import { cleanTypedText } from "../shell/typedText.ts";
import {
  type PaneInfo,
  type PaneTarget,
  PartlyTyped,
  paneEnter,
  paneEscape,
  paneInfo,
  paneScreen,
  paneStash,
  paneTargetOf,
  paneType,
} from "./paneTerminals.ts";
import {
  afterBreak,
  noKeySincePrompt,
  type PromptOptions,
  promptDraft,
  promptHoldsText,
  promptSuggestionRead,
  promptTextRead,
} from "./promptLine.ts";
import type { SessionRecord } from "./registry.ts";
import {
  noteSuggestionKnown,
  noteSuggestionSeen,
  suggestionKnownOf,
  suggestionSeenOf,
  untypedStopAt,
} from "./suggestionSeen.ts";
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
  send(sessionId: string, text: string, onLost?: () => void): Promise<void>;
}

export interface DeliveryResult {
  via: DeliveryRoute;
  /** False when the message was typed but never seen to arrive (terminal: Enter pressed twice; app or editor: no transcript). */
  submitted?: false;
}

export class DeliveryError extends Error {}

/** An editor session whose Claude Code panel isn't visible and that has no inbox socket: nothing can take the message. */
export class OpenEditorPanel extends DeliveryError {
  constructor() {
    super("Open the Claude Code panel in your editor on the Mac, then send again");
  }
}

/** A command for the session itself (`/model`) can't go in while the prompt holds text the person typed. */
export class DraftInPrompt extends DeliveryError {}

/** Terminals Relay types into, as opposed to the desktop app, the editor extension and the inbox. */
export type TerminalRoute = "pty" | "tmux" | PaneTarget["kind"] | TypingRoute;

/** Honest provenance line; Claude Code itself frames socket messages as coming from a peer session. */
export const PHONE_PREFIX = "📱 From the user, sent from their phone via Relay:";

export interface DeliverOptions {
  /** The editor extension's own rule (active in the last 8 s): it steps aside then, to the inbox. */
  userTypingNow: boolean;
  preferTyping: boolean;
  locked?: boolean;
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
  /** A message to a process the helper runs was answered as delivered, then the process ended without reading it. */
  onLost?: () => void;
}

/** Claude Code needs this long after an Esc before it takes keys as a new message (it is still handling the interrupt). */
export const ESC_SETTLE_MS = 1500;

/** A typed message whose prompt hook hasn't arrived by now is checked, and gets Enter once more. */
export const SUBMIT_WAIT_MS = 4000;

/** When Relay last pressed Esc in a session's terminal (pressEscape). */
const lastEscape = new Map<string, number>();

/** How `deliver` reaches terminals; tests swap them. */
/** The processes of one delivery attempt: read once on first use, then shared by every check. */
export type Procs = () => Promise<Proc[]>;

/** The ttys tmux told while reading a pane's screen, by socket and pane, so asking for one costs nothing more. */
export type PaneTtys = Map<string, string | null>;

export interface TypeOps {
  pty(socketPath: string, token: string, pid: number, text: string): Promise<TypeReply>;
  /** The pane's visible text; null when the pane can't be read (it's gone). */
  tmuxScreen(socket: string, pane: string, seen?: PaneTtys): Promise<string | null>;
  tmux(socket: string, pane: string, text: string): Promise<void>;
  /** The tty of the pane's own terminal; null when tmux can't tell. Absent: the pane isn't checked against the process. */
  tmuxPaneTty?(socket: string, pane: string, seen?: PaneTtys): Promise<string | null>;
  /** WezTerm panes and kitty windows (paneTerminals.ts): the pane's text, typing, Enter, and what it tells about itself. */
  paneScreen?(target: PaneTarget): Promise<string | null>;
  paneType?(target: PaneTarget, text: string): Promise<void>;
  paneEnter?(target: PaneTarget): Promise<void>;
  paneStash?(target: PaneTarget): Promise<void>;
  paneInfo?(target: PaneTarget): Promise<PaneInfo | null>;
  routes(termProgram: string | null): TypingRoute[];
  ttyOf(pid: number | null, procs?: Procs): Promise<string | null>;
  /** The tty of the tab showing a session that runs in a background host (`--bg-pty-host`); null when unknown. */
  viewerTtyOf?(pid: number, cwd: string, procs?: Procs): Promise<string | null>;
  /** The terminals of the wrappers Claude Code runs under (its own pty), nearest first. */
  wrapperTtysOf?(pid: number, procs?: Procs): Promise<WrapperTty[]>;
  peek(route: TypingRoute, tty: string): Promise<TabView | null>;
  type(route: TypingRoute, tty: string, text: string): Promise<boolean>;
  /** Whether process `pid` is in front in its terminal (`tty` null: tmux) or tab; otherwise keys would reach a shell. */
  inFront(pid: number, tty: string | null, others?: number[], procs?: Procs): Promise<boolean>;
  /** Enter alone, for a message that sat typed and unsent. Absent: no check is made. */
  enterPty?(socketPath: string, token: string, pid: number): Promise<TypeReply>;
  tmuxEnter?(socket: string, pane: string): Promise<void>;
  enter?(route: TypingRoute, tty: string): Promise<boolean>;
  /** Claude Code's stash key (Ctrl+S): puts the prompt's draft aside and brings it back when a message is sent. */
  tmuxStash?(socket: string, pane: string): Promise<void>;
  stash?(route: TypingRoute, tty: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  /** Whether no key was pressed at this Mac since the session's prompt was last submitted. Absent: false. */
  noKeySincePrompt?(sessionId: string): boolean;
  /** The clock, in ms. Absent: `Date.now`. */
  now?(): number;
  /** The desktop app and editor routes. Absent: the real ones. */
  gui?: GuiOps;
}

/** The desktop app and editor routes of `deliver`; tests swap them. */
export interface GuiOps {
  desktopReady(sessionId: string): Promise<boolean>;
  sendToDesktop(sessionId: string, text: string, transcript: string | null): Promise<DesktopResult>;
  isIdeSession(transcript: string | null): boolean;
  axAllowed(): boolean;
  sendToIde(
    sessionId: string,
    text: string,
    transcript: string | null,
    userActive?: boolean,
  ): Promise<IdeResult>;
}

export const defaultGuiOps: GuiOps = {
  desktopReady,
  sendToDesktop,
  isIdeSession: (t) => process.platform === "darwin" && isIdeSessionSync(t),
  axAllowed,
  sendToIde,
};

export const defaultTypeOps: TypeOps = {
  pty: (socketPath, token, pid, text) => typeIntoPty(socketPath, token, pid, text),
  tmuxScreen,
  tmux: tmuxType,
  tmuxPaneTty,
  paneScreen,
  paneType: (target, text) => paneType(target, text, splitAttachmentPaths),
  paneEnter,
  paneStash,
  paneInfo,
  routes: (t) => platform.typing.routes(t),
  ttyOf,
  viewerTtyOf: (pid, cwd, procs) => viewerTtyOf(pid, cwd, undefined, procs),
  wrapperTtysOf,
  peek: (route, tty) => platform.typing.peek(route, tty),
  type: (route, tty, text) => platform.typing.type(route, tty, text),
  inFront: claudeInFront,
  enterPty: (socketPath, token, pid) => requestPty(socketPath, { token, pid, key: "enter" }),
  tmuxEnter,
  tmuxStash,
  enter: (route, tty) => platform.typing.key(route, tty, "enter"),
  stash: (route, tty) => platform.typing.key(route, tty, "stash"),
  sleep: (ms) => Bun.sleep(ms),
  noKeySincePrompt: (sessionId) => noKeySincePrompt(sessionId, platform.typing.keyIdleSeconds?.() ?? null),
};

/**
 * Delivers free text from the phone into a session: its own terminal (at once, whatever is in the prompt), then the
 * desktop app, then the inbox socket. The text is cleaned first; Relay presses Enter itself.
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
    await opts.headless.send(session.id, text, opts.onLost).catch((err) => {
      throw new DeliveryError(err instanceof Error ? err.message : "the session didn't take the message");
    });
    return { via: "headless" };
  }
  let noPanel = false;
  // macOS hides the desktop app's and the editor's windows while the Mac is locked, so they can't be typed into.
  let hidden = false;
  if (opts.preferTyping) {
    await settleAfterEscape(session.id, ops);
    const typed = await typeIntoTerminal(session, text, opts, ops);
    if (typed) {
      const submitted = await confirmSubmitted(session, text, typed.route, opts, ops);
      if (submitted === false) leftUnsent.set(session.id, text);
      else leftUnsent.delete(session.id);
      const unsent = submitted === false || (typed.partial && submitted !== true);
      return unsent ? { via: typed.route, submitted: false } : { via: typed.route };
    }
    if (opts.terminalOnly) throw new DeliveryError("Relay can't type into this session's terminal.");
    if (desktopSessionWithoutPermission(session.id)) {
      const asked = askForAccessibility();
      if (asked !== "skipped") log.info("accessibility", { result: asked, for: session.id });
    }
    const gui = ops.gui ?? defaultGuiOps;
    if (await gui.desktopReady(session.id)) {
      if (opts.locked) hidden = true;
      else {
        const result = await gui.sendToDesktop(session.id, text, transcriptPathFor(session));
        log.info("desktop route", { sessionId: session.id, result });
        if (result === "sent") return { via: "desktop" };
        if (result === "unconfirmed") return { via: "desktop", submitted: false };
        hidden = result === "locked";
        // A draft in the composer, no unique sidebar row, or anything unexpected: the inbox, below.
      }
    }
    const transcript = transcriptPathFor(session);
    if (gui.isIdeSession(transcript)) {
      if (!gui.axAllowed()) {
        const asked = askForAccessibility();
        if (asked !== "skipped") log.info("accessibility", { result: asked, for: session.id });
      } else if (opts.locked) hidden = true;
      else {
        const result = await gui.sendToIde(session.id, text, transcript, opts.userTypingNow);
        log.info("ide route", { sessionId: session.id, result });
        if (result === "sent") return { via: "ide" };
        if (result === "unconfirmed") return { via: "ide", submitted: false };
        hidden = hidden || result === "locked";
        noPanel = result === "not-found";
        // Someone's draft, the editor in use, the tab not open, or anything unexpected: the inbox, below.
      }
    }
  }
  if (!session.socketPath) {
    if (hidden) throw new DeliveryError("Unlock your Mac to send to the Claude app");
    if (opts.preferTyping && noPanel) throw new OpenEditorPanel();
    throw new DeliveryError("this session has no inbox socket Relay can reach");
  }
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

/** Per session, the text the helper typed and could not get submitted. */
const leftUnsent = new Map<string, string>();

/** The prompt was submitted at the Mac, so no copy of ours is waiting any more. */
export function clearLeftUnsent(sessionId: string): void {
  leftUnsent.delete(sessionId);
}

/** Whether the prompt holds exactly this message and nothing else: a copy of it left unsent, not someone's draft. */
function isThisMessage(draft: string, text: string): boolean {
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  return squash(text) !== "" && squash(draft) === squash(text);
}

/** The prompt's text after typing, when the route can show it (tmux, iTerm2); undefined for `relay shell`. */
async function promptAfterTyping(
  session: SessionRecord,
  route: TerminalRoute,
  ops: TypeOps,
): Promise<string | null | undefined> {
  if (route === "pty") return undefined;
  const read = await routesFor(session, typeWire(ops))
    .find((r) => r.kind === route)
    ?.read();
  return read?.screen == null ? null : promptDraft(read.screen);
}

async function pressEnter(session: SessionRecord, route: TerminalRoute, ops: TypeOps): Promise<boolean> {
  try {
    const found = routesFor(session, typeWire(ops)).find((r) => r.kind === route);
    const ready = found ? await found.probe() : null;
    return ready ? await ready.key("enter") : false;
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
  if (after === undefined || holdsMessage(after, text)) {
    log.warn("typed message still unsent", { sessionId: session.id, route });
    return false;
  }
  return null;
}

/**
 * A tab's text has no attributes, so the grey suggestion is told from typing by what the prompt showed when the
 * session went idle, or by no key pressed at this Mac since the prompt was submitted.
 */
function plainOpts(sessionId: string, route: { plainText?: boolean }, ops: TypeOps): PromptOptions {
  if (!route.plainText) return {};
  const seen = suggestionSeenOf(sessionId);
  const known = suggestionKnownOf(sessionId);
  const typed = draftKept.get(sessionId);
  return {
    ...(typed === undefined ? {} : { typed }),
    noKeySincePrompt: ops.noKeySincePrompt?.(sessionId) === true,
    ...(seen === undefined ? {} : { seen }),
    ...(known === undefined ? {} : { known }),
  };
}

/** What a `/model` left on the screen: nothing to answer, the cache question answered, or some other question. */
export type ModelSwitchAnswer = "none" | "confirmed" | "other";

const MODEL_QUESTION = /^\s*Switch model\?\s*$/m;
const MODEL_QUESTION_YES = /^\s*(?:❯\s*)?1\.\s+Yes, switch to (.+?)\s*$/m;
const MODEL_DONE = /^\s*⎿\s+(?:Set|Kept) model/m;
/** Any list Claude Code asks to be answered with Enter: a picker, a trust or permission question. */
const ASKING = /Enter to (?:confirm|save|select)|Esc to cancel/;

/** Whether the question's model (`Sonnet 5.5`) is the one asked for (`sonnet`, `claude-sonnet-5-5`, `sonnet[1m]`). */
function sameModel(asked: string, shown: string): boolean {
  const wanted = asked.trim().toLowerCase();
  if (wanted === "default") return /\(default\)\s*$/i.test(shown);
  const family = shown.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return family !== "" && wanted.includes(family);
}

function countModelResults(screen: string): number {
  return [...screen.matchAll(new RegExp(MODEL_DONE.source, "gm"))].length;
}

/** How many `Set model` / `Kept model` lines the session's screen shows now; read before `/model` is typed. */
export async function modelResultsOnScreen(
  session: SessionRecord,
  ops: TypeOps = defaultTypeOps,
): Promise<number> {
  for (const route of routesFor(session, typeWire(ops))) {
    const screen = (await route.read().catch(() => null))?.screen;
    if (screen != null) return countModelResults(screen);
  }
  return 0;
}

/** Accepts Claude Code's "Switch model?" for the very model asked; any other question is left ("other"). */
export async function confirmModelSwitch(
  session: SessionRecord,
  route: DeliveryRoute,
  model: string,
  ops: TypeOps = defaultTypeOps,
  resultsBefore = 0,
  waitMs = MODEL_QUESTION_WAIT_MS,
): Promise<ModelSwitchAnswer> {
  const sleep = ops.sleep;
  if (!sleep) return "none";
  const found = routesFor(session, typeWire(ops)).find((r) => r.kind === route);
  if (!found) return "none";
  const until = Date.now() + waitMs;
  for (;;) {
    const screen = (await found.read())?.screen;
    if (screen == null) return "none";
    // Only the bottom of the screen: the history may hold an answered question.
    const tail = screen.trimEnd().split("\n").slice(-14).join("\n");
    if (MODEL_QUESTION.test(tail)) {
      const yes = MODEL_QUESTION_YES.exec(tail);
      if (!yes?.[1] || !sameModel(model, yes[1])) return "other";
      const ready = await found.probe();
      if (!ready || !(await ready.key("enter").catch(() => false))) return "other";
      return "confirmed";
    }
    if (ASKING.test(tail)) return "other";
    // Earlier switches stay in the history: only a result that wasn't on the screen before typing counts.
    if (countModelResults(screen) > resultsBefore || Date.now() >= until) return "none";
    await sleep(MODEL_QUESTION_POLL_MS);
  }
}

/** How long `/model` is watched for its question, and how often the screen is read meanwhile. */
const MODEL_QUESTION_WAIT_MS = 3000;
const MODEL_QUESTION_POLL_MS = 250;

/**
 * Types into the session's own terminal at once; null when none is reachable. A draft the person typed is stashed
 * first (Claude Code brings it back by itself when the message is sent); a route that can't stash types after it.
 */
async function typeIntoTerminal(
  session: SessionRecord,
  text: string,
  opts: DeliverOptions,
  ops: TypeOps,
): Promise<{ route: TerminalRoute; partial?: true } | null> {
  for (const route of routesFor(session, typeWire(ops))) {
    const ready = await route.probe();
    if (!ready) continue;
    const draft = ready.screen === null ? null : promptDraft(ready.screen, plainOpts(session.id, route, ops));
    // The same message sent again while its unsent copy sits there: press Enter for that copy, don't type another.
    // On a plain-text tab only text we left counts: Enter doesn't submit Claude's suggestion.
    const shown = route.plainText
      ? ready.screen !== null && leftUnsent.get(session.id) === text
        ? promptDraft(ready.screen)
        : null
      : draft;
    if (shown && isThisMessage(shown, text) && (await ready.key("enter").catch(() => false))) {
      return { route: route.kind };
    }
    if (draft && opts.terminalOnly) throw new DraftInPrompt("there is text in the prompt");
    let body = text;
    if (draft) {
      if (await stashed(session, route, ready, ops)) {
        if (route.plainText) draftKept.set(session.id, draft.replace(/\s+/g, " ").trim());
      } else body = afterBreak(text);
    }
    if (route.plainText) phoneTyped.set(session.id, text.replace(/\s+/g, " ").trim());
    const outcome = await ready.type(body);
    if (outcome === "sent") return { route: route.kind };
    if (outcome === "partial") return { route: route.kind, partial: true };
    log.info("typing failed", { sessionId: session.id, route: route.kind });
  }
  return null;
}

/**
 * Presses the stash key and checks that the prompt is empty after it (a Claude Code without the key, or a lost key,
 * leaves the draft there, and the message would run into it). A route with no screen to read is taken at its word.
 */
async function stashed(
  session: SessionRecord,
  route: ReplyRoute,
  ready: ReplyReady,
  ops: TypeOps,
): Promise<boolean> {
  if (!(await ready.key("stash").catch(() => false))) return false;
  await (ops.sleep ?? Bun.sleep)(STASH_SETTLE_MS);
  const after = await route.read().catch(() => null);
  if (after?.screen == null) return true;
  return promptDraft(after.screen, plainOpts(session.id, route, ops)) === null;
}

/** Claude Code takes the stash key before the keys that follow it. */
const STASH_SETTLE_MS = 150;

/** Per session, the draft a stash put back in a tab that can't tell it from a suggestion: it is typed text. */
const draftKept = new Map<string, string>();

export function clearDraftKept(sessionId: string): void {
  draftKept.delete(sessionId);
  phoneTyped.delete(sessionId);
}

/** Per session, the last message the phone typed into a tab; its own submit must not forget the kept draft. */
const phoneTyped = new Map<string, string>();

/** Any submit but the phone's own sends or replaces the person's draft: it is no longer typed text to tell apart. */
export function draftSubmitted(sessionId: string, prompt: string): void {
  const sent = prompt.replace(/\s+/g, " ").trim();
  const own = phoneTyped.get(sessionId) === sent;
  phoneTyped.delete(sessionId);
  if (!own) draftKept.delete(sessionId);
}

type KeyName = "enter" | "escape" | "stash";

/** What a route does with a message: typed whole, typed in part (text went in, then a step failed), or not at all. */
type TypeOutcome = "sent" | "partial" | "failed";

/** A route whose session is reachable and whose Claude Code is in front; only then can it type or press a key. */
interface ReplyReady {
  /** The prompt's screen; null when it can't be read. */
  screen: string | null;
  type(text: string): Promise<TypeOutcome>;
  key(key: KeyName): Promise<boolean>;
}

/** One way into a session's own terminal. */
interface ReplyRoute {
  kind: TerminalRoute;
  /** The screen has no attributes, so a suggestion can't be told from typing without the keyboard's idle time. */
  plainText: boolean;
  /** Ready when the session is reachable here and Claude Code is the program in front; null otherwise. */
  probe(): Promise<ReplyReady | null>;
  /** The screen alone, without the in-front check; null when this route has none to read. */
  read(): Promise<{ screen: string | null } | null>;
}

/** The transports the routes use. TypeOps and KeyOps each fill the ones they have; a missing one fails closed. */
interface Wire {
  ptyType?: TypeOps["pty"];
  ptyKey?(socketPath: string, token: string, pid: number, key: KeyName): Promise<TypeReply>;
  tmuxScreen?: TypeOps["tmuxScreen"];
  tmuxType?(socket: string, pane: string, text: string): Promise<void>;
  tmuxKey?(socket: string, pane: string, key: KeyName): Promise<void>;
  tmuxPaneTty?: TypeOps["tmuxPaneTty"];
  paneScreen?: TypeOps["paneScreen"];
  paneType?: TypeOps["paneType"];
  paneKey?(target: PaneTarget, key: KeyName): Promise<void>;
  paneInfo?: TypeOps["paneInfo"];
  tabRoutes(termProgram: string | null): TypingRoute[];
  tabPeek?: TypeOps["peek"];
  tabType?: TypeOps["type"];
  tabKey?(route: TypingRoute, tty: string, key: KeyName): Promise<boolean>;
  ttyOf: TypeOps["ttyOf"];
  viewerTtyOf?: TypeOps["viewerTtyOf"];
  wrapperTtysOf?(pid: number): Promise<WrapperTty[]>;
  inFront(pid: number, tty: string | null, others?: number[]): Promise<boolean>;
}

/** One wire per delivery attempt: its checks share one `ps` snapshot and the tty tmux told with the screen. */
function typeWire(ops: TypeOps): Wire {
  let snapshot: Promise<Proc[]> | undefined;
  const procs: Procs = () => (snapshot ??= snapshotProcs());
  const seen: PaneTtys = new Map();
  return {
    ptyType: ops.pty,
    ptyKey: (socketPath, token, pid, key) =>
      key === "enter" && ops.enterPty
        ? ops.enterPty(socketPath, token, pid)
        : Promise.reject(new DeliveryError("no such key")),
    tmuxScreen: (socket, pane) => ops.tmuxScreen(socket, pane, seen),
    tmuxType: ops.tmux,
    tmuxKey: async (socket, pane, key) => {
      const press = key === "enter" ? ops.tmuxEnter : key === "stash" ? ops.tmuxStash : undefined;
      if (!press) throw new DeliveryError("no such key");
      await press(socket, pane);
    },
    tmuxPaneTty:
      ops.tmuxPaneTty && ((socket, pane) => ops.tmuxPaneTty?.(socket, pane, seen) ?? Promise.resolve(null)),
    paneScreen: ops.paneScreen,
    paneType: ops.paneType,
    paneKey: async (target, key) => {
      const press = key === "enter" ? ops.paneEnter : key === "stash" ? ops.paneStash : undefined;
      if (!press) throw new DeliveryError("no such key");
      await press(target);
    },
    paneInfo: ops.paneInfo,
    tabRoutes: ops.routes,
    tabPeek: ops.peek,
    tabType: ops.type,
    tabKey: async (route, tty, key) =>
      key === "enter" && ops.enter
        ? ops.enter(route, tty)
        : key === "stash" && ops.stash
          ? ops.stash(route, tty)
          : false,
    ttyOf: (pid) => ops.ttyOf(pid, procs),
    viewerTtyOf:
      ops.viewerTtyOf && ((pid, cwd) => ops.viewerTtyOf?.(pid, cwd, procs) ?? Promise.resolve(null)),
    wrapperTtysOf: ops.wrapperTtysOf && ((pid) => ops.wrapperTtysOf?.(pid, procs) ?? Promise.resolve([])),
    inFront: (pid, tty, others) => ops.inFront(pid, tty, others, procs),
  };
}

function keyWire(ops: KeyOps): Wire {
  return {
    ptyKey: (socketPath, token, pid, key) =>
      key === "escape" ? ops.pty(socketPath, token, pid) : Promise.reject(new DeliveryError("no such key")),
    tmuxKey: async (socket, pane, key) => {
      if (key !== "escape") throw new DeliveryError("no such key");
      await ops.tmux(socket, pane);
    },
    tmuxPaneTty: ops.tmuxPaneTty,
    paneKey: async (target, key) => {
      if (key !== "escape" || !ops.pane) throw new DeliveryError("no such key");
      await ops.pane(target);
    },
    paneInfo: ops.paneInfo,
    tabRoutes: ops.routes,
    tabKey: async (route, tty, key) => (key === "escape" ? ops.app(route, tty) : false),
    ttyOf: ops.ttyOf,
    viewerTtyOf: ops.viewerTtyOf,
    wrapperTtysOf: ops.wrapperTtysOf,
    inFront: ops.inFront ?? (async () => false),
  };
}

// Which routes exist needs no I/O, so the reply and model flags can read it.
function routesFor(session: SessionRecord, wire: Wire): ReplyRoute[] {
  const routes: ReplyRoute[] = [];
  const guarded = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  if (session.ptySocket) {
    const { ptySocket: socketPath } = session;
    const token = session.ptyToken ?? "";
    const pid = session.pid ?? 0;
    routes.push({
      kind: "pty",
      plainText: false,
      read: async () => null,
      // `relay shell` checks for itself that Claude Code is in front of its terminal.
      probe: async () =>
        !session.ptyToken || !session.pid
          ? null
          : {
              screen: null,
              type: async (text) => {
                let reply: TypeReply | null = null;
                try {
                  reply = (await wire.ptyType?.(socketPath, token, pid, text)) ?? null;
                } catch {
                  // the tab is gone; try the next route
                }
                if (reply?.ok) return "sent";
                if (reply && !reply.ok && reply.reason === "typed_not_sent") return "partial";
                return "failed";
              },
              // A `relay shell` from before key requests answers bad_request (no text): the next route.
              key: (key) =>
                guarded(async () => (await wire.ptyKey?.(socketPath, token, pid, key))?.ok === true, false),
            },
    });
  }
  if (session.tmuxPane && session.tmuxSocket) {
    const { tmuxSocket: socket, tmuxPane: pane } = session;
    routes.push({
      kind: "tmux",
      plainText: false,
      read: async () => {
        const read = wire.tmuxScreen;
        const screen = read ? await guarded(() => read(socket, pane), null) : null;
        return screen === null ? null : { screen };
      },
      probe: async () => {
        const screen = wire.tmuxScreen ? await wire.tmuxScreen(socket, pane) : null;
        if (wire.tmuxScreen && screen === null) return null;
        if (!(await claudeIsInFrontInPane(session, wire))) return null;
        return {
          screen,
          type: async (text) => {
            try {
              await wire.tmuxType?.(socket, pane, text);
              return wire.tmuxType ? "sent" : "failed";
            } catch (err) {
              return err instanceof PartlyTyped ? "partial" : "failed";
            }
          },
          key: (key) =>
            guarded(async () => {
              if (!wire.tmuxKey) return false;
              await wire.tmuxKey(socket, pane, key);
              return true;
            }, false),
        };
      },
    });
  }
  const target = paneTargetOf(session);
  if (target) {
    routes.push({
      kind: target.kind,
      plainText: false,
      read: async () => {
        const read = wire.paneScreen;
        const screen = read ? await guarded(() => read(target), null) : null;
        return screen === null ? null : { screen };
      },
      probe: async () => {
        const screen = wire.paneScreen ? await wire.paneScreen(target) : null;
        if (wire.paneScreen && screen === null) return null;
        if (!(await claudeIsInPaneTerminal(session, target, wire))) return null;
        return {
          screen,
          type: async (text) => {
            if (!wire.paneType) return "failed";
            try {
              await wire.paneType(target, text);
              return "sent";
            } catch (err) {
              return err instanceof PartlyTyped ? "partial" : "failed";
            }
          },
          key: (key) =>
            guarded(async () => {
              if (!wire.paneKey) return false;
              await wire.paneKey(target, key);
              return true;
            }, false),
        };
      },
    });
  }
  for (const app of wire.tabRoutes(session.terminal)) {
    routes.push({
      kind: app,
      plainText: true,
      read: async () => {
        const peek = wire.tabPeek;
        if (!peek) return null;
        const { ttys } = await candidateTtys(session, wire);
        for (const { tty } of ttys) {
          const tab = await guarded(() => peek(app, tty), null);
          if (!tab) continue;
          foundTty.set(session.id, tty);
          return { screen: tab.screen };
        }
        return null;
      },
      probe: async () => {
        const { ttys, missing } = await candidateTtys(session, wire);
        const failed = [...missing];
        // The next tab, from `from`, that exists and has this session's Claude Code in front: the remembered tab may
        // run another session now, and a suspended Claude Code leaves the tab to vim or the shell.
        const scan = async (from: number): Promise<{ at: number; tty: string; tab: TabView } | null> => {
          for (let at = from; at < ttys.length; at++) {
            const { tty, by } = ttys[at] as (typeof ttys)[number];
            let tab: TabView = { screen: null, front: true };
            if (wire.tabPeek) {
              const peeked = await wire.tabPeek(app, tty);
              if (!peeked) {
                failed.push(`${app} has no tab on ${tty} (from the ${by})`);
                continue;
              }
              tab = peeked;
              foundTty.set(session.id, tty);
            }
            if (await claudeIsInFront(session, tty, wire)) return { at, tty, tab };
          }
          return null;
        };
        const first = await scan(0);
        if (!first) {
          if (wire.tabPeek) {
            foundTty.delete(session.id);
            log.info("no terminal tab for the session", {
              sessionId: session.id,
              pid: session.pid,
              tried: failed,
            });
          }
          return null;
        }
        return {
          screen: first.tab.screen,
          type: async (text) => ((await wire.tabType?.(app, first.tty, text)) === true ? "sent" : "failed"),
          // A key that doesn't land goes to the next tab in front, as the earlier tabs may be stale.
          key: async (key) => {
            for (let found: typeof first | null = first; found; found = await scan(found.at + 1))
              if (await guarded(async () => (await wire.tabKey?.(app, found.tty, key)) === true, false))
                return true;
            return false;
          },
        };
      },
    });
  }
  return routes;
}

/**
 * The kinds of terminal route the session has, without probing anything. A session that never named its terminal
 * is still typed into when its tab is found, but `promised` (what the reply flag says) counts tabs only for a named one.
 */
export function terminalRoutesOf(session: SessionRecord, opts: { promised?: boolean } = {}): TerminalRoute[] {
  return routesFor(session, typeWire(defaultTypeOps))
    .filter((r) => !opts.promised || !r.plainText || session.terminal !== null)
    .map((r) => r.kind);
}

/**
 * Whether the session's Claude Code is the program in front of its terminal (TypeOps.inFront). Logs when it isn't:
 * the message then goes on to the next route, the inbox at the latest.
 */
async function claudeIsInFront(
  session: SessionRecord,
  tty: string | null,
  ops: Pick<TypeOps, "inFront" | "ttyOf" | "viewerTtyOf" | "wrapperTtysOf">,
  what = "typing",
): Promise<boolean> {
  let front = session.pid ? await ops.inFront(session.pid, tty, knownPids()).catch(() => false) : false;
  // A tab that isn't the process's own terminal (the one it was typed into before, or its viewer's) is this
  // session's only while its viewer is still there: another session may run in it now, in a background host too.
  if (front && tty !== null && session.pid && ops.viewerTtyOf) {
    const own = await ops.ttyOf(session.pid).catch(() => null);
    if (own !== tty) {
      const wrapped = await ops.wrapperTtysOf?.(session.pid).catch(() => []);
      if (!wrapped?.some((w) => w.tty === tty)) {
        const viewer = await ops.viewerTtyOf(session.pid, session.cwd).catch(() => null);
        front = viewer === tty;
      }
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
  ops: Pick<TypeOps, "ttyOf" | "viewerTtyOf" | "wrapperTtysOf">,
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
  if (session.pid && ops.wrapperTtysOf)
    for (const w of await ops.wrapperTtysOf(session.pid).catch(() => [])) add(w.tty, w.by);
  add(foundTty.get(session.id) ?? null, "earlier tab");
  if (session.pid && ops.viewerTtyOf) {
    const viewer = await ops.viewerTtyOf(session.pid, session.cwd).catch(() => null);
    add(viewer, "attached tab");
  }
  return { ttys, missing };
}

/** The route a message to this session would be typed through right now, without typing; null when there is none. */
export async function typingRouteFor(
  session: SessionRecord,
  ops: TypeOps = defaultTypeOps,
): Promise<TerminalRoute | null> {
  for (const route of routesFor(session, typeWire(ops)))
    if (await route.probe().catch(() => null)) return route.kind;
  return null;
}

/** How long after the Stop a look can still be taken as what the prompt showed when the session went idle. */
const SEEN_WITHIN_MS = 15_000;

/** Claude Code's suggested next message on screen: null when none, undefined when the screen can't be read. Quiet. */
export async function readSuggestion(
  session: SessionRecord,
  ops: TypeOps = defaultTypeOps,
): Promise<string | null | undefined> {
  try {
    for (const route of routesFor(session, typeWire(ops))) {
      const read = await route.read();
      if (!read) continue;
      if (read.screen === null) return undefined;
      if (route.plainText) {
        const text = promptTextRead(read.screen);
        // Only a look soon after the Stop, in a turn whose prompt never held text, can be the suggestion; typing
        // within those few seconds can't be told from it.
        const stoppedAt = untypedStopAt(session.id);
        if (
          text !== undefined &&
          stoppedAt !== undefined &&
          (ops.now ?? Date.now)() - stoppedAt <= SEEN_WITHIN_MS
        )
          noteSuggestionSeen(session.id, text, (ops.now ?? Date.now)());
      }
      const suggestion = promptSuggestionRead(read.screen, plainOpts(session.id, route, ops));
      if (suggestion) noteSuggestionKnown(session.id, suggestion);
      return suggestion;
    }
  } catch {
    // the screen can't be read right now
  }
  return undefined;
}

/** Whether the session's prompt line holds text right now (a tab only); undefined when it can't be read. Quiet. */
export async function readPromptHoldsText(
  session: SessionRecord,
  ops: TypeOps = defaultTypeOps,
  known?: string,
): Promise<boolean | undefined> {
  try {
    for (const route of routesFor(session, typeWire(ops))) {
      if (!route.plainText) return undefined;
      const read = await route.read();
      if (!read) continue;
      return read.screen === null ? undefined : promptHoldsText(read.screen, known);
    }
  } catch {
    // the screen can't be read right now
  }
  return undefined;
}

/** What Claude reads when the phone's Stop goes through the inbox (session.interrupt). */
export const STOP_TEXT = "Stop what you're doing now and wait for my next message.";
export const STOP_MESSAGE = `${PHONE_PREFIX}\n${STOP_TEXT}`;

export type EscapeRoute = TerminalRoute;

/** The transports `pressEscape` uses; tests swap them. */
export interface KeyOps {
  pty(socketPath: string, token: string, pid: number): Promise<TypeReply>;
  tmux(socket: string, pane: string): Promise<void>;
  /** A WezTerm pane or kitty window. */
  pane?(target: PaneTarget): Promise<void>;
  paneInfo?(target: PaneTarget): Promise<PaneInfo | null>;
  /** As in TypeOps: when present, Esc goes to the pane only if Claude Code is in front there. */
  tmuxPaneTty?(socket: string, pane: string): Promise<string | null>;
  inFront(pid: number, tty: string | null, others?: number[]): Promise<boolean>;
  routes(termProgram: string | null): TypingRoute[];
  app(route: TypingRoute, tty: string): Promise<boolean>;
  ttyOf(pid: number | null): Promise<string | null>;
  viewerTtyOf?(pid: number, cwd: string): Promise<string | null>;
  wrapperTtysOf?(pid: number): Promise<WrapperTty[]>;
}

export const defaultKeyOps: KeyOps = {
  pty: (socketPath, token, pid) => requestPty(socketPath, { token, pid, key: "escape" }),
  tmux: tmuxEscape,
  pane: paneEscape,
  paneInfo,
  tmuxPaneTty,
  inFront: claudeInFront,
  routes: (t) => platform.typing.routes(t),
  app: (route, tty) => platform.typing.key(route, tty, "escape"),
  ttyOf,
  viewerTtyOf: (pid, cwd) => viewerTtyOf(pid, cwd),
  wrapperTtysOf: (pid) => wrapperTtysOf(pid),
};

/** Presses Esc in the session's terminal; ignores `preferTyping` and the activity rules. Returns the route, or null. */
export async function pressEscape(
  session: SessionRecord,
  ops: KeyOps = defaultKeyOps,
): Promise<EscapeRoute | null> {
  for (const route of routesFor(session, keyWire(ops))) {
    const ready = await route.probe().catch(() => null);
    if (ready && (await ready.key("escape"))) return pressed(session, route.kind);
  }
  return null;
}

/** Notes the Esc, so a message sent right after it waits (ESC_SETTLE_MS). */
function pressed(session: SessionRecord, route: EscapeRoute): EscapeRoute {
  lastEscape.set(session.id, Date.now());
  return route;
}

/** Asks `relay shell` to type `text` at once; a draft in its prompt is stashed first. */
export function typeIntoPty(
  socketPath: string,
  token: string,
  pid: number,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<TypeReply> {
  return requestPty(socketPath, { token, text, pid, force: true }, opts.timeoutMs);
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
export async function ttyOf(pid: number | null, procs?: Procs): Promise<string | null> {
  if (!pid) return null;
  if (procs) return fullTty((await procs()).find((p) => p.pid === pid)?.tty ?? "");
  const proc = Bun.spawn(["ps", "-o", "tty=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return fullTty(out);
}

export type WrapperTty = { tty: string; by: string };

/** The terminals of the wrappers `pid` runs under, nearest first (see `wrapperTtys`). */
export async function wrapperTtysOf(pid: number, procs?: Procs): Promise<WrapperTty[]> {
  return wrapperTtys(procs ? await procs() : await snapshotProcs(), pid);
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
  snapshot?: Procs,
): Promise<string | null> {
  const procs = snapshot ? await snapshot() : parseProcs(await sh(PS_SNAPSHOT_ARGS), true);
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
async function tmuxScreen(socket: string, pane: string, seen?: PaneTtys): Promise<string | null> {
  // With `seen`, the same tmux call prints the pane's tty on a first line (tmux turns control characters into "_" without a UTF-8 locale).
  const args = ["tmux", "-S", socket];
  if (seen) args.push("display-message", "-p", "-t", pane, "#{pane_tty}", ";");
  args.push("capture-pane", "-p", "-e", "-t", pane);
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  if (!seen) return out;
  const nl = out.indexOf("\n");
  seen.set(`${socket}\0${pane}`, out.slice(0, nl < 0 ? out.length : nl).trim() || null);
  return nl < 0 ? "" : out.slice(nl + 1);
}

/** The tty of a pane's terminal (`#{pane_tty}`), or null when tmux can't tell. */
async function tmuxPaneTty(socket: string, pane: string, seen?: PaneTtys): Promise<string | null> {
  const known = seen?.get(`${socket}\0${pane}`);
  if (known !== undefined) return known;
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

async function tmuxPaneInMode(socket: string, pane: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "-S", socket, "display-message", "-p", "-t", pane, "#{pane_in_mode}"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) throw new DeliveryError("tmux display-message failed");
  return out === "1";
}

/** Keys sent to a pane in a mode (copy mode after a scroll) go to the mode, not the program: leave it first. */
async function tmuxLeaveMode(socket: string, pane: string): Promise<void> {
  if (!(await tmuxPaneInMode(socket, pane))) return;
  const proc = Bun.spawn(["tmux", "-S", socket, "send-keys", "-t", pane, "-X", "cancel"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  await proc.exited;
  // A mode that -X cancel doesn't end (the tree chooser, the clock) can't be typed into.
  if (await tmuxPaneInMode(socket, pane)) throw new DeliveryError("tmux pane is in a mode");
}

export async function tmuxType(socket: string, pane: string, text: string): Promise<void> {
  await tmuxLeaveMode(socket, pane);
  let typed = false;
  for (const step of tmuxTypeSteps(socket, pane, text)) {
    if (step.waitMs) await Bun.sleep(step.waitMs);
    const proc = Bun.spawn(step.args, {
      stdin: step.stdin === undefined ? "ignore" : new Blob([step.stdin]),
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: CHILD_PATH },
    });
    const code = await proc.exited;
    const msg = `tmux ${step.args[3]} failed (${code})`;
    if (code !== 0) throw typed ? new PartlyTyped(msg) : new DeliveryError(msg);
    if (step.args[3] === "send-keys" || step.args[3] === "paste-buffer") typed = true;
  }
}

async function tmuxEnter(socket: string, pane: string): Promise<void> {
  await tmuxLeaveMode(socket, pane);
  const proc = Bun.spawn(["tmux", "-S", socket, "send-keys", "-t", pane, "Enter"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const code = await proc.exited;
  if (code !== 0) throw new DeliveryError(`tmux send-keys failed (${code})`);
}

async function tmuxStash(socket: string, pane: string): Promise<void> {
  await tmuxLeaveMode(socket, pane);
  const proc = Bun.spawn(["tmux", "-S", socket, "send-keys", "-t", pane, "C-s"], {
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
  await tmuxLeaveMode(socket, pane);
  const proc = Bun.spawn(tmuxEscapeArgs(socket, pane), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: CHILD_PATH },
  });
  const code = await proc.exited;
  if (code !== 0) throw new DeliveryError(`tmux send-keys failed (${code})`);
}

import { CHILD_PATH } from "../config.ts";
import { errMessage, log } from "../log.ts";
import { runsInBackground } from "./background.ts";
import type { HookReply } from "./broker.ts";
import type { PermissionRequestInput } from "./decisions.ts";
import { redact } from "./redact.ts";
import type { Registry, SessionRecord } from "./registry.ts";

/** Continues a session without a terminal (`session.resume`): `claude --resume` over stream-json pipes, permissions via Relay prompts. */

export class ResumeError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** The pipes of the Claude Code process the helper owns; tests swap in a fake. */
export interface HeadlessChild {
  pid: number;
  stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export type HeadlessSpawn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => HeadlessChild;

const spawnClaude: HeadlessSpawn = (cmd, opts) =>
  Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

/** How long a resumed Claude Code may take to announce itself before the request fails. */
export const INIT_TIMEOUT_MS = 45_000;

/** How the owned process is started: a stream-json conversation that asks for permissions over the same pipes. */
export function resumeCommand(claudeBin: string, sessionId: string): string[] {
  return [
    claudeBin,
    "-p",
    "--resume",
    sessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
  ];
}

/** One user message as the stream-json input wants it. */
export function userLine(text: string, uuid: string = crypto.randomUUID()): string {
  return `${JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } })}\n`;
}

/** The decision of a `can_use_tool` answer, from what the broker would print for a PermissionRequest hook. */
export function decisionFrom(stdout: string, input: Record<string, unknown>): Record<string, unknown> {
  try {
    const decision = (JSON.parse(stdout) as { hookSpecificOutput?: { decision?: Record<string, unknown> } })
      .hookSpecificOutput?.decision;
    if (decision?.behavior === "allow") return { updatedInput: input, ...decision };
    if (decision?.behavior === "deny")
      return { message: "The user denied this from their phone.", ...decision };
  } catch {
    // No decision: below.
  }
  // Closed elsewhere, expired or superseded: there is no terminal dialog to fall back to, so Claude must be told.
  return { behavior: "deny", message: "Nobody answered this request." };
}

export interface HeadlessDeps {
  registry: Registry;
  claudeBin: string | null | undefined;
  /** Opens a Relay prompt for a permission request; settles with what the hook would print. Aborting closes it. */
  openPrompt(input: PermissionRequestInput, signal: AbortSignal): Promise<HookReply>;
  spawn?: HeadlessSpawn;
  initTimeoutMs?: number;
  /** Tells the phone why a chat stopped on its own. */
  notice?(sessionId: string, text: string): void;
  /** The session's open turn, and how it ends as failed (`text` replaces the transcript's answer when given). */
  turns?: { openId(sessionId: string): string | null; fail(turnId: string, text?: string): void };
  /** How long a `result` with `is_error` waits for Claude Code's own StopFailure hook before the helper ends the turn. */
  errorGraceMs?: number;
  /** The clock (ms); tests move it. */
  now?: () => number;
  /** How long a process with nothing going on may sit before it is stopped. */
  idleMs?: number;
  /** How often the one timer looks at every process. */
  checkMs?: number;
}

/** How long an owned process may sit with no message and nothing running before the helper stops it. */
export const IDLE_STOP_MS = 60 * 60_000;
/** How often the processes are looked at for idleness. */
export const IDLE_CHECK_MS = 60_000;

/** How long a `result` with `is_error` waits for the StopFailure hook, which reports the turn itself. */
export const ERROR_GRACE_MS = 3_000;

interface Owned {
  child: HeadlessChild;
  abort: AbortController;
  /** One per permission request still open, by request_id. */
  requests: Map<string, AbortController>;
  /** A Stop waiting for the turn to end, by its interrupt's request_id; settled by `control_response` or `result`. */
  turnEnded: Map<string, () => void>;
  /** Set once this process sent a `command_lifecycle` line: from then on a message counts as delivered only when named. */
  confirms: boolean;
  /** Messages written and not named yet, by uuid; each runs when the process names it or ends. */
  unnamed: Map<string, (named: boolean) => void>;
  /** The check after a `result` with `is_error`, until it runs. */
  errorTimer?: ReturnType<typeof setTimeout>;
  /** When anything last happened: the start, a message written, a line from the process. */
  lastActive: number;
  /** When the newest scheduled wake-up is due (ms); the process is left alone until then. */
  wakeupDue: number;
  /** Scheduled jobs the process made and didn't delete: it is never stopped while any exists. */
  crons: number;
}

/** How long a Stop waits for the process to end its turn before the process itself is ended. */
export const INTERRUPT_TIMEOUT_MS = 5_000;

export class HeadlessSessions {
  private readonly owned = new Map<string, Owned>();
  /** Chats being handed to another process: their copy going away (even by a failed interrupt) doesn't end them. */
  private readonly handingOver = new Set<string>();

  private idleTimer?: ReturnType<typeof setInterval>;
  /** Whether something outside this class keeps the session busy (a send being delivered, a queued reply, a prompt, background work). */
  busy: (sessionId: string) => boolean = () => false;

  constructor(private readonly d: HeadlessDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Stops every process that has sat idle for `idleMs`; the chat stays listed and its next message continues it. */
  stopIdle(): string[] {
    const stopped: string[] = [];
    const idleMs = this.d.idleMs ?? IDLE_STOP_MS;
    const now = this.now();
    for (const [id, entry] of [...this.owned]) {
      if (this.holdsWork(id, entry)) continue;
      if (now - Math.max(entry.lastActive, entry.wakeupDue) < idleMs) continue;
      log.info("headless session idle; stopping it", { sessionId: id });
      stopped.push(id);
      // The chat is kept before the process goes, so no moment shows it as ended.
      this.d.registry.keepOpen(id, entry.child.pid);
      this.drop(id, entry, false, true);
    }
    return stopped;
  }

  /** Whether an open turn, a prompt, an unanswered message, scheduled work or a task running elsewhere keeps the process. */
  private holdsWork(id: string, entry: Owned): boolean {
    return (
      this.d.turns?.openId(id) != null ||
      entry.requests.size > 0 ||
      // Without lifecycle lines a message counts as read once written, and the hour counts from it.
      (entry.confirms && entry.unnamed.size > 0) ||
      entry.turnEnded.size > 0 ||
      entry.errorTimer !== undefined ||
      entry.crons > 0 ||
      this.handingOver.has(id) ||
      runsInBackground(id) ||
      this.busy(id)
    );
  }

  private startIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.stopIdle(), this.d.checkMs ?? IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer && this.owned.size === 0) clearInterval(this.idleTimer);
    if (this.owned.size === 0) this.idleTimer = undefined;
  }

  /** Whether the helper runs this session's Claude Code process. */
  has(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }

  /** The pid of the process the helper runs for this session, when it does. */
  pidOf(sessionId: string): number | null {
    return this.owned.get(sessionId)?.child.pid ?? null;
  }

  /** Stops the process and closes its prompts without ending the session: another process took the chat over. */
  release(sessionId: string): void {
    const entry = this.owned.get(sessionId);
    if (entry) this.drop(sessionId, entry, false, true);
    this.handingOver.delete(sessionId);
  }

  /** Marks the chat as being handed over, so the process ending before `release` doesn't show it as ended. */
  holdStatus(sessionId: string): void {
    if (this.owned.has(sessionId)) this.handingOver.add(sessionId);
  }

  /** Starts the process for `session` and sends `text` as its first message; `onWritten` runs once the text is on stdin. */
  async resume(
    session: SessionRecord,
    text: string,
    onWritten?: () => void,
    onLost?: () => void,
  ): Promise<void> {
    const id = session.id;
    if (!text.trim()) throw new ResumeError("bad_request", "Write a message to continue the session with.");
    // Taken before the first await: two requests at once never start two copies.
    if (this.owned.has(id)) throw new ResumeError("conflict", "This session already runs in Relay.");
    if (!this.d.claudeBin) throw new ResumeError("unavailable", "Claude Code wasn't found on this computer.");
    const env: Record<string, string | undefined> = { ...process.env, PATH: CHILD_PATH };
    // The session keeps reporting through Relay's hooks, so its turns appear like any other's.
    delete env.RELAY_INTERNAL;
    let child: HeadlessChild;
    try {
      child = (this.d.spawn ?? spawnClaude)(resumeCommand(this.d.claudeBin, id), { cwd: session.cwd, env });
    } catch (err) {
      log.warn("session.resume: launch failed", { err: errMessage(err) });
      throw new ResumeError("unavailable", "Claude Code couldn't be started.");
    }
    const entry: Owned = {
      child,
      abort: new AbortController(),
      requests: new Map(),
      turnEnded: new Map(),
      confirms: false,
      unnamed: new Map(),
      lastActive: this.now(),
      wakeupDue: 0,
      crons: 0,
    };
    this.owned.set(id, entry);
    this.startIdleTimer();
    this.d.registry.clearKeptOpen(id);
    const init = this.watch(id, entry);
    try {
      const uuid = this.write1(entry, text);
      let written = false;
      const wrote = () => {
        if (!written) onWritten?.();
        written = true;
      };
      const named = this.naming(entry, uuid);
      void named.then((ok) => ok && wrote());
      await init;
      // Claude Code names a message as it reads it; one that never sends such lines is taken as read once it starts.
      if (entry.confirms) {
        if (!(await named))
          throw new ResumeError("unavailable", "Claude Code stopped before it got the message.");
      } else {
        wrote();
        void named.then((ok) => {
          if (!ok) onLost?.();
        });
      }
    } catch (err) {
      this.drop(id, entry);
      throw err;
    }
    // Tells the session list the session now runs here and is working.
    this.d.registry.setStatus(id, "working");
  }

  /**
   * Writes a later message to the owned process and settles once Claude Code names it, even while an earlier turn runs.
   * Without `command_lifecycle` lines it settles on the write; `onLost` then runs if the process ends before naming it.
   */
  async send(sessionId: string, text: string, onLost?: () => void): Promise<void> {
    const entry = this.owned.get(sessionId);
    if (!entry) throw new ResumeError("unavailable", "This session doesn't run in Relay.");
    const stopped = new ResumeError("unavailable", "Claude Code stopped before it got the message.");
    let named: Promise<boolean>;
    try {
      named = this.naming(entry, this.write1(entry, text));
    } catch (err) {
      log.warn("headless send failed", { err: errMessage(err) });
      throw stopped;
    }
    entry.lastActive = this.now();
    this.d.registry.setStatus(sessionId, "working");
    if (entry.confirms) {
      if (!(await named)) throw stopped;
    } else {
      void named.then((ok) => {
        if (!ok) onLost?.();
      });
    }
  }

  /** Writes one user line and returns its uuid. */
  private write1(entry: Owned, text: string): string {
    const uuid = crypto.randomUUID();
    entry.child.stdin.write(userLine(text, uuid));
    entry.child.stdin.flush();
    return uuid;
  }

  /** Settles true when Claude Code names the uuid, false when the process ends first. */
  private naming(entry: Owned, uuid: string): Promise<boolean> {
    return new Promise((resolve) => entry.unnamed.set(uuid, resolve));
  }

  /** Stop: sends an `interrupt`; a process that doesn't end the turn in time is killed. Resolves "interrupted" or "ended". */
  async interrupt(sessionId: string, timeoutMs = INTERRUPT_TIMEOUT_MS): Promise<"interrupted" | "ended"> {
    const entry = this.owned.get(sessionId);
    if (!entry) throw new ResumeError("unavailable", "This session doesn't run in Relay.");
    const requestId = `relay-stop-${crypto.randomUUID()}`;
    let finish = () => {};
    const over = new Promise<"interrupted">((resolve) => {
      finish = () => resolve("interrupted");
      entry.turnEnded.set(requestId, finish);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      entry.child.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`,
      );
      entry.child.stdin.flush();
    } catch (err) {
      entry.turnEnded.delete(requestId);
      log.warn("headless interrupt failed", { err: errMessage(err) });
      this.drop(sessionId, entry);
      return "ended";
    }
    const late = new Promise<"ended">((resolve) => {
      timer = setTimeout(() => resolve("ended"), timeoutMs);
    });
    const outcome = await Promise.race([over, late]);
    clearTimeout(timer);
    entry.turnEnded.delete(requestId);
    if (outcome === "ended") {
      log.warn("headless session ignored the interrupt; ending it", { sessionId });
      this.drop(sessionId, entry);
    }
    return outcome;
  }

  /** Stops every process the helper owns (the daemon is exiting). */
  stopAll(): void {
    for (const [id, entry] of [...this.owned]) this.drop(id, entry);
    this.stopIdleTimer();
  }

  /** Reads stdout until it ends; resolves on `system`/`init`, rejects on early exit or timeout. */
  private watch(id: string, entry: Owned): Promise<void> {
    const { child } = entry;
    let errText = "";
    const stderrDone = drain(child.stderr, (chunk) => {
      errText = (errText + chunk).slice(-2000);
    });
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new ResumeError("unavailable", "Claude Code didn't answer, so the session wasn't continued."));
      }, this.d.initTimeoutMs ?? INIT_TIMEOUT_MS);
      const failEarly = (why: string) => {
        clearTimeout(timer);
        if (!ready) reject(new ResumeError("unavailable", why));
      };
      let buffer = "";
      void drain(child.stdout, (chunk) => {
        buffer += chunk;
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let msg: StreamMessage;
          try {
            msg = JSON.parse(line) as StreamMessage;
          } catch {
            continue;
          }
          if (!msg) continue;
          entry.lastActive = this.now();
          this.noteScheduling(entry, msg);
          this.noteNamed(entry, msg);
          if (msg.type === "system" && msg.subtype === "init" && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          } else if (msg.type === "result") {
            for (const done of [...entry.turnEnded.values()]) done();
            if (msg.is_error === true) this.resultFailed(id, entry, msg.result);
          } else if (msg.type === "control_response") {
            const rid = msg.response?.request_id;
            if (rid) entry.turnEnded.get(rid)?.();
          } else if (msg.type === "control_request") {
            void this.controlRequest(id, entry, msg);
          } else if (msg.type === "control_cancel_request" && msg.request_id) {
            // Claude Code settled the request itself (answered elsewhere, or the turn was interrupted).
            entry.requests.get(msg.request_id)?.abort();
          }
        }
      });
      void child.exited.then(async (code) => {
        for (const settle of entry.unnamed.values()) settle(false);
        entry.unnamed.clear();
        const mine = this.owned.get(id) === entry;
        log.info("headless session exited", { sessionId: id, code });
        // A stop Relay asked for (or a handover) took the process out of `owned` first, or marked the chat.
        const byItself = mine && ready && !this.handingOver.has(id);
        const openTurn = byItself ? this.d.turns?.openId(id) : null;
        if (mine) this.drop(id, entry, true);
        const why = firstLine(errText);
        failEarly(
          why
            ? `Claude Code couldn't continue the session: ${why}`
            : "Claude Code stopped before it answered.",
        );
        if (!byItself) return;
        // The last stderr lines may still be in the pipe.
        await Promise.race([stderrDone, Bun.sleep(200)]);
        const last = lastLine(errText);
        this.d.notice?.(id, last ? `Claude Code stopped: ${last}` : "Claude Code stopped by itself.");
        if (openTurn) this.d.turns?.fail(openTurn);
      });
    });
  }

  /**
   * A turn that stopped on an API error ends as a `result` with `is_error`. Claude Code's StopFailure hook usually
   * reports it, and then the turn is closed; when it hasn't by the time this runs, the helper does.
   */
  private resultFailed(id: string, entry: Owned, result: unknown): void {
    const turnId = this.d.turns?.openId(id);
    if (!turnId) return;
    clearTimeout(entry.errorTimer);
    entry.errorTimer = setTimeout(() => {
      entry.errorTimer = undefined;
      if (this.owned.get(id) !== entry || this.d.turns?.openId(id) !== turnId) return;
      const said = typeof result === "string" ? redact(result).trim() : "";
      this.d.turns.fail(turnId, said || undefined);
      this.d.notice?.(id, said ? said.slice(0, 500) : "Claude Code stopped on an error.");
    }, this.d.errorGraceMs ?? ERROR_GRACE_MS);
  }

  /** A scheduled wake-up or job the process makes keeps it running (`ScheduleWakeup`, `CronCreate`, `CronDelete`). */
  private noteScheduling(entry: Owned, msg: StreamMessage): void {
    if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) return;
    for (const part of msg.message.content) {
      if (part?.type !== "tool_use") continue;
      const input = (part.input ?? {}) as { delaySeconds?: unknown; stop?: unknown };
      if (part.name === "ScheduleWakeup") {
        if (input.stop === true) entry.wakeupDue = 0;
        else if (typeof input.delaySeconds === "number")
          entry.wakeupDue = this.now() + input.delaySeconds * 1000;
      } else if (part.name === "CronCreate") entry.crons += 1;
      else if (part.name === "CronDelete") entry.crons = Math.max(0, entry.crons - 1);
    }
  }

  /** What Claude Code names as read: a `command_lifecycle` line, the user message echoed back, or a `result` for it. */
  private noteNamed(entry: Owned, msg: StreamMessage): void {
    const uuids: string[] = [];
    if (msg.type === "system" && msg.subtype === "command_lifecycle") {
      // Other states say nothing about whether it was read.
      if (msg.state !== "queued" && msg.state !== "started") return;
      entry.confirms = true;
      if (msg.command_uuid) uuids.push(msg.command_uuid);
    } else if (msg.type === "user" && msg.uuid) uuids.push(msg.uuid);
    else if (msg.type === "result" && Array.isArray(msg.user_message_uuids))
      for (const u of msg.user_message_uuids) if (typeof u === "string") uuids.push(u);
    for (const u of uuids) {
      const settle = entry.unnamed.get(u);
      if (settle) {
        entry.unnamed.delete(u);
        settle(true);
      }
    }
  }

  /** A permission request from the process: a Relay prompt, answered on the phone (or by its expiry). */
  private async controlRequest(id: string, entry: Owned, msg: StreamMessage): Promise<void> {
    const request = msg.request;
    const requestId = msg.request_id;
    if (!requestId) return;
    if (request?.subtype !== "can_use_tool" || typeof request.tool_name !== "string") {
      // A request this helper doesn't know: say so, so Claude Code isn't left waiting.
      this.write(entry, { subtype: "error", request_id: requestId, error: "not supported by Relay" });
      return;
    }
    const input = (request.input ?? {}) as Record<string, unknown>;
    const own = new AbortController();
    entry.requests.set(requestId, own);
    let reply: HookReply;
    try {
      reply = await this.d.openPrompt(
        {
          session_id: id,
          tool_name: request.tool_name,
          tool_input: input,
          ...(Array.isArray(request.permission_suggestions)
            ? { permission_suggestions: request.permission_suggestions }
            : {}),
        },
        AbortSignal.any([entry.abort.signal, own.signal]),
      );
    } finally {
      if (entry.requests.get(requestId) === own) entry.requests.delete(requestId);
    }
    // Cancelled by Claude Code: the request no longer exists, so nothing is answered.
    if (own.signal.aborted) return;
    if (this.owned.get(id) !== entry) return;
    this.write(entry, {
      subtype: "success",
      request_id: requestId,
      response: decisionFrom(reply.stdout, input),
    });
  }

  private write(entry: Owned, response: Record<string, unknown>): void {
    try {
      entry.child.stdin.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      entry.child.stdin.flush();
    } catch (err) {
      log.warn("headless answer failed", { err: errMessage(err) });
    }
  }

  /** Forgets the process, closes its prompts, and stops it unless it has exited already. */
  private drop(id: string, entry: Owned, exited = false, keepStatus = false): void {
    if (this.owned.get(id) === entry) this.owned.delete(id);
    this.stopIdleTimer();
    entry.abort.abort();
    clearTimeout(entry.errorTimer);
    if (!exited) {
      try {
        entry.child.stdin.end();
      } catch {
        // already closed
      }
      try {
        entry.child.kill();
      } catch {
        // already gone
      }
    }
    // The session ended with its process; the list says so (and stops saying it runs here).
    const s = this.d.registry.get(id);
    if (keepStatus || this.handingOver.has(id)) this.d.registry.publish(id);
    else if (s && s.status !== "ended")
      this.d.registry.setStatus(id, "ended", { endReason: exited ? "closed" : "stopped" });
    else this.d.registry.publish(id);
  }
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  request_id?: string;
  uuid?: string;
  state?: string;
  command_uuid?: string;
  user_message_uuids?: unknown;
  is_error?: unknown;
  result?: unknown;
  response?: { subtype?: string; request_id?: string };
  message?: { content?: { type?: string; name?: string; input?: unknown }[] };
  request?: {
    subtype?: string;
    tool_name?: unknown;
    input?: unknown;
    permission_suggestions?: unknown;
  };
}

async function drain(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }));
  } catch {
    // The pipe closed.
  }
}

/** Claude Code's own words for why it stopped, one short line. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 200);
}

/** The last thing Claude Code printed to stderr, redacted, one short line. */
function lastLine(text: string): string {
  const lines = redact(text)
    .split("\n")
    .filter((l) => l.trim());
  return (lines.at(-1) ?? "").trim().slice(0, 200);
}

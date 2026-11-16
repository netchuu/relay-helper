import { CHILD_PATH } from "../config.ts";
import { errMessage, log } from "../log.ts";
import type { HookReply } from "./broker.ts";
import type { PermissionRequestInput } from "./decisions.ts";
import type { Registry, SessionRecord } from "./registry.ts";

/**
 * Continuing a session whose terminal is closed (`session.resume`): the conversation is still on disk, so the helper
 * starts `claude --resume` without a terminal, speaking Claude Code's stream-json protocol on its pipes, and keeps
 * that process. Each later message is one JSON line on its stdin. Permission requests arrive on its stdout
 * (`can_use_tool`) and are answered through Relay's own prompts.
 *
 * The stream-json control protocol is Claude Code's, not a documented API: a process that doesn't answer is
 * stopped and the request fails with a plain sentence.
 */

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
    "--permission-prompt-tool",
    "stdio",
  ];
}

/** One user message as the stream-json input wants it. */
export function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
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
}

interface Owned {
  child: HeadlessChild;
  abort: AbortController;
  /** One per permission request still open, by request_id. */
  requests: Map<string, AbortController>;
  /** A Stop waiting for the process to end the turn, by the request_id of its interrupt. Settled by the matching
   * `control_response` (what Claude Code sends for an interrupt) or by a `result` line. */
  turnEnded: Map<string, () => void>;
}

/** How long a Stop waits for the process to end its turn before the process itself is ended. */
export const INTERRUPT_TIMEOUT_MS = 5_000;

export class HeadlessSessions {
  private readonly owned = new Map<string, Owned>();

  constructor(private readonly d: HeadlessDeps) {}

  /** Whether the helper runs this session's Claude Code process. */
  has(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }

  /** The pid of the process the helper runs for this session, when it does. */
  pidOf(sessionId: string): number | null {
    return this.owned.get(sessionId)?.child.pid ?? null;
  }

  /** Starts the process for `session` and sends `text` as its first message. */
  async resume(session: SessionRecord, text: string): Promise<void> {
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
    const entry: Owned = { child, abort: new AbortController(), requests: new Map(), turnEnded: new Map() };
    this.owned.set(id, entry);
    const init = this.watch(id, entry);
    try {
      child.stdin.write(userLine(text));
      child.stdin.flush();
      await init;
    } catch (err) {
      this.drop(id, entry);
      throw err;
    }
    // Tells the session list the session now runs here and is working.
    this.d.registry.setStatus(id, "working");
  }

  /** Writes a later message to the owned process. */
  async send(sessionId: string, text: string): Promise<void> {
    const entry = this.owned.get(sessionId);
    if (!entry) throw new ResumeError("unavailable", "This session doesn't run in Relay.");
    try {
      entry.child.stdin.write(userLine(text));
      entry.child.stdin.flush();
    } catch (err) {
      log.warn("headless send failed", { err: errMessage(err) });
      throw new ResumeError("unavailable", "Claude Code stopped before it got the message.");
    }
    this.d.registry.setStatus(sessionId, "working");
  }

  /**
   * Stop: asks the owned process to end its current turn (stream-json `interrupt` control request) and waits for
   * it to report the turn over. A process that doesn't within the timeout is ended instead, so a Stop never
   * leaves the session working. Resolves "interrupted", or "ended" when the process had to go.
   */
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
  }

  /**
   * Reads the process's stdout until it ends. Resolves when Claude Code announces itself (`system`/`init`); rejects
   * when it exits first or says nothing within the timeout.
   */
  private watch(id: string, entry: Owned): Promise<void> {
    const { child } = entry;
    let errText = "";
    void drain(child.stderr, (chunk) => {
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
          if (msg.type === "system" && msg.subtype === "init" && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          } else if (msg.type === "result") {
            for (const done of [...entry.turnEnded.values()]) done();
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
      void child.exited.then((code) => {
        const mine = this.owned.get(id) === entry;
        log.info("headless session exited", { sessionId: id, code });
        if (mine) this.drop(id, entry, true);
        const why = firstLine(errText);
        failEarly(
          why
            ? `Claude Code couldn't continue the session: ${why}`
            : "Claude Code stopped before it answered.",
        );
      });
    });
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
  private drop(id: string, entry: Owned, exited = false): void {
    if (this.owned.get(id) === entry) this.owned.delete(id);
    entry.abort.abort();
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
    if (s && s.status !== "ended") this.d.registry.setStatus(id, "ended");
    else this.d.registry.publish(id);
  }
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  request_id?: string;
  response?: { subtype?: string; request_id?: string };
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

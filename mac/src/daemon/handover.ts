import { log } from "../log.ts";
import { hostIdOf } from "../shell/ptyHost.ts";
import type { HookEnv, Registry } from "./registry.ts";
import type { TerminalLauncher } from "./terminalHost.ts";

/** Stops Relay's copy of a phone chat once the person resumes it in their own terminal, so two `claude` never share a transcript. */
export class Handover {
  /** The socket of the copy each moved chat left: its late hooks (a Stop, the SessionEnd) are not the chat's. */
  private readonly left = new Map<string, { pty?: string; pid?: number }>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly d: {
      registry: Registry;
      terminal: TerminalLauncher;
      /** The phone's Stop for a chat that works or waits; absent in tests that don't need it. */
      stop?: (sessionId: string) => Promise<unknown>;
      /** The id of the chat's open turn, if any. */
      openTurn?: (sessionId: string) => string | null;
      /** The processes the helper runs itself (headless.ts). */
      headless?: {
        has(sessionId: string): boolean;
        pidOf(sessionId: string): number | null;
        release(sessionId: string): void;
        holdStatus(sessionId: string): void;
      };
    },
  ) {}

  /** Whether a hook came from the copy that was stopped. */
  fromLeftCopy(sessionId: string, env: HookEnv): boolean {
    const left = this.left.get(sessionId);
    if (!left) return false;
    if (left.pty !== undefined) return env.pty === left.pty;
    return left.pid !== undefined && env.claudePid === left.pid;
  }

  /** Settles when a handover of this chat that is running has finished; sends wait on it so they reach the new route. */
  settled(sessionId: string): Promise<void> {
    const run = this.running.get(sessionId);
    // A macrotask later, so the hook that triggered it has stored the new terminal's route first.
    return run ? run.then(() => new Promise((resolve) => setTimeout(resolve, 0))) : Promise.resolve();
  }

  /** Stops Relay's copy when this hook comes from another process in the person's own terminal. Never throws. */
  async resumed(sessionId: string, env: HookEnv): Promise<void> {
    const session = this.d.registry.get(sessionId);
    const ownPid = this.d.headless?.has(sessionId) ? this.d.headless.pidOf(sessionId) : null;
    if (session && ownPid !== null) {
      // Without a pid on the hook there is no telling the helper's copy from another one: leave it running.
      if (typeof env.claudePid !== "number" || env.claudePid === ownPid) return;
      return this.track(sessionId, this.moveHeadless(sessionId, session.status, ownPid));
    }
    const socket = session?.ptySocket;
    if (!session || !socket || !session.ptyToken || (env.pty ?? null) === socket) return;
    const id = hostIdOf(socket);
    if (id === null) return;
    await this.track(
      sessionId,
      this.move(sessionId, session.status, id, socket, session.ptyToken, session.pid ?? 0),
    );
  }

  private async track(sessionId: string, run: Promise<void>): Promise<void> {
    this.running.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.running.get(sessionId) === run) this.running.delete(sessionId);
    }
  }

  private async moveHeadless(sessionId: string, status: string, pid: number): Promise<void> {
    log.info("chat continued in the person's terminal", { sessionId });
    this.left.set(sessionId, { pid });
    this.d.headless?.holdStatus(sessionId);
    const turnBefore = this.d.openTurn?.(sessionId) ?? null;
    if (status === "working" || status === "waiting") {
      try {
        await this.d.stop?.(sessionId);
      } catch (err) {
        log.warn("handover: stop", { err: String(err) });
      }
    }
    this.d.registry.markMoved(sessionId);
    this.d.headless?.release(sessionId);
    this.settleStatus(sessionId, turnBefore);
  }

  private async move(
    sessionId: string,
    status: string,
    id: string,
    socket: string,
    token: string,
    pid: number,
  ): Promise<void> {
    log.info("chat continued in the person's terminal", { sessionId });
    this.left.set(sessionId, { pty: socket });
    const turnBefore = this.d.openTurn?.(sessionId) ?? null;
    // Esc ends the turn while the copy is still the chat's route; a dead host or a refusal changes nothing below.
    if (status === "working" || status === "waiting") {
      try {
        await this.d.stop?.(sessionId);
      } catch (err) {
        log.warn("handover: stop", { err: String(err) });
      }
    }
    this.d.registry.markMoved(sessionId);
    await this.d.terminal
      .close({ id, socket, token, pid })
      .catch((err) => log.warn("handover: close", { err: String(err) }));
    this.settleStatus(sessionId, turnBefore);
  }

  private settleStatus(sessionId: string, turnBefore: string | null): void {
    const after = this.d.registry.get(sessionId)?.status;
    // A turn the new terminal opened meanwhile is its own: only the copy's leftover turn goes idle.
    const turnNow = this.d.openTurn?.(sessionId) ?? null;
    if ((after === "working" || after === "waiting") && (turnNow === null || turnNow === turnBefore))
      this.d.registry.setStatus(sessionId, "idle", { keepUpdatedAt: true });
  }
}

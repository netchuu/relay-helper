import type { Presence, PresenceMode } from "../../../protocol/index.ts";
import { platform } from "../platform/index.ts";
import { type DB, getSetting, setSetting } from "./db.ts";
import type { EventLog } from "./events.ts";

/**
 * Are you at the Mac? Used to decide whether to push to the phone and whether free text may be typed
 * into a tmux pane. Prompts never depend on it: the terminal dialog and the phone always race.
 */
/** The mode until someone picks one on the phone. */
export const DEFAULT_PRESENCE_MODE: PresenceMode = "away";

export class PresenceMonitor {
  private state: Presence;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Local typing seen through UserPromptSubmit counts as presence for a short while. */
  private lastLocalActivity = 0;

  constructor(
    private readonly db: DB,
    private readonly events: EventLog,
    private readonly idleAwaySeconds: number,
  ) {
    // "away" unless someone picked a mode on the phone: every prompt and finished turn is pushed, so people know
    // first and look at the phone, also while they're at the computer. "auto" (no push
    // while you're active at the Mac) and "here" stay in the phone's menu.
    const mode = getSetting<PresenceMode>(db, "presence.mode", DEFAULT_PRESENCE_MODE);
    this.state = {
      mode,
      present: mode !== "away",
      idleSeconds: 0,
      locked: false,
    };
  }

  start(intervalMs = 5000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(): Presence {
    return { ...this.state };
  }

  /** Applies immediately (no waiting for the next poll), so a following `session.send` sees it. */
  async setMode(mode: PresenceMode): Promise<Presence> {
    setSetting(this.db, "presence.mode", mode);
    await this.poll(mode);
    return this.get();
  }

  noteLocalActivity(): void {
    this.lastLocalActivity = Date.now();
    if (!this.state.present && this.state.mode === "auto") this.update({ ...this.state, present: true });
  }

  async poll(mode: PresenceMode = this.state.mode): Promise<void> {
    const reading = await platform.presence.read({ tmuxSockets: liveTmuxSockets(this.db) });
    const locked = reading.locked ?? false;
    const recentlyTyped = Date.now() - this.lastLocalActivity < this.idleAwaySeconds * 1000;
    // Unknown idle time (a Linux server with no desktop, no attached tmux and no login terminal) counts
    // as away: a needless push is better than a prompt nobody sees.
    const idle = reading.idleSeconds;
    const present =
      mode === "here" ||
      (mode === "auto" && !locked && ((idle !== null && idle < this.idleAwaySeconds) || recentlyTyped));
    // -1 tells clients the idle time is unknown; the wire format stays a plain number.
    this.update({ mode, present, idleSeconds: idle === null ? -1 : Math.round(idle), locked });
  }

  private update(next: Presence): void {
    const changed =
      next.present !== this.state.present ||
      next.mode !== this.state.mode ||
      next.locked !== this.state.locked;
    this.state = next;
    if (changed) this.events.emit({ type: "presence.changed", presence: this.get() });
  }
}

/** tmux servers that live sessions run in; their client activity tells whether someone is typing. */
export function liveTmuxSockets(db: DB): string[] {
  return db
    .query<{ tmux_socket: string }, []>(
      "SELECT DISTINCT tmux_socket FROM sessions WHERE status != 'ended' AND tmux_socket IS NOT NULL",
    )
    .all()
    .map((r) => r.tmux_socket);
}

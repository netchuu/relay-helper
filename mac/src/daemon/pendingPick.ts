// Phone picks made while Claude works, kept in memory until the session is idle.
export interface Picks {
  model?: string;
  effort?: string;
}

export class PendingPicks {
  private readonly picks = new Map<string, Picks>();
  private readonly refusals = new Map<string, string>();

  set(sessionId: string, kind: keyof Picks, value: string): void {
    this.picks.set(sessionId, { ...this.picks.get(sessionId), [kind]: value });
    this.refusals.delete(sessionId);
  }

  get(sessionId: string): Picks {
    return this.picks.get(sessionId) ?? {};
  }

  /** Sessions with a pick waiting. */
  ids(): string[] {
    return [...this.picks.keys()];
  }

  /** One kind, or all of the session's picks. */
  clear(sessionId: string, kind?: keyof Picks): void {
    const left = kind ? { ...this.picks.get(sessionId), [kind]: undefined } : {};
    if (left.model === undefined && left.effort === undefined) this.picks.delete(sessionId);
    else this.picks.set(sessionId, left);
  }

  refuse(sessionId: string, message: string): void {
    this.refusals.set(sessionId, message);
  }

  /** The refusal the next session update carries. */
  refusal(sessionId: string): string | undefined {
    return this.refusals.get(sessionId);
  }

  clearRefusal(sessionId: string): void {
    this.refusals.delete(sessionId);
  }
}

export const pendingPicks = new PendingPicks();

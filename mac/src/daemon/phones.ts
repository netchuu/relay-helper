/** Counts the phones connected now (over the local API or the relay), and tells when the first one arrives. */
export class Phones {
  private count = 0;
  private readonly listeners = new Set<() => void>();

  get connected(): boolean {
    return this.count > 0;
  }

  /** A phone connected; the returned function is called when it goes. */
  join(): () => void {
    this.count++;
    if (this.count === 1) for (const fn of this.listeners) fn();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.count--;
    };
  }

  /** Called whenever a phone connects while none was. */
  onFirst(fn: () => void): void {
    this.listeners.add(fn);
  }
}

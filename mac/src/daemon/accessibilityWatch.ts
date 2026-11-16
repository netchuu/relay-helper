/** Re-announces sessions when Accessibility is granted or revoked, so the phone's `replyFix` hint updates. */
export function watchAccessibility(opts: {
  /** Whether the helper may use Accessibility now (axAllowed). */
  check: () => boolean;
  /** Called once per change, after the first reading. */
  onChange: (allowed: boolean) => void;
  everyMs?: number;
}): () => void {
  let last: boolean | null = null;
  const tick = () => {
    let now: boolean;
    try {
      now = opts.check();
    } catch {
      return;
    }
    if (last !== null && now !== last) opts.onChange(now);
    last = now;
  };
  tick();
  const timer = setInterval(tick, opts.everyMs ?? 10_000);
  return () => clearInterval(timer);
}

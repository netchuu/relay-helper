/**
 * Re-announces sessions when macOS Accessibility is allowed or taken away for the helper. The phone's hint "Replies
 * here arrive marked as from another session. To send them as you, allow Relay in Accessibility on your Mac." comes
 * from each session's `replyFix`, worked out when a session update goes out; nothing sent one when only the
 * permission changed, so the hint would stay after it was allowed.
 */
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

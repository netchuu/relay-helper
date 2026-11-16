/** How long a test waits for something to happen before it gives up. Generous: a busy machine is slow, not wrong. */
export const WAIT_MS = 30_000;

/** Polls `fn` until truthy up to `ms`; on timeout throws with `what` and `detail()`. A throwing `fn` counts as "not yet". */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  ms: number = WAIT_MS,
  what = "the condition",
  detail?: () => string | Promise<string>,
): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch {
      // not ready yet
    }
    if (Date.now() >= end) break;
    await Bun.sleep(10);
  }
  let extra = "";
  if (detail) extra = `\n${await Promise.resolve(detail()).catch((e) => `(no detail: ${e})`)}`;
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${extra}`);
}

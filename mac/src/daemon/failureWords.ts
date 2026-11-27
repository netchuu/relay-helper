import type { Usage, UsageLimit } from "../../../protocol/index.ts";
import { redact } from "./redact.ts";
import { head } from "./text.ts";

const LINES: Record<string, string> = {
  authentication_failed: "Claude Code isn't signed in on your computer. Run /login there.",
  oauth_org_not_allowed: "Your organization doesn't allow this account in Claude Code.",
  account_on_hold: "Your Claude account is on hold.",
  verification_required: "Claude Code needs you to verify your account on your computer.",
  billing_error: "Claude Code hit a billing problem. Check your plan or credits.",
  overloaded: "Claude is overloaded right now. Try again in a moment.",
  server_error: "Claude's servers had an error. Try again in a moment.",
  model_not_found: "This model isn't available. Pick another model.",
  max_output_tokens: "The answer was cut off at the output limit.",
  cloud_credential_error: "Your cloud provider's sign-in failed on your computer.",
};

/** The limit that stopped the turn: one at 100%, else the most used. */
function hitLimit(usage: Partial<Pick<Usage, "fiveHour" | "sevenDay">> | undefined): UsageLimit | undefined {
  const full = [usage?.fiveHour, usage?.sevenDay].filter(
    (l): l is UsageLimit => l !== undefined && l.usedPercent >= 100,
  );
  if (full.length) return full.reduce((a, b) => ((b.resetsAt ?? 0) > (a.resetsAt ?? 0) ? b : a));
  const all = [usage?.fiveHour, usage?.sevenDay].filter((l): l is UsageLimit => l !== undefined);
  return all.reduce<UsageLimit | undefined>(
    (a, b) => (a && a.usedPercent >= b.usedPercent ? a : b),
    undefined,
  );
}

function resetTime(at: number, now: number, timeZone?: string): string {
  const opts = { timeZone } as const;
  const time = new Date(at).toLocaleTimeString("en-US", { ...opts, hour: "numeric", minute: "2-digit" });
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { ...opts });
  if (day(at) === day(now)) return `at ${time}`;
  const weekday = new Date(at).toLocaleDateString("en-US", { ...opts, weekday: "long" });
  return `${weekday} at ${time}`;
}

/** What a failed turn says, from Claude Code's StopFailure `error`. */
export function failureLine(
  error: string | undefined,
  details: string,
  usage?: Partial<Pick<Usage, "fiveHour" | "sevenDay">>,
  now = Date.now(),
  timeZone?: string,
): string {
  const known = error ? LINES[error] : undefined;
  if (known) return known;
  if (error === "rate_limit") {
    const at = hitLimit(usage)?.resetsAt;
    return at === undefined
      ? "You've hit your usage limit."
      : `You've hit your usage limit. It resets ${resetTime(at, now, timeZone)}.`;
  }
  const detail = head(redact(details).trim(), 400);
  if (error === "invalid_request")
    return detail ? `The request was refused: ${detail}` : "The request was refused.";
  return detail ? `The turn failed: ${detail}` : "The turn failed.";
}

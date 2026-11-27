import { expect, test } from "bun:test";
import { failureLine } from "../src/daemon/failureWords.ts";

const NOW = Date.UTC(2026, 10, 27, 10, 0);
const at = (h: number, m = 0, day = 27) => Date.UTC(2026, 10, day, h, m);

test("every StopFailure value has its line", () => {
  const lines: Record<string, string> = {
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
  for (const [error, line] of Object.entries(lines)) expect(failureLine(error, "API Error: 500")).toBe(line);
});

test("rate_limit names the reset time from the status line", () => {
  const usage = { fiveHour: { usedPercent: 100, resetsAt: at(15, 45) } };
  expect(failureLine("rate_limit", "", usage, NOW, "UTC")).toBe(
    "You've hit your usage limit. It resets at 3:45 PM.",
  );
  expect(failureLine("rate_limit", "", undefined)).toBe("You've hit your usage limit.");
  expect(failureLine("rate_limit", "", { fiveHour: { usedPercent: 40 } })).toBe(
    "You've hit your usage limit.",
  );
});

test("rate_limit prefers the full limit and names the day when it isn't today", () => {
  const usage = {
    fiveHour: { usedPercent: 30, resetsAt: at(12) },
    sevenDay: { usedPercent: 100, resetsAt: at(9, 0, 30) },
  };
  expect(failureLine("rate_limit", "", usage, NOW, "UTC")).toBe(
    "You've hit your usage limit. It resets Monday at 9:00 AM.",
  );
});

test("rate_limit with no full limit names the most used one", () => {
  const usage = {
    fiveHour: { usedPercent: 12, resetsAt: at(15) },
    sevenDay: { usedPercent: 99, resetsAt: at(9, 0, 30) },
  };
  expect(failureLine("rate_limit", "", usage, NOW, "UTC")).toBe(
    "You've hit your usage limit. It resets Monday at 9:00 AM.",
  );
});

test("invalid_request, unknown and new values keep the details, redacted", () => {
  expect(failureLine("invalid_request", "bad tool schema")).toBe("The request was refused: bad tool schema");
  expect(failureLine("invalid_request", "")).toBe("The request was refused.");
  expect(failureLine("unknown", "boom")).toBe("The turn failed: boom");
  expect(failureLine("brand_new", "boom")).toBe("The turn failed: boom");
  expect(failureLine(undefined, "")).toBe("The turn failed.");
  expect(failureLine("unknown", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain(
    "abcdefghijklmnopqrstuvwxyz",
  );
});

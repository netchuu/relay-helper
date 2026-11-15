import { beforeEach, expect, test } from "bun:test";
import { noteUsage, parseUsage, resetUsage, usageOf } from "../src/daemon/usage.ts";

beforeEach(() => resetUsage());

const five = (usedPercent: number, resetsAt?: number) => ({
  fiveHour: { usedPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) },
});

test("parseUsage accepts a window without resets_at", () => {
  expect(parseUsage({ rate_limits: { five_hour: { used_percentage: 95 } } })).toEqual(five(95));
});

test("a limit without a reset time goes down when the window starts over", () => {
  noteUsage("a", five(95));
  noteUsage("a", five(2));
  expect(usageOf("a")?.fiveHour?.usedPercent).toBe(2);
  expect(usageOf("a", Date.now() + 7 * 24 * 3600 * 1000)?.fiveHour?.usedPercent).toBe(2);
});

test("a reading without a reset time replaces a kept one whose reset has passed", () => {
  noteUsage("a", five(95, Date.now() - 1000));
  noteUsage("a", five(2));
  expect(usageOf("a")?.fiveHour).toEqual({ usedPercent: 2 });
});

test("an idle second session sending its older reading again changes nothing", () => {
  noteUsage("a", five(95));
  noteUsage("b", five(95));
  noteUsage("a", five(2));
  expect(usageOf("b")?.fiveHour?.usedPercent).toBe(2);
  expect(noteUsage("b", five(95))).toBe(false);
  expect(usageOf("a")?.fiveHour?.usedPercent).toBe(2);
});

test("a stale reading with a reset time still changes nothing", () => {
  const later = Date.now() + 3600_000;
  noteUsage("a", five(10, later));
  noteUsage("b", five(50, later - 1000));
  expect(usageOf("a")?.fiveHour).toEqual({ usedPercent: 10, resetsAt: later });
});

test("a context-only payload does not make an idle session forget its limit", () => {
  noteUsage("a", five(95));
  noteUsage("b", five(95));
  noteUsage("a", five(2));
  noteUsage("b", { contextLeftPercent: 50 });
  noteUsage("b", five(95));
  expect(usageOf("b")?.fiveHour?.usedPercent).toBe(2);
  expect(usageOf("a")?.fiveHour?.usedPercent).toBe(2);
});

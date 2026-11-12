import { expect, test } from "bun:test";
import { watchAccessibility } from "../src/daemon/accessibilityWatch.ts";

// The phone's "allow Relay in Accessibility" hint should go away by itself once it's allowed:
// a change in the permission re-announces the sessions.

test("a change is reported once, both ways; no change, nothing; the first reading is only remembered", async () => {
  const readings = [false, false, true, true, false];
  let i = 0;
  const seen: boolean[] = [];
  const stop = watchAccessibility({
    check: () => readings[Math.min(i++, readings.length - 1)] as boolean,
    onChange: (a) => seen.push(a),
    everyMs: 5,
  });
  await Bun.sleep(60);
  stop();
  expect(seen).toEqual([true, false]);
});

test("a check that throws is skipped, not reported", async () => {
  let n = 0;
  const seen: boolean[] = [];
  const stop = watchAccessibility({
    check: () => {
      n++;
      if (n === 2) throw new Error("tcc");
      return n >= 3;
    },
    onChange: (a) => seen.push(a),
    everyMs: 5,
  });
  await Bun.sleep(40);
  stop();
  expect(seen).toEqual([true]);
});

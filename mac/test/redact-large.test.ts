import { expect, test } from "bun:test";
import { redact } from "../src/daemon/redact.ts";
import { stepFor } from "../src/daemon/steps.ts";

const svg = `M${"1.5-2.25.75-3".repeat(2400)}`; // ~30 KB, no spaces
const b64url = "aB3_-".repeat(20000); // 100 KB

function ms(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

test("Write with a long unbroken run stays fast and keeps its label", () => {
  let label = "";
  const t = ms(() => {
    label = stepFor("Write", { file_path: "/p/a.svg", content: svg }, "/p", "done").label;
  });
  expect(t).toBeLessThan(50);
  expect(label).toBe("Edited a.svg");
});

test("Edit with long old and new strings stays fast", () => {
  let label = "";
  const t = ms(() => {
    label = stepFor(
      "Edit",
      { file_path: "/p/a.svg", old_string: svg, new_string: `${svg}1` },
      "/p",
      "live",
    ).label;
  });
  expect(t).toBeLessThan(50);
  expect(label).toBe("Editing a.svg");
});

test("redact stays fast on long unbroken runs", () => {
  expect(ms(() => redact(b64url))).toBeLessThan(50);
  expect(ms(() => redact(svg.repeat(1) + svg.slice(0, 10000)))).toBeLessThan(50);
});

test("redact still handles assignments with name prefixes and suffixes", () => {
  expect(redact("MY_API_KEY=s3cr3t-value-123")).toBe("MY_API_KEY=[redacted:secret-assignment]");
  expect(redact('"clientSecret": "s3cr3t-value-123"')).toBe('"clientSecret": "[redacted:secret-assignment]"');
  expect(redact("db.password_hash: s3cr3t-value-123")).toBe("db.password_hash: [redacted:secret-assignment]");
});

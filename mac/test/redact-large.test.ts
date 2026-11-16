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

test("redact stays fast on repeated secret words, flags and URL-like runs", () => {
  expect(ms(() => redact("secret_".repeat(10000)))).toBeLessThan(50);
  expect(ms(() => redact("token-api_key ".repeat(5000)))).toBeLessThan(50);
  expect(ms(() => redact("a.b+c-".repeat(10000)))).toBeLessThan(50);
  expect(ms(() => redact(`curl ${"-u x ".repeat(5000)}`))).toBeLessThan(100);
  expect(ms(() => redact(`mysql ${"mysql ".repeat(5000)}`))).toBeLessThan(100);
  expect(ms(() => redact(`https://${"a".repeat(50000)}`))).toBeLessThan(50);
  expect(ms(() => redact(`x://a:${"@".repeat(50000)}`))).toBeLessThan(50);
  expect(ms(() => redact(`--token ${"-token ".repeat(5000)}`))).toBeLessThan(100);
});

test("a long unbroken run of dashes stays linear", () => {
  redact("warm up --token abcdef123");
  expect(redact("-".repeat(20000))).toBe("-".repeat(20000));
  expect(ms(() => redact("-".repeat(20000)))).toBeLessThan(100);
  expect(ms(() => redact(`--${"a-".repeat(10000)}`))).toBeLessThan(100);
  expect(ms(() => redact(`--${"auth-".repeat(5000)}`))).toBeLessThan(100);
  expect(ms(() => stepFor("Bash", { command: `echo ${"-".repeat(20000)}` }, "/p", "live"))).toBeLessThan(100);
  const t1 = ms(() => redact("-".repeat(10000)));
  const t2 = ms(() => redact("-".repeat(40000)));
  expect(t2).toBeLessThan(Math.max(t1 * 12, 20));
});

test("flags with secrets are still redacted", () => {
  for (const s of [
    "--token abcdef123456",
    "--password=hunter2hunter2",
    "--api-key abcdef123456",
    "--my-long-prefix-token abcdef123456",
  ]) {
    expect(redact(s)).not.toContain(String(s.split(/[ =]/)[1]));
  }
});

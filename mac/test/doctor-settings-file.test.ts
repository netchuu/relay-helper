import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countHooks, mergeHooks, relayHooks } from "../src/install.ts";

async function hooksLine(config: (dir: string) => object, settings?: (dir: string) => object) {
  const dir = mkdtempSync(join(tmpdir(), "relay-doctor-settings-"));
  mkdirSync(join(dir, ".relay"));
  mkdirSync(join(dir, ".claude"));
  mkdirSync(join(dir, "tmux"));
  if (settings) writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings(dir)));
  // relayUrl skips the Tailscale check; nothing listens on the port.
  writeFileSync(
    join(dir, ".relay", "config.json"),
    JSON.stringify({ relayUrl: "https://relay.invalid", port: 59173, ...config(dir) }),
  );
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "doctor"], {
    env: {
      HOME: dir,
      RELAY_HOME: join(dir, ".relay"),
      XDG_CONFIG_HOME: join(dir, ".config"),
      TMUX_TMPDIR: join(dir, "tmux"),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    out += decoder.decode(chunk);
    if (out.includes("hooks:") && out.endsWith("\n") && /hooks:.*\n/.test(out)) break;
  }
  proc.kill();
  await proc.exited;
  return { dir, out, line: out.split("\n").find((l) => l.includes("hooks:")) ?? "(no hooks line)" };
}

const hookBin = (dir: string) => join(dir, ".relay", "bin", "relay-hook");
const expected = Object.keys(relayHooks("/x/relay-hook")).length;

test("doctor counts the hooks in the settings file install saved", async () => {
  let other = "";
  const { line } = await hooksLine((dir) => {
    other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify(mergeHooks({}, hookBin(dir))));
    expect(countHooks(mergeHooks({}, hookBin(dir)))).toBe(expected);
    return { settingsPath: other };
  });
  expect(line).toContain(`hooks: ${expected} Relay hooks in ${other}`);
}, 30_000);

test("missing hooks in a saved file are fixed with install --settings for that file", async () => {
  let other = "";
  const { line } = await hooksLine((dir) => {
    other = join(dir, "other.json");
    writeFileSync(other, "{}");
    return { settingsPath: other };
  });
  expect(line).toContain(`0/${expected} installed in ${other}`);
  expect(line).toContain(`relay install --settings ${JSON.stringify(other)}`);
}, 30_000);

test("without a saved path, or with a relative one, doctor reads the default file", async () => {
  for (const config of [() => ({}), () => ({ settingsPath: "other.json" })]) {
    const { dir, line } = await hooksLine(config, (dir) => mergeHooks({}, hookBin(dir)));
    expect(line).toContain(`hooks: ${expected} Relay hooks in ${join(dir, ".claude", "settings.json")}`);
  }
}, 30_000);

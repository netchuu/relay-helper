import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasRelayEntries } from "../src/install.ts";
import { addRelayShell, writeZedSettings } from "../src/integrations/zed.ts";

// `relay uninstall` must go on to Zed, the service and --purge when the settings file can't be written.
// The CLI runs with --no-service: the launchd label is the same for every RELAY_HOME.

const WITH_HOOK = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/bin/relay-hook stop" }] }] } })}\n`;

function home(opts: { content: string; readOnly: boolean; saved?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "relay-uninstall-ro-"));
  mkdirSync(join(dir, "dotfiles"));
  mkdirSync(join(dir, ".claude"));
  mkdirSync(join(dir, ".relay"));
  const target = join(dir, "dotfiles", "settings.json");
  symlinkSync(target, join(dir, ".claude", "settings.json"));
  writeFileSync(target, opts.content);
  if (opts.readOnly) chmodSync(target, 0o444);
  if (opts.saved) {
    const local = join(dir, ".claude", "settings.local.json");
    writeFileSync(local, WITH_HOOK);
    writeFileSync(join(dir, ".relay", "config.json"), JSON.stringify({ settingsPath: local }));
  }
  const zed = join(dir, ".config", "zed", "settings.json");
  mkdirSync(join(dir, ".config", "zed"), { recursive: true });
  writeFileSync(zed, "{}\n");
  writeZedSettings(zed, (t) => addRelayShell(t, "/bin/relay"));
  return { dir, target, zed };
}

async function uninstall(dir: string) {
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "uninstall", "--no-service"],
    {
      env: {
        ...process.env,
        HOME: dir,
        RELAY_HOME: join(dir, ".relay"),
        XDG_CONFIG_HOME: join(dir, ".config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code: await proc.exited, out, err };
}

test("hasRelayEntries compares what Relay owns, not the objects", () => {
  expect(hasRelayEntries({})).toBe(false);
  expect(hasRelayEntries({ hooks: {} })).toBe(false);
  expect(hasRelayEntries({ statusLine: { type: "command", command: "/bin/relay-hook statusline" } })).toBe(
    true,
  );
  expect(hasRelayEntries(JSON.parse(WITH_HOOK))).toBe(true);
});

test("a read-only settings file with nothing of Relay's is left alone and uninstall succeeds", async () => {
  const { dir, zed } = home({ content: "{}\n", readOnly: true });
  const r = await uninstall(dir);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(readFileSync(zed, "utf8")).not.toContain("/bin/relay");
});

test("Relay's hooks in a read-only file: later steps run, the file is named, exit is non-zero", async () => {
  const { dir, target, zed } = home({ content: WITH_HOOK, readOnly: true });
  const r = await uninstall(dir);
  expect(r.code).toBe(1);
  expect(r.err).toContain(join(dir, ".claude", "settings.json"));
  expect(r.err).toContain("by hand");
  expect(readFileSync(zed, "utf8")).not.toContain("/bin/relay");
  expect(readFileSync(target, "utf8")).toBe(WITH_HOOK);
});

test("uninstall without --settings cleans the saved settings file", async () => {
  const { dir } = home({ content: "{}\n", readOnly: false, saved: true });
  const r = await uninstall(dir);
  expect(r.code).toBe(0);
  expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8")).not.toContain("relay-hook");
});

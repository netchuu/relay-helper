import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRelayShell,
  flatpakNoEscape,
  relayShellValue,
  removeRelayShell,
  shellState,
  type ZedEnv,
  zedChoice,
  zedLabel,
  zedSettingsPaths,
} from "../src/integrations/zed.ts";
import { PasteModeTracker, typedBytes } from "../src/shell/ptyShell.ts";

const BIN = "/Users/ana/.relay/bin/relay";

/** Zed's own loader is JSONC; for the tests, strip comments and trailing commas and JSON.parse. */
function parse(text: string): Record<string, unknown> {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^"\n]*$/gm, "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

describe("Zed settings", () => {
  test("--no-zed is remembered: an update keeps it off, a plain install sets the choice again", () => {
    expect(zedChoice(true, { noZed: false, fromUpdate: false })).toBe(true);
    expect(zedChoice(true, { noZed: true, fromUpdate: false })).toBe(false);
    expect(zedChoice(false, { noZed: false, fromUpdate: true })).toBe(false);
    expect(zedChoice(true, { noZed: false, fromUpdate: true })).toBe(true);
    expect(zedChoice(false, { noZed: false, fromUpdate: false })).toBe(true);
  });

  test("empty or missing file gets terminal.shell", () => {
    for (const before of ["", "{}", "{\n}\n"]) {
      const r = addRelayShell(before, BIN);
      expect(r.changed).toBe(true);
      expect(parse(r.text)).toEqual({
        terminal: { shell: { with_arguments: { program: BIN, args: ["shell"] } } },
      });
    }
  });

  test("keeps comments, other settings and trailing commas", () => {
    const before = `// Zed settings
{
  "theme": "One Dark", // my theme
  /* fonts */
  "buffer_font_size": 15,
}
`;
    const r = addRelayShell(before, BIN);
    expect(r.text).toContain("// my theme");
    expect(r.text).toContain("/* fonts */");
    expect(parse(r.text)).toMatchObject({
      theme: "One Dark",
      buffer_font_size: 15,
      terminal: { shell: { with_arguments: { program: BIN } } },
    });
    expect(shellState(r.text)).toBe("ours");
    // Running install again changes nothing.
    expect(addRelayShell(r.text, BIN).changed).toBe(false);
  });

  test("adds shell into an existing terminal block", () => {
    const before = `{\n  "terminal": {\n    "font_size": 13\n  }\n}\n`;
    const r = addRelayShell(before, BIN);
    expect(parse(r.text)).toEqual({
      terminal: { font_size: 13, shell: { with_arguments: { program: BIN, args: ["shell"] } } },
    });
  });

  test('"system" is Zed\'s default, so it is replaced, not treated as a custom shell', () => {
    const before = `{\n  // copied from Zed's defaults\n  "terminal": {\n    "shell": "system",\n    "font_size": 13\n  }\n}\n`;
    expect(shellState(before)).toBe("none");
    const r = addRelayShell(before, BIN);
    expect(r.changed).toBe(true);
    expect(r.state).toBe("ours");
    expect(r.text).toContain("// copied from Zed's defaults");
    expect(parse(r.text)).toEqual({
      terminal: { shell: { with_arguments: { program: BIN, args: ["shell"] } }, font_size: 13 },
    });
    expect(addRelayShell(r.text, BIN).changed).toBe(false);
  });

  test("a custom shell is left alone", () => {
    const before = `{ "terminal": { "shell": { "program": "fish" } } }`;
    const r = addRelayShell(before, BIN);
    expect(r).toEqual({ text: before, changed: false, state: "custom" });
    expect(removeRelayShell(before).changed).toBe(false);
    expect(shellState(before)).toBe("custom");
  });

  test("a moved binary is updated in place", () => {
    const before = `{ "terminal": { "shell": ${relayShellValue("/old/relay")} } }`;
    const r = addRelayShell(before, BIN);
    expect(r.changed).toBe(true);
    expect(parse(r.text)).toEqual({
      terminal: { shell: { with_arguments: { program: BIN, args: ["shell"] } } },
    });
  });

  test("uninstall removes only Relay's entry", () => {
    const original = `{\n  "theme": "One Dark",\n  "terminal": {\n    "font_size": 13\n  }\n}\n`;
    const added = addRelayShell(original, BIN).text;
    const removed = removeRelayShell(added);
    expect(removed.changed).toBe(true);
    expect(parse(removed.text)).toEqual({ theme: "One Dark", terminal: { font_size: 13 } });

    // When Relay created the terminal block, it goes away entirely.
    const fresh = addRelayShell(`{\n  "theme": "One Dark"\n}\n`, BIN).text;
    expect(parse(removeRelayShell(fresh).text)).toEqual({ theme: "One Dark" });
    // Shell as the last member, after others.
    const last = `{ "terminal": { "font_size": 13, "shell": ${relayShellValue(BIN)} }, "x": 1 }`;
    expect(parse(removeRelayShell(last).text)).toEqual({ terminal: { font_size: 13 }, x: 1 });
  });

  test("broken JSON is never rewritten", () => {
    expect(() => addRelayShell(`{ "theme": `, BIN)).toThrow();
  });
});

describe("relay shell typing", () => {
  test("bracketed paste wraps the text and keeps newlines", () => {
    expect(typedBytes("fix\nthe tests", true)).toEqual({
      body: "\x1b[200~fix\nthe tests\x1b[201~",
      enter: "\r",
    });
  });

  test("without bracketed paste a newline can't submit early", () => {
    expect(typedBytes("a\r\nb\n\nc", false).body).toBe("a b c");
  });

  test("escape characters from the phone are dropped", () => {
    expect(typedBytes("hi\x1b[201~rm -rf", true).body).toBe("\x1b[200~hi[201~rm -rf\x1b[201~");
  });

  test("paste mode follows the program's output, even split across chunks", () => {
    const t = new PasteModeTracker();
    t.feed("hello \x1b[?20");
    t.feed("04h prompt");
    expect(t.on).toBe(true);
    t.feed("\x1b[?2004l");
    expect(t.on).toBe(false);
  });
});

describe("session activity from the transcript", () => {
  test("newest entry timestamp wins, cached until the file changes", async () => {
    const { transcriptLastActivity } = await import("../src/daemon/transcript.ts");
    const { mkdtempSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const path = join(mkdtempSync(join(tmpdir(), "relay-tx-")), "s.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", timestamp: "2026-10-27T14:00:00.000Z" })}\n${JSON.stringify({ type: "assistant", timestamp: "2026-10-27T14:42:49.566Z" })}\n${JSON.stringify({ type: "summary" })}\n`,
    );
    expect(transcriptLastActivity(path)).toBe(Date.parse("2026-10-27T14:42:49.566Z"));
    appendFileSync(path, `${JSON.stringify({ type: "user", timestamp: "2026-11-03T09:00:00.000Z" })}\n`);
    expect(transcriptLastActivity(path)).toBe(Date.parse("2026-11-03T09:00:00.000Z"));
    expect(transcriptLastActivity(join(tmpdir(), "missing.jsonl"))).toBeNull();
  });
});

describe("where Zed keeps its settings", () => {
  const env = (platform: NodeJS.Platform, files: string[], apps: string[] = [], xdg?: string): ZedEnv => ({
    home: "/home/ana",
    platform,
    xdgConfigHome: xdg,
    exists: (p) => files.includes(p),
    list: (dir) => (dir === "/home/ana/.var/app" ? apps : []),
  });

  test("the normal install, on macOS and Linux", () => {
    expect(zedSettingsPaths(env("darwin", ["/Applications/Zed.app"]))).toEqual([
      "/home/ana/.config/zed/settings.json",
    ]);
    expect(zedSettingsPaths(env("linux", ["/home/ana/.local/bin/zed"]))).toEqual([
      "/home/ana/.config/zed/settings.json",
    ]);
    // Arch's package, and XDG_CONFIG_HOME, which Zed follows on Linux only.
    expect(zedSettingsPaths(env("linux", ["/usr/bin/zeditor"], [], "/home/ana/cfg"))).toEqual([
      "/home/ana/cfg/zed/settings.json",
    ]);
    expect(zedSettingsPaths(env("darwin", ["/Applications/Zed.app"], [], "/home/ana/cfg"))).toEqual([
      "/home/ana/.config/zed/settings.json",
    ]);
    expect(zedSettingsPaths(env("linux", []))).toEqual([]);
  });

  test("Zed from Flathub reads its sandbox's config folder, next to any normal install", () => {
    const paths = zedSettingsPaths(env("linux", ["/home/ana/.config/zed"], ["org.gimp.GIMP", "dev.zed.Zed"]));
    expect(paths).toEqual([
      "/home/ana/.config/zed/settings.json",
      "/home/ana/.var/app/dev.zed.Zed/config/zed/settings.json",
    ]);
    expect(paths.map(zedLabel)).toEqual(["Zed", "Zed (Flatpak)"]);
    expect(zedSettingsPaths(env("linux", [], ["dev.zed.Zed"]))).toEqual([
      "/home/ana/.var/app/dev.zed.Zed/config/zed/settings.json",
    ]);
  });

  test("a Flatpak override with ZED_FLATPAK_NO_ESCAPE is noticed", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-zed-"));
    const overrides = join(home, ".local", "share", "flatpak", "overrides");
    mkdirSync(overrides, { recursive: true });
    const settings = join(home, ".var", "app", "dev.zed.Zed", "config", "zed", "settings.json");
    const e: ZedEnv = { home, platform: "linux", exists: existsSync, list: () => [] };
    expect(flatpakNoEscape(settings, e)).toBe(false);
    writeFileSync(join(overrides, "dev.zed.Zed"), "[Environment]\nZED_FLATPAK_NO_ESCAPE=1\n");
    expect(flatpakNoEscape(settings, e)).toBe(true);
    expect(flatpakNoEscape(join(home, ".config", "zed", "settings.json"), e)).toBe(false);
  });
});

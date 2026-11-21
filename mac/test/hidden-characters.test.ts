import { describe, expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { hookOutputFor, payloadFor } from "../src/daemon/decisions.ts";
import { EventLog } from "../src/daemon/events.ts";
import { promptAlert } from "../src/daemon/notifier.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";
import { cleanName, visibleEscapes } from "../src/daemon/text.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this checks
const HIDDEN = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/;

const bash = (command: string) => {
  const tool_input = { command };
  const payload = payloadFor({ session_id: "s1", tool_name: "Bash", tool_input });
  if (payload.kind !== "permission") throw new Error("not a permission");
  return { payload, tool_input };
};

describe("a permission request shows hidden characters as escapes", () => {
  const cases: [string, string, string][] = [
    ["C0 control", "echo a\x07b", "echo a\\x07b"],
    ["escape", "printf \x1b[31mred", "printf \\x1b[31mred"],
    ["carriage return", "ls\rrm -rf x", "ls\\x0drm -rf x"],
    ["delete", "a\x7fb", "a\\x7fb"],
    ["C1 control", "a\x85b\x9bc", "a\\x85b\\x9bc"],
    ["right-to-left override", "build ‮gnp.exe", "build \\u{202E}gnp.exe"],
    ["bidi isolate", "a⁦b⁩", "a\\u{2066}b\\u{2069}"],
    ["direction marks", "a‎b‏c؜d", "a\\u{200E}b\\u{200F}c\\u{61C}d"],
    ["zero-width characters", "a​b‌c‍d﻿e", "a\\u{200B}b\\u{200C}c\\u{200D}d\\u{FEFF}e"],
  ];
  for (const [name, input, shown] of cases) {
    test(name, () => {
      const { payload } = bash(input);
      expect(payload.summary).toBe(shown);
      expect(payload.detail).not.toMatch(HIDDEN);
      expect(payload.summary).not.toMatch(HIDDEN);
    });
  }

  test("newline and tab stay", () => {
    expect(bash("a\n\tb").payload.summary).toBe("a\n\tb");
  });

  test("the detail has no hidden character either", () => {
    const { payload } = bash("x‮y\x85z");
    expect(payload.detail).not.toMatch(/[‮\x85]/);
    expect(payload.detail).toContain("\\u{202E}");
    expect(payload.detail).toContain("\\x85");
  });

  test("the notification text shows them too", () => {
    const { payload } = bash("rm ‮gnp.exe");
    const alert = promptAlert(
      { id: "p1", sessionId: "s1", status: "open", createdAt: 0, payload } as Parameters<
        typeof promptAlert
      >[0],
      "Mac",
    );
    expect(alert.body).toContain("\\u{202E}");
    expect(alert.body).not.toContain("‮");
  });

  test("the input that goes back to Claude Code is not changed", () => {
    const { tool_input } = bash("echo ‮\x1b[0m");
    expect(tool_input.command).toBe("echo ‮\x1b[0m");
    const out = JSON.parse(
      hookOutputFor("permission", tool_input, null, { kind: "permission", action: "allow" }),
    );
    expect(out.hookSpecificOutput.decision).toEqual({ behavior: "allow" });
  });

  test("visibleEscapes leaves plain text alone", () => {
    expect(visibleEscapes("ls -la ~/Projects é 日本")).toBe("ls -la ~/Projects é 日本");
  });
});

describe("session titles and names", () => {
  test("lose controls, escape sequences and bidi controls", () => {
    expect(cleanName("\x1b[31mred\x1b[0m build ‮gnp.exe⁩\x07\x85\n!")).toBe("red build gnp.exe!");
    expect(cleanName("a‎b‏c؜d")).toBe("abcd");
  });

  test("keep zero-width joiners", () => {
    expect(cleanName("👨‍👩‍👧 team")).toBe("👨‍👩‍👧 team");
  });

  test("a session sent to the phone is clean", () => {
    const db = openDb(":memory:");
    const registry = new Registry(db, new EventLog(db));
    registry.touch("s1", { cwd: "/p/web", name: "\x1b[1mweb‮ shop" });
    expect(publicSession(registry.get("s1") as never).name).toBe("web shop");
    registry.rename("s1", "my⁦ \x00name");
    const s = publicSession(registry.get("s1") as never);
    expect(s.name).toBe("my name");
    expect(s.originalName).toBe("web shop");
  });
});

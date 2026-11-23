import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deniedAutomation,
  isAutomationDenial,
  keyIntoTerminalApp,
  typeIntoTerminalApp,
} from "../src/platform/darwin.ts";

const bin = mkdtempSync(join(tmpdir(), "relay-fake-osascript-"));
const oldPath = process.env.PATH;
process.env.PATH = `${bin}:${oldPath}`;
afterAll(() => {
  process.env.PATH = oldPath;
});

function fakeOsascript(stdout: string, stderr: string): void {
  const file = join(bin, "osascript");
  writeFileSync(file, `#!/bin/sh\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\n`);
  chmodSync(file, 0o755);
}

const denied = "execution error: Not authorized to send Apple events to iTerm. (-1743)";

beforeEach(() => fakeOsascript("ok", ""));

test("an Automation denial is recognised by its error number or its text", () => {
  expect(isAutomationDenial(denied)).toBe(true);
  expect(isAutomationDenial("execution error: iTerm got an error: Can't get window 3. (-1728)")).toBe(false);
  expect(isAutomationDenial("")).toBe(false);
});

test("a denied osascript is remembered for iTerm", async () => {
  fakeOsascript("", denied);
  expect(await typeIntoTerminalApp("iterm", "/dev/ttys001", "hi")).toBe(false);
  expect(deniedAutomation()).toEqual(["iterm"]);
});

test("another failure leaves the state alone", async () => {
  fakeOsascript("not-found", "");
  expect(await typeIntoTerminalApp("iterm", "/dev/ttys001", "hi")).toBe(false);
  expect(deniedAutomation()).toEqual(["iterm"]);
});

test("the next success clears it", async () => {
  fakeOsascript("ok", "");
  expect(await typeIntoTerminalApp("iterm", "/dev/ttys001", "hi")).toBe(true);
  expect(deniedAutomation()).toEqual([]);
});

test("a denied key press is remembered too", async () => {
  fakeOsascript("", denied);
  await keyIntoTerminalApp("iterm", "/dev/ttys001", "enter");
  expect(deniedAutomation()).toEqual(["iterm"]);
  fakeOsascript("ok", "");
  await keyIntoTerminalApp("iterm", "/dev/ttys001", "enter");
  expect(deniedAutomation()).toEqual([]);
});

test("a first failure with no denial is not remembered", async () => {
  fakeOsascript("not-found", "");
  await typeIntoTerminalApp("iterm", "/dev/ttys001", "hi");
  expect(deniedAutomation()).toEqual([]);
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryError, defaultKeyOps, defaultTypeOps } from "../src/daemon/inject.ts";
import { waitFor } from "./support/wait.ts";

const hasTmux = Bun.which("tmux") !== null;

describe.skipIf(!hasTmux)("a tmux pane left in a mode", () => {
  let dir = "";
  let sock = "";
  const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-S", sock, ...a]);
  const text = (...a: string[]) => new TextDecoder().decode(tmux(...a).stdout);
  const screen = () => text("capture-pane", "-p", "-t", "t");
  const inMode = () => text("display-message", "-p", "-t", "t", "#{pane_in_mode}").trim();

  async function start(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "relay-tmux-mode-"));
    sock = join(dir, "s");
    const r = tmux("-f", "/dev/null", "new-session", "-d", "-s", "t", "-x", "120", "-y", "10", "cat -v");
    if (r.exitCode !== 0) throw new Error(`tmux new-session failed: ${r.stderr.toString()}`);
    await waitFor(
      () => text("list-panes", "-t", "t", "-F", "#{pane_current_command}").trim() === "cat",
      30_000,
      "cat to run in the pane",
    );
    return text("display-message", "-p", "-t", "t", "#{pane_id}").trim();
  }

  afterEach(() => {
    tmux("kill-server");
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("a message typed into a scrolled-back pane reaches the program", async () => {
    const pane = await start();
    tmux("copy-mode", "-t", pane);
    expect(inMode()).toBe("1");
    await defaultTypeOps.tmux?.(sock, pane, "typed while scrolled back");
    expect(inMode()).toBe("0");
    await waitFor(
      () =>
        screen()
          .split("\n")
          .filter((l) => l === "typed while scrolled back").length === 2,
      30_000,
      "the message to reach cat",
      screen,
    );
  });

  test("Enter reaches the program in a scrolled-back pane", async () => {
    const pane = await start();
    tmux("send-keys", "-t", pane, "-l", "--", "leftover");
    tmux("copy-mode", "-t", pane);
    await defaultTypeOps.tmuxEnter?.(sock, pane);
    expect(inMode()).toBe("0");
    await waitFor(
      () =>
        screen()
          .split("\n")
          .filter((l) => l === "leftover").length === 2,
      30_000,
      "the line to reach cat",
      screen,
    );
  });

  test("Stop's Escape reaches the program in a scrolled-back pane", async () => {
    const pane = await start();
    tmux("copy-mode", "-t", pane);
    await defaultKeyOps.tmux(sock, pane);
    expect(inMode()).toBe("0");
    tmux("send-keys", "-t", pane, "Enter");
    await waitFor(() => screen().split("\n").includes("^["), 30_000, "the Escape to reach cat", screen);
  });

  test("a pane that is not in a mode is typed into as before", async () => {
    const pane = await start();
    await defaultTypeOps.tmux?.(sock, pane, "plain");
    await waitFor(
      () =>
        screen()
          .split("\n")
          .filter((l) => l === "plain").length === 2,
      30_000,
      "the message to reach cat",
      screen,
    );
  });

  test("a mode that cancel does not end: nothing is typed, the message fails", async () => {
    const pane = await start();
    tmux("clock-mode", "-t", pane);
    expect(inMode()).toBe("1");
    await expect(defaultTypeOps.tmux?.(sock, pane, "never typed")).rejects.toBeInstanceOf(DeliveryError);
    tmux("send-keys", "-t", pane, "-X", "cancel");
    expect(screen()).not.toContain("never typed");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxType, tmuxTypeSteps } from "../src/daemon/inject.ts";
import { waitFor } from "./support/wait.ts";

const BODIES = ["x;", ";", "say \\;", "\\;", "a;b", "const x = 1;", "a;;"];

describe("tmux typing keeps a trailing semicolon", () => {
  test("no send-keys -l argument ends in ;", () => {
    for (const body of BODIES) {
      for (const step of tmuxTypeSteps("/s", "%1", body)) {
        if (step.args.includes("-l")) expect(step.args.at(-1)?.endsWith(";") ?? false).toBe(false);
      }
    }
  });

  test("multi-line and tab bodies are still pasted", () => {
    for (const text of ["a;\nb;", "a;\tb;"]) {
      const steps = tmuxTypeSteps("/s", "%1", text);
      expect(steps[0]?.args).toContain("load-buffer");
      expect(steps[0]?.stdin).toBe(text);
    }
  });

  const hasTmux = Bun.which("tmux") !== null;
  test.skipIf(!hasTmux)("a private tmux server receives each body unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-tmux-"));
    let sock = "";
    const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-S", sock, ...a]);
    const text = (...a: string[]) => new TextDecoder().decode(tmux(...a).stdout);
    try {
      for (const [n, body] of BODIES.entries()) {
        // A server of its own per body: a killed server that is still shutting down can't swallow the next one.
        sock = join(dir, `s${n}`);
        const started = tmux(
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "t",
          "-x",
          "120",
          "-y",
          "10",
          "-P",
          "-F",
          "#{pane_id}",
          "cat",
        );
        if (started.exitCode !== 0) throw new Error(`tmux new-session failed: ${started.stderr.toString()}`);
        const screen = () => text("capture-pane", "-p", "-t", "t");
        const detail = () => `body ${JSON.stringify(body)}; pane contents:\n${screen()}`;
        // new-session returns before the pane's program runs: keys sent now could land before cat reads them.
        await waitFor(
          () => text("list-panes", "-t", "t", "-F", "#{pane_current_command}").trim() === "cat",
          30_000,
          "cat to run in the pane",
          detail,
        );
        const pane = text("display-message", "-p", "-t", "t", "#{pane_id}").trim();
        await tmuxType(sock, pane, body);
        // cat echoes the typed line, then the line it read: two copies of the body.
        const copies = () =>
          screen()
            .split("\n")
            .filter((l) => l === body).length;
        await waitFor(() => copies() === 2, 30_000, "the body to appear twice in the pane", detail);
        expect(copies()).toBe(2);
        tmux("kill-server");
      }
    } finally {
      tmux("kill-server");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

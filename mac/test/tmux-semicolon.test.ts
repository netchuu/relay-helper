import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxType, tmuxTypeSteps } from "../src/daemon/inject.ts";

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
    const sock = join(dir, "s");
    const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-S", sock, ...a]);
    try {
      for (const body of BODIES) {
        tmux("kill-server");
        tmux(
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
        const pane = new TextDecoder()
          .decode(tmux("display-message", "-p", "-t", "t", "#{pane_id}").stdout)
          .trim();
        await tmuxType(sock, pane, body);
        await Bun.sleep(200);
        const out = new TextDecoder().decode(tmux("capture-pane", "-p", "-t", pane).stdout);
        expect(out.split("\n").filter((l) => l === body).length).toBe(2);
      }
    } finally {
      tmux("kill-server");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

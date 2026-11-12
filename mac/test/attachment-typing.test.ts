import { describe, expect, test } from "bun:test";
import { splitAttachmentPaths, tmuxTypeSteps } from "../src/daemon/inject.ts";

const dir = "/Users/me/.relay/attachments/sess-1";

describe("attachment paths typed after a message", () => {
  test("the text and the trailing paths are split, quoted or not", () => {
    expect(
      splitAttachmentPaths(`Why?\n${dir}/3f9a1c2e-Photo_2026-11-10.jpg\n"${dir}/b71d04aa-Cart totals.pdf"`),
    ).toEqual({
      body: "Why?",
      paths: [`${dir}/3f9a1c2e-Photo_2026-11-10.jpg`, `"${dir}/b71d04aa-Cart totals.pdf"`],
    });
  });
  test("a path alone has no text", () => {
    expect(splitAttachmentPaths(`${dir}/a-IMG_0676.HEIC`)).toEqual({
      body: "",
      paths: [`${dir}/a-IMG_0676.HEIC`],
    });
  });
  test("plain text, and a path the person typed outside the attachments folder, stay text", () => {
    expect(splitAttachmentPaths("hello\nworld")).toEqual({ body: "hello\nworld", paths: [] });
    expect(splitAttachmentPaths("look at\n/Users/me/a.png")).toEqual({
      body: "look at\n/Users/me/a.png",
      paths: [],
    });
  });
  test("a path in the middle of the text is not split off", () => {
    const t = `${dir}/a-b.png\nand then some words`;
    expect(splitAttachmentPaths(t)).toEqual({ body: t, paths: [] });
  });
});

describe("tmux steps for a message with attachments", () => {
  const cmd = (s: { args: string[] }) => s.args[3];
  const sock = "/tmp/s";
  test("text, a space, one paste per path, a wait, then Enter", () => {
    const steps = tmuxTypeSteps(sock, "%1", `Why?\n${dir}/a-1.jpg\n${dir}/b-2.jpg`);
    expect(steps.map(cmd)).toEqual([
      "send-keys", // the text
      "send-keys", // space
      "load-buffer",
      "paste-buffer", // path 1
      "send-keys", // space
      "load-buffer",
      "paste-buffer", // path 2
      "send-keys", // Enter
    ]);
    expect(steps.filter((s) => s.stdin !== undefined).map((s) => s.stdin)).toEqual([
      `${dir}/a-1.jpg`,
      `${dir}/b-2.jpg`,
    ]);
    expect(steps.at(-1)?.args.at(-1)).toBe("Enter");
    expect(steps.at(-1)?.waitMs).toBe(300);
    expect(steps.slice(0, -1).every((s) => s.waitMs === undefined)).toBe(true);
  });
  test("a path alone is one paste, no space, then the wait and Enter", () => {
    const steps = tmuxTypeSteps(sock, "%1", `${dir}/a-1.jpg`);
    expect(steps.map(cmd)).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
    expect(steps.at(-1)?.waitMs).toBe(300);
  });
  test("plain text has no wait", () => {
    const steps = tmuxTypeSteps(sock, "%1", "hello");
    expect(steps.map(cmd)).toEqual(["send-keys", "send-keys"]);
    expect(steps.at(-1)?.waitMs).toBeUndefined();
    expect(tmuxTypeSteps(sock, "%1", "a\nb").map(cmd)).toEqual(["load-buffer", "paste-buffer", "send-keys"]);
  });
});

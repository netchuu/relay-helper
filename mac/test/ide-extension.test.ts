import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDE_BUNDLE_IDS,
  type IdeDeps,
  ideInstalled,
  isIdeSession,
  isIdeSessionSync,
  recentAnswerSnippets,
  sendToIde,
} from "../src/integrations/ideExtension.ts";
import type { AxElement } from "../src/platform/ax.ts";

const dir = mkdtempSync(join(tmpdir(), "relay-ide-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (lines: string[]) => {
  const p = join(dir, `t${n++}.jsonl`);
  writeFileSync(p, lines.join("\n"));
  return p;
};
const entry = (entrypoint: string) =>
  JSON.stringify({ type: "user", entrypoint, message: { content: "hi" } });
const answer = (text: string | unknown[]) =>
  JSON.stringify({ type: "assistant", message: { content: typeof text === "string" ? text : text } });

describe("isIdeSessionSync", () => {
  test("no transcript, or one that can't be read, is not an IDE session", () => {
    expect(isIdeSessionSync(null)).toBe(false);
    expect(isIdeSessionSync(join(dir, "missing.jsonl"))).toBe(false);
  });
  test("the newest entrypoint decides", () => {
    expect(isIdeSessionSync(file([entry("cli"), entry("claude-vscode")]))).toBe(true);
    expect(isIdeSessionSync(file([entry("claude-vscode"), entry("cli")]))).toBe(false);
    expect(isIdeSessionSync(file([JSON.stringify({ type: "user" })]))).toBe(false);
    expect(isIdeSessionSync(file([]))).toBe(false);
  });
  test("the answer is cached by size and refreshed when the file grows", () => {
    const p = file([entry("cli")]);
    expect(isIdeSessionSync(p)).toBe(false);
    expect(isIdeSessionSync(p)).toBe(false); // from the cache
    appendFileSync(p, `\n${entry("claude-vscode")}`);
    expect(isIdeSessionSync(p)).toBe(true);
  });
  test("only the last 256 KB are read", () => {
    const p = file([entry("claude-vscode"), JSON.stringify({ pad: "x".repeat(300 * 1024) })]);
    expect(isIdeSessionSync(p)).toBe(false);
  });
  test("the async form gives the same answer", async () => {
    expect(await isIdeSession(file([entry("claude-vscode")]))).toBe(true);
    expect(await isIdeSession(null)).toBe(false);
  });
});

test("ideInstalled and the bundle list answer without throwing", () => {
  expect(typeof ideInstalled()).toBe("boolean");
  expect(IDE_BUNDLE_IDS).toContain("com.microsoft.VSCode");
});

describe("recentAnswerSnippets", () => {
  test("none for no transcript or a missing file", async () => {
    expect(await recentAnswerSnippets(null)).toEqual([]);
    expect(await recentAnswerSnippets(join(dir, "missing2.jsonl"))).toEqual([]);
  });
  test("newest first, first line only, cut at 60, deduplicated", async () => {
    const p = file([
      answer("Older answer that is long enough\nsecond line"),
      answer(`Newer answer ${"z".repeat(80)}`),
      answer("Older answer that is long enough"),
    ]);
    expect(await recentAnswerSnippets(p)).toEqual([
      "Older answer that is long enough",
      `Newer answer ${"z".repeat(47)}`,
    ]);
  });
  test("text blocks are joined, other blocks ignored, short answers skipped", async () => {
    const p = file([
      answer([
        { type: "tool_use", name: "Bash" },
        { type: "text", text: "Block one, " },
        { type: "text", text: "block two" },
      ]),
      answer("Done."),
      answer([{ type: "text" }]),
      answer("  \n  "),
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "assistant", message: { content: 5 } }),
    ]);
    expect(await recentAnswerSnippets(p)).toEqual(["Block one, block two"]);
  });
  test("a half-written line and non-answers are skipped; the limit holds", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => answer(`Answer number ${i} here`));
    const p = file([entry("cli"), ...lines, '{"type":"assistant","message":{"cont']);
    expect(await recentAnswerSnippets(p, 3)).toEqual([
      "Answer number 4 here",
      "Answer number 3 here",
      "Answer number 2 here",
    ]);
  });
});

/** A fake Accessibility element: a role, a label, a value, and children. */
class Fake {
  focused = false;
  main = false;
  released = 0;
  focusAfter = 1;
  asks = 0;
  props: Record<string, unknown> = {};
  constructor(
    public role: string,
    public label = "",
    public children: Fake[] = [],
  ) {}
  string(attr: string) {
    return String(this.props[attr] ?? "");
  }
  bool(attr: string) {
    if (attr === "AXFocused") return this.focused;
    return Boolean(this.props[attr]);
  }
  setBool(attr: string, value: boolean) {
    if (attr === "AXFocused" && value && ++this.asks >= this.focusAfter) this.focused = true;
    if (attr === "AXMain") this.main = value;
    this.props[attr] = value;
    return true;
  }
  equals(o: Fake) {
    return o === this;
  }
  findAll(match: (e: Fake) => boolean, maxDepth = 70): Fake[] {
    const out: Fake[] = [];
    const walk = (e: Fake, d: number) => {
      if (d > maxDepth) return;
      if (match(e)) out.push(e);
      for (const c of e.children) walk(c, d + 1);
    };
    walk(this, 0);
    return out;
  }
  windows: Fake[] = [];
  main_: Fake | null = null;
  element(attr: string) {
    return attr === "AXMainWindow" ? this.main_ : null;
  }
  elements(attr: string) {
    return attr === "AXWindows" ? this.windows : [];
  }
  release() {
    this.released++;
  }
}

type Tab = { text: string; sendEnabled?: boolean; draft?: string; noSend?: boolean; focusAfter?: number };
function tab(o: Tab) {
  const composer = new Fake("AXTextArea", "Message input");
  composer.props.AXValue = o.draft ?? "";
  composer.focusAfter = o.focusAfter ?? 1;
  const send = new Fake("AXButton", "Send message");
  send.props.AXEnabled = o.sendEnabled ?? false;
  const kids = [
    new Fake("AXButton", "Show command menu (/)"),
    composer,
    new Fake("AXStaticText", "", []),
    ...(o.noSend ? [] : [send]),
  ];
  const text = new Fake("AXStaticText");
  text.props.AXValue = o.text;
  kids[2] = text;
  const area = new Fake("AXWebArea", "", kids);
  return { area, composer, send };
}
function windowWith(...areas: Fake[]) {
  return new Fake("AXWindow", "", areas);
}
function appWith(...windows: Fake[]) {
  const app = new Fake("AXApplication");
  app.main_ = windows[0] ?? null;
  app.windows = windows;
  return app;
}

const ID = "sess-1";
let typed: { pid: number; text: string }[];
let remembered: string[];
let apps: Map<number, Fake>;
let pids: Record<string, number>;
let front: string | null;
let relayTyped: boolean;
let confirm: boolean;
let sleeps: number[];

const deps = (over: Partial<IdeDeps> = {}): IdeDeps => ({
  platform: () => "darwin",
  axAllowed: () => true,
  pidOf: async (b) => pids[b] ?? null,
  frontBundleId: async () => front,
  app: (pid) => apps.get(pid) as unknown as AxElement,
  sleep: async (ms) => void sleeps.push(ms),
  typedByRelay: () => relayTyped,
  rememberTyped: (_s, t) => void remembered.push(t),
  typeToPid: async (pid, text) => void typed.push({ pid, text }),
  waitForPrompt: async () => confirm,
  ...over,
});

beforeEach(() => {
  typed = [];
  remembered = [];
  apps = new Map();
  pids = {};
  front = null;
  relayTyped = false;
  confirm = true;
  sleeps = [];
});

const transcript = () => file([answer("The build finished without errors")]);
const send = (t: string | null = transcript(), active = false, d = deps()) =>
  sendToIde(ID, "hello", t, active, d);

describe("sendToIde", () => {
  test("not on a Mac: not-found; without permission: no-permission", async () => {
    expect(await send(transcript(), false, deps({ platform: () => "linux" }))).toBe("not-found");
    expect(await send(transcript(), false, deps({ axAllowed: () => false }))).toBe("no-permission");
  });

  test("no transcript or no usable answers: not-found, before any app is looked at", async () => {
    let asked = 0;
    const d = deps({
      pidOf: async () => {
        asked++;
        return null;
      },
    });
    expect(await send(null, false, d)).toBe("not-found");
    expect(await send(file([answer("Done.")]), false, d)).toBe("not-found");
    expect(asked).toBe(0);
  });

  test("no editor running: locked (nothing visible)", async () => {
    expect(await send()).toBe("locked");
  });

  test("an editor with no Claude tab: locked", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(10, appWith(new Fake("AXWindow")));
    expect(await send()).toBe("locked");
    expect(apps.get(10)?.released).toBe(1);
  });

  test("a Claude tab that shows another session: not-found", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(10, appWith(windowWith(tab({ text: "A different answer entirely" }).area)));
    expect(await send()).toBe("not-found");
  });

  test("two tabs showing the session: ambiguous", async () => {
    pids["com.microsoft.VSCode"] = 10;
    pids["com.vscodium"] = 11;
    const text = "The build finished without errors, and more";
    apps.set(10, appWith(windowWith(tab({ text }).area)));
    apps.set(11, appWith(windowWith(tab({ text }).area)));
    expect(await send()).toBe("ambiguous");
  });

  test("the same window listed twice counts once", async () => {
    pids["com.microsoft.VSCode"] = 10;
    const w = windowWith(tab({ text: "The build finished without errors" }).area);
    const app = appWith(w);
    app.windows = [w, w];
    apps.set(10, app);
    expect(await send()).toBe("sent");
  });

  test("a matching tab gets the text, and the typed text is remembered", async () => {
    pids["com.microsoft.VSCode"] = 10;
    const t = tab({ text: "The build finished without errors" });
    apps.set(10, appWith(windowWith(t.area)));
    expect(await send()).toBe("sent");
    expect(typed).toEqual([{ pid: 10, text: "hello" }]);
    expect(remembered).toEqual(["hello"]);
    expect(t.composer.focused).toBe(true);
    expect(sleeps).toContain(300);
  });

  test("nested web areas: only the innermost tab counts", async () => {
    pids["com.microsoft.VSCode"] = 10;
    const inner = tab({ text: "The build finished without errors" });
    const outer = new Fake("AXWebArea", "", [inner.area]);
    apps.set(10, appWith(windowWith(outer)));
    expect(await send()).toBe("sent");
  });

  test("the person typing in the editor in front: busy, nothing typed", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(10, appWith(windowWith(tab({ text: "The build finished without errors" }).area)));
    front = "com.microsoft.VSCode";
    expect(await send(transcript(), true)).toBe("busy");
    expect(typed).toEqual([]);
    front = "com.apple.Terminal";
    expect(await send(transcript(), true)).toBe("sent");
  });

  test("a missing Send button: failed", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(10, appWith(windowWith(tab({ text: "The build finished without errors", noSend: true }).area)));
    expect(await send()).toBe("failed");
  });

  test("a draft in the composer is never touched", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(
      10,
      appWith(
        windowWith(
          tab({ text: "The build finished without errors", sendEnabled: true, draft: "half a thought" }).area,
        ),
      ),
    );
    expect(await send()).toBe("draft");
    expect(typed).toEqual([]);
  });

  test("text Relay typed itself that a stale tree still shows is not a draft", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(
      10,
      appWith(
        windowWith(
          tab({ text: "The build finished without errors", sendEnabled: true, draft: "hello" }).area,
        ),
      ),
    );
    relayTyped = true;
    expect(await send()).toBe("sent");
  });

  test("focus is asked for again until it takes, up to seven times", async () => {
    pids["com.microsoft.VSCode"] = 10;
    const slow = tab({ text: "The build finished without errors", focusAfter: 4 });
    apps.set(10, appWith(windowWith(slow.area)));
    expect(await send()).toBe("sent");
    expect(slow.composer.asks).toBe(4);
    const never = tab({ text: "The build finished without errors", focusAfter: 99 });
    apps.set(10, appWith(windowWith(never.area)));
    expect(await send()).toBe("failed");
    expect(never.composer.asks).toBe(7);
    expect(typed).toHaveLength(1);
  });

  test("not confirmed by the transcript: failed and not remembered", async () => {
    pids["com.microsoft.VSCode"] = 10;
    apps.set(10, appWith(windowWith(tab({ text: "The build finished without errors" }).area)));
    confirm = false;
    expect(await send()).toBe("failed");
    expect(remembered).toEqual([]);
  });

  test("an error from the system: failed, and the tree is still released", async () => {
    pids["com.microsoft.VSCode"] = 10;
    const app = appWith(windowWith(tab({ text: "The build finished without errors" }).area));
    apps.set(10, app);
    const d = deps({
      typeToPid: async () => {
        throw new Error("boom");
      },
    });
    expect(await send(transcript(), false, d)).toBe("failed");
    expect(app.released).toBe(1);
  });
});

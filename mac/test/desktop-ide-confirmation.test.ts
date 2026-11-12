import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutIdeContext } from "../src/daemon/render.ts";
import {
  type DesktopDeps,
  promptText,
  recentUserMessages,
  sendToDesktop,
  waitForPrompt,
} from "../src/integrations/claudeDesktop.ts";
import type { AxElement } from "../src/platform/ax.ts";

// Replies typed into the Claude desktop app and IDE panels: a send is confirmed however Claude Code records it, only
// the IDE context in front of a prompt is left out, and the desktop app never gets a reply meant for another session.
// Nothing here touches a real app: the desktop app is a fake passed in, transcripts are temporary files.

const tmp = () => mkdtempSync(join(tmpdir(), "relay-dide-reg-"));
const line = (o: object) => `${JSON.stringify(o)}\n`;
const iso = (ms: number) => new Date(ms).toISOString();

describe("a send is confirmed however Claude Code records it (no double send)", () => {
  test("the IDE extension sends the text with a context block in front", async () => {
    const path = join(tmp(), "t.jsonl");
    const since = Date.now();
    writeFileSync(path, "");
    setTimeout(
      () =>
        writeFileSync(
          path,
          line({
            type: "user",
            timestamp: iso(since + 50),
            message: {
              content: [
                {
                  type: "text",
                  text: "<ide_opened_file>The user opened the file /a.ts in the IDE.</ide_opened_file>",
                },
                { type: "text", text: "Hi" },
              ],
            },
          }),
        ),
      100,
    );
    expect(await waitForPrompt(path, "Hi", since, 2000)).toBe(true);
  });

  test("Claude is working, so the prompt is queued (queue-operation, then queued_command)", async () => {
    const since = Date.now();
    const a = join(tmp(), "a.jsonl");
    writeFileSync(
      a,
      line({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: iso(since + 50),
        content: "what's next",
      }),
    );
    expect(await waitForPrompt(a, "what's next", since, 500)).toBe(true);
    const b = join(tmp(), "b.jsonl");
    writeFileSync(
      b,
      line({ timestamp: iso(since + 50), attachment: { type: "queued_command", prompt: "what's next" } }),
    );
    expect(await waitForPrompt(b, "what's next", since, 500)).toBe(true);
    // A removal isn't a send.
    const c = join(tmp(), "c.jsonl");
    writeFileSync(
      c,
      line({ type: "queue-operation", operation: "remove", timestamp: iso(since + 50), content: "x" }),
    );
    expect(await waitForPrompt(c, "x", since, 300)).toBe(false);
  });

  test("Windows line breaks in the reply", async () => {
    const since = Date.now();
    const path = join(tmp(), "t.jsonl");
    writeFileSync(path, line({ type: "user", timestamp: iso(since + 50), message: { content: "one\ntwo" } }));
    expect(await waitForPrompt(path, "one\r\ntwo", since, 500)).toBe(true);
  });

  test("tool results are never taken for a sent prompt", async () => {
    const since = Date.now();
    const path = join(tmp(), "t.jsonl");
    writeFileSync(
      path,
      line({
        type: "user",
        timestamp: iso(since + 50),
        message: { content: [{ type: "tool_result", content: "yes" }] },
      }),
    );
    expect(await waitForPrompt(path, "yes", since, 300)).toBe(false);
  });
});

test("recent prompts are compared without the IDE context", async () => {
  const path = join(tmp(), "t.jsonl");
  writeFileSync(
    path,
    line({
      type: "user",
      message: {
        content: [
          { type: "text", text: "<ide_opened_file>The user opened /a.ts</ide_opened_file>" },
          { type: "text", text: "Hi" },
        ],
      },
    }),
  );
  expect(await recentUserMessages(path)).toEqual(["Hi"]);
  expect(promptText("a\r\nb  ")).toBe("a\nb");
});

describe("only the context blocks in front go", () => {
  test("the person's own text mentioning a tag stays", () => {
    const text = "What does <ide_selection> mean in the transcript, and where is it added?";
    expect(withoutIdeContext(text)).toBe(text);
  });
  test("code in a selection that contains the closing tag doesn't end the block early", () => {
    const p =
      '<ide_selection>const end = "</ide_selection>"; parse(end)</ide_selection>\nWhy is parse wrong?';
    expect(withoutIdeContext(p)).toBe("Why is parse wrong?");
  });
  test("several blocks, then the text", () => {
    expect(
      withoutIdeContext("<ide_opened_file>a</ide_opened_file>\n<ide_selection>b</ide_selection>\nGo"),
    ).toBe("Go");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A fake Claude desktop app, passed to sendToDesktop.
// ---------------------------------------------------------------------------------------------------------------
type Session = { title: string; composer: string };
function fakeApp(sessions: Record<string, Session>, shown: string) {
  const state = { shown, sessions, sent: [] as { to: string; text: string }[] };
  class El {
    constructor(
      readonly kind: string,
      readonly props: { label?: string; press?: () => void } = {},
    ) {}
    setBool() {
      return true;
    }
    release() {}
    element(attr: string) {
      return attr === "AXMainWindow" ? new El("window") : null;
    }
    elements() {
      return [];
    }
    string(attr: string) {
      if (attr === "AXTitle" && this.kind === "window") return "Claude";
      if (attr === "AXValue" && this.kind === "composer") return state.sessions[state.shown]?.composer ?? "";
      return "";
    }
    bool() {
      return false;
    }
    setString(attr: string, v: string) {
      if (attr === "AXValue" && this.kind === "composer")
        (state.sessions[state.shown] as Session).composer = v;
      return true;
    }
    get role() {
      return this.kind === "composer" ? "AXTextArea" : this.kind === "window" ? "AXWindow" : "AXButton";
    }
    get label() {
      return this.props.label ?? "";
    }
    press() {
      this.props.press?.();
      return true;
    }
    equals(o: El) {
      return o === this;
    }
    findAll(match: (e: El) => boolean): El[] {
      if (this.kind !== "window") return [];
      const cur = state.sessions[state.shown] as Session;
      const all = [
        ...Object.entries(state.sessions).map(
          ([id, s]) =>
            new El("row", {
              label: s.title,
              press: () => {
                state.shown = id;
              },
            }),
        ),
        new El("header", { label: `${cur.title}, rename session` }),
        new El("composer"),
        ...(cur.composer.trim()
          ? [
              new El("send", {
                label: "Send",
                press: () => {
                  state.sent.push({ to: state.shown, text: cur.composer });
                  cur.composer = "";
                },
              }),
            ]
          : []),
      ];
      return all.filter(match);
    }
  }
  const typed = new Map<string, string[]>();
  const deps: DesktopDeps = {
    app: () => new El("app") as unknown as AxElement,
    allowed: () => true,
    sessions: () =>
      Object.entries(state.sessions).map(([id, s]) => ({
        cliSessionId: id,
        title: s.title,
        isArchived: false,
      })),
    pid: async () => 99999,
    typed: {
      has: (id, t) => (typed.get(id) ?? []).includes(promptText(t)),
      remember: (id, t) => void typed.set(id, [promptText(t), ...(typed.get(id) ?? [])]),
    },
  };
  return { state, deps, typed };
}

// The Claude desktop app only runs on macOS, and sendToDesktop says so first on any other system.
describe.skipIf(process.platform !== "darwin")("the desktop app (fake)", () => {
  test("two sessions with the same title: nothing is typed, even with the other one on screen", async () => {
    const { state, deps } = fakeApp(
      { a: { title: "Fix tests", composer: "" }, b: { title: "Fix tests", composer: "" } },
      "b",
    );
    expect(await sendToDesktop("a", "hello from the phone", null, deps)).toBe("ambiguous");
    expect(state.sent).toEqual([]);
  });

  test("a draft equal to an earlier message ('yes') is the person's, and stays", async () => {
    const { state, deps } = fakeApp({ c: { title: "Deploy", composer: "yes" } }, "c");
    expect(await sendToDesktop("c", "stop and wait", null, deps)).toBe("draft");
    expect(state.sent).toEqual([]);
    expect(state.sessions.c?.composer).toBe("yes");
  });

  test("text Relay typed itself (a stale tree) is replaced; the reply goes to the right session", async () => {
    const { state, deps } = fakeApp(
      { c: { title: "Deploy", composer: "old reply" }, d: { title: "Other", composer: "" } },
      "d",
    );
    deps.typed.remember("c", "old reply");
    expect(await sendToDesktop("c", "new reply", null, deps)).toBe("sent");
    expect(state.sent).toEqual([{ to: "c", text: "new reply" }]);
    // Back to the session that was on screen.
    expect(state.shown).toBe("d");
  });
});

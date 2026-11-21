import { describe, expect, test } from "bun:test";
import { promptDraft } from "../src/daemon/promptLine.ts";
import { answerHostRequest, type HostContext } from "../src/shell/ptyHost.ts";
import { ScreenText } from "../src/shell/screenText.ts";

const RULE = "─".repeat(100);

describe("ScreenText", () => {
  test("a character split between two reads stays whole", () => {
    const s = new ScreenText(10);
    const bytes = new TextEncoder().encode(`${RULE}\r\n`);
    s.feed(bytes.slice(0, 152));
    s.feed(bytes.slice(152));
    expect(s.text()).toBe(`${RULE}\n`);
  });

  test("shows lines and follows a redraw that erases the lines above", () => {
    const s = new ScreenText(10);
    s.feed("thinking\r\n");
    s.feed(`${RULE}\r\n❯ old\r\n${RULE}\r\n`);
    s.feed("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G");
    s.feed(`${RULE}\r\n❯ new\r\n${RULE}\r\n`);
    expect(s.text()).toBe(`thinking\n${RULE}\n❯ new\n${RULE}\n`);
  });

  test("keeps dim text dim, so a suggestion in the prompt reads as empty", () => {
    const s = new ScreenText(10);
    s.feed(`${RULE}\r\n❯ \x1b[2mTry "fix typecheck errors"\x1b[22m\r\n${RULE}\r\n`);
    expect(promptDraft(s.text())).toBeNull();
  });

  test("a carriage return overwrites the line, and a split escape sequence is held for the next chunk", () => {
    const s = new ScreenText(10);
    s.feed("loading...\rdone");
    s.feed("\x1b[");
    s.feed("2K\r\nnext");
    expect(s.text()).toBe("\nnext");
  });

  test("only the last rows are visible", () => {
    const s = new ScreenText(2);
    s.feed("a\r\nb\r\nc");
    expect(s.text()).toBe("b\nc");
  });
});

describe("host requests", () => {
  function ctx(log: string[]): HostContext {
    return {
      token: "t",
      screen: () => "screen",
      release: () => void log.push("release"),
      resize: (c, r) => void log.push(`resize ${c}x${r}`),
      type: async () => ({ ok: true, typed: true }),
    };
  }

  test("screen, release and resize need the token", async () => {
    const log: string[] = [];
    expect(await answerHostRequest('{"op":"screen","token":"bad"}', ctx(log))).toEqual({
      ok: false,
      reason: "auth",
    });
    expect(await answerHostRequest('{"op":"screen","token":"t"}', ctx(log))).toEqual({
      ok: true,
      screen: "screen",
    });
    expect(await answerHostRequest('{"op":"release","token":"t"}', ctx(log))).toEqual({ ok: true });
    expect(await answerHostRequest('{"op":"resize","token":"t","cols":100,"rows":30}', ctx(log))).toEqual({
      ok: true,
    });
    expect(log).toEqual(["release", "resize 100x30"]);
  });

  test("a size that makes no sense is refused, and typing goes to the shell protocol", async () => {
    const log: string[] = [];
    expect(await answerHostRequest('{"op":"resize","token":"t","cols":1,"rows":30}', ctx(log))).toEqual({
      ok: false,
      reason: "bad_request",
    });
    expect(await answerHostRequest("{not json", ctx(log))).toEqual({ ok: false, reason: "bad_request" });
    expect(await answerHostRequest('{"token":"t","text":"hi","pid":1}', ctx(log))).toEqual({
      ok: true,
      typed: true,
    });
  });
});

describe("the prompt on a screen from a real terminal", () => {
  test("a rule that carries the session's name is still a rule", () => {
    const s = new ScreenText(10);
    s.feed(`${"─".repeat(90)} incoming bug triage ─\r\n❯ fix the login\r\n${RULE}\r\n`);
    expect(promptDraft(s.text())).toBe("fix the login");
  });
});

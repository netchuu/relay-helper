import { describe, expect, test } from "bun:test";
import { deliver, PHONE_PREFIX, tmuxTypeSteps } from "../src/daemon/inject.ts";
import { asTyped } from "../src/platform/darwin.ts";
import { answerRequest, type RequestContext, typedBytes } from "../src/shell/ptyShell.ts";
import { cleanTypedText } from "../src/shell/typedText.ts";
import { fakeTerminals, ITERM, inbox, opts, sessionWith, TMUX } from "./support/terminals.ts";

// A reply from the phone must reach Claude Code as text and nothing else: no keys (Enter, the end of a bracketed
// paste, Ctrl-C…) hidden in it, on any route.

const ESC = "\x1b";
const PASTE_END = `${ESC}[201~`;
/** A reply that tries to leave the paste, run a command and send other keys. */
const HOSTILE = `fix it${PASTE_END}\rrm -rf ~\r\x03\x04\x1a\x15\x00\x07\x08\x7f\x9b31m${ESC}]0;title\x07 done`;

/** Any control character other than a newline or a tab. */
const hasControls = (s: string) =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x7f && c <= 0x9f);
  });

describe("cleanTypedText", () => {
  test("drops ESC, the paste end marker's ESC, CR, other C0 controls, DEL and C1 controls", () => {
    const clean = cleanTypedText(HOSTILE);
    expect(clean).not.toContain(ESC);
    expect(clean).not.toContain("\r");
    expect(hasControls(clean)).toBe(false);
    // What was text stays text: the CRs became line breaks, which only ever go in inside a paste.
    expect(clean).toBe("fix it[201~\nrm -rf ~\n31m]0;title done");
  });

  test("keeps ordinary text, newlines, tabs and any language or emoji", () => {
    const text = "line one\n\tindented\nПривет, 世界 👍 café — “quotes”";
    expect(cleanTypedText(text)).toBe(text);
  });

  test("CRLF and a lone CR are line breaks", () => {
    expect(cleanTypedText("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("every route types only clean text", () => {
  test("relay shell: one paste, one end marker, Enter only from Relay", () => {
    const { body, enter } = typedBytes(HOSTILE, true);
    expect(body.startsWith(`${ESC}[200~`)).toBe(true);
    expect(body.endsWith(PASTE_END)).toBe(true);
    const inner = body.slice(6, -6);
    expect(inner).toBe(cleanTypedText(HOSTILE));
    expect(hasControls(inner)).toBe(false);
    expect(enter).toBe("\r");
    // Without bracketed paste: one line, no controls.
    const flat = typedBytes(HOSTILE, false).body;
    expect(flat).not.toContain("\n");
    expect(hasControls(flat)).toBe(false);
  });

  test("relay shell answers a request by writing clean text", async () => {
    const writes: string[] = [];
    const ctx: RequestContext = {
      token: "t",
      shellPid: 10,
      isForeground: async () => true,
      lastInput: () => 0,
      hasDraft: () => false,
      pasteOn: () => true,
      write: (d) => void writes.push(d),
      sleep: async () => {},
      now: () => 100_000,
    };
    const reply = await answerRequest(JSON.stringify({ token: "t", pid: 42, text: HOSTILE }), ctx);
    expect(reply).toEqual({ ok: true });
    expect(writes).toEqual([`${ESC}[200~${cleanTypedText(HOSTILE)}${PASTE_END}`, "\r"]);
  });

  test("tmux: no step carries a control character; Enter is a step of its own", () => {
    const steps = tmuxTypeSteps("/tmp/sock", "%1", HOSTILE);
    for (const step of steps) {
      expect(hasControls(step.args.join(" "))).toBe(false);
      if (step.stdin !== undefined) expect(hasControls(step.stdin.replaceAll("\n", ""))).toBe(false);
    }
    expect(steps.filter((s) => s.args.includes("Enter"))).toHaveLength(1);
    expect(steps.at(-1)?.args.at(-1)).toBe("Enter");
  });

  test("tmux: a single line is typed, a newline or a tab goes in as a paste", () => {
    const one = tmuxTypeSteps("/s", "%1", "run the tests");
    expect(one[0]?.args).toEqual(["tmux", "-S", "/s", "send-keys", "-t", "%1", "-l", "--", "run the tests"]);
    for (const text of ["first\nsecond", "a\tb"]) {
      const steps = tmuxTypeSteps("/s", "%1", text);
      expect(steps[0]).toEqual({
        args: ["tmux", "-S", "/s", "load-buffer", "-b", "relay", "-"],
        stdin: text,
      });
      expect(steps[1]?.args).toContain("paste-buffer");
    }
  });

  test("iTerm2: one paste and one end marker at most; a plain line stays plain", () => {
    const typed = asTyped(HOSTILE);
    expect(typed).toBe(`${ESC}[200~${cleanTypedText(HOSTILE)}${PASTE_END}`);
    expect(typed.split(PASTE_END)).toHaveLength(2);
    expect(asTyped("one line")).toBe("one line");
    expect(asTyped(`one ${ESC}[201~line\r`)).toBe(`${ESC}[200~one [201~line\n${PASTE_END}`);
    expect(asTyped("a\tb")).toBe(`${ESC}[200~a\tb${PASTE_END}`);
  });
});

describe("deliver: the text is cleaned on every route", () => {
  for (const [route, env] of [
    ["pty", { pty: "/tmp/pty.sock", ptyToken: "x", claudePid: 4242 }],
    ["tmux", TMUX],
    ["iterm", ITERM],
  ] as const) {
    test(route, async () => {
      const t = fakeTerminals(true);
      await deliver(sessionWith(env), HOSTILE, opts, t.ops);
      expect(t.typed).toEqual([`${route}:${cleanTypedText(HOSTILE)}`]);
    });
  }

  test("the inbox", async () => {
    const box = await inbox();
    const t = fakeTerminals(false);
    await deliver(sessionWith({ ...TMUX, socket: box.path }), HOSTILE, opts, t.ops);
    await Bun.sleep(30);
    expect(box.got).toEqual([`${PHONE_PREFIX}\n${cleanTypedText(HOSTILE)}`]);
    box.server.close();
  });

  test("a multi-line reply still arrives with its lines", async () => {
    const t = fakeTerminals(true);
    await deliver(sessionWith(ITERM), "first line\r\nsecond line\n\tthird", opts, t.ops);
    expect(t.typed).toEqual(["iterm:first line\nsecond line\n\tthird"]);
  });
});

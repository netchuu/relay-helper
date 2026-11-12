import { describe, expect, test } from "bun:test";
import { deliver, PHONE_PREFIX } from "../src/daemon/inject.ts";
import { inFront, parseProcs } from "../src/platform/foreground.ts";
import { fakeTerminals, ITERM, inbox, opts, PROMPT, RULE, sessionWith, TMUX } from "./support/terminals.ts";

// A reply from the phone is typed into the session's terminal only while Claude Code is the program in front of
// it. Otherwise (Claude suspended with Ctrl-Z, exited, another program in front) the keys would reach a shell or
// that program, outside Claude's permission prompts: the reply goes to the session's inbox instead.

/** `ps -A -o pid=,pgid=,tpgid=,tty=,command=` on a Mac with one Claude Code session in ttys004. */
const ps = (fg: number, rows: string[] = []) =>
  [
    "    1     1     0 ??       /sbin/launchd",
    ` 4100  4100 ${fg} ttys004  -zsh`,
    ` 4242  4242 ${fg} ttys004  claude`,
    ` 4250  4242 ${fg} ttys004  node /opt/homebrew/bin/some-mcp`,
    ...rows,
  ].join("\n");

describe("inFront", () => {
  test("Claude's group is the terminal's foreground group: in front", () => {
    expect(inFront(parseProcs(ps(4242)), 4242, null)).toBe(true);
    expect(inFront(parseProcs(ps(4242)), 4242, "/dev/ttys004")).toBe(true);
  });

  test("Claude suspended with Ctrl-Z: the shell is in front", () => {
    const procs = parseProcs(ps(4100));
    expect(inFront(procs, 4242, null)).toBe(false);
    expect(inFront(procs, 4242, "/dev/ttys004")).toBe(false);
  });

  test("another program started in front of Claude (from the shell after Claude, or in its place)", () => {
    const procs = parseProcs(ps(4300, [` 4300  4300 4300 ttys004  vim notes.md`]));
    expect(inFront(procs, 4242, null)).toBe(false);
    expect(inFront(procs, 4242, "/dev/ttys004")).toBe(false);
  });

  test("Claude has exited, or has no terminal: not in front", () => {
    expect(inFront(parseProcs(ps(4100).replace(/.*claude\n/, "")), 4242, null)).toBe(false);
    expect(inFront(parseProcs(" 4242  4242     0 ??       claude"), 4242, null)).toBe(false);
    // Linux shows no terminal as `?` and -1.
    expect(inFront(parseProcs(" 4242  4242    -1 ?        claude"), 4242, null)).toBe(false);
  });

  test("a tab Claude doesn't run in, with a shell in front: not in front", () => {
    const procs = parseProcs(ps(4242, [" 5000  5000  5000 ttys009  -zsh"]));
    expect(inFront(procs, 4242, "/dev/ttys009")).toBe(false);
  });

  test("a session in a background host, shown in the tab by a `claude` viewer in front: in front", () => {
    const procs = parseProcs(
      [
        " 6000  6000     0 ??       claude --bg-pty-host",
        " 6001  6001  6001 ttys020  claude --resume",
        " 4242  4242  4242 ttys021  claude",
        " 5000  5000  6001 ttys020  -zsh",
      ].join("\n"),
    );
    expect(inFront(procs, 4242, "/dev/ttys020")).toBe(true);
    // The viewer suspended: the tab's shell is in front.
    const suspended = procs.map((p) => (p.tty === "ttys020" ? { ...p, tpgid: 5000 } : p));
    expect(inFront(suspended, 4242, "/dev/ttys020")).toBe(false);
  });

  test("Linux terminals", () => {
    const procs = parseProcs(
      [" 900   900   900 pts/3    claude", " 880   880   900 pts/3    -bash"].join("\n"),
    );
    expect(inFront(procs, 900, null)).toBe(true);
    expect(inFront(procs, 900, "/dev/pts/3")).toBe(true);
  });
});

describe("deliver: only into Claude Code in front", () => {
  for (const [name, env, tty] of [
    ["tmux", TMUX, null],
    ["iTerm2", ITERM, "/dev/ttys004"],
  ] as const) {
    test(`${name}: Claude in front, the reply is typed`, async () => {
      const t = fakeTerminals(true);
      const res = await deliver(sessionWith(env), "run the tests", opts, t.ops);
      expect(res.via).toBe(name === "tmux" ? "tmux" : "iterm");
      expect(t.typed).toEqual([`${res.via}:run the tests`]);
      expect(t.asked).toEqual([[4242, tty]]);
    });

    test(`${name}: Claude not in front, nothing is typed; the reply reaches the inbox`, async () => {
      const box = await inbox();
      const t = fakeTerminals(false);
      const res = await deliver(sessionWith({ ...env, socket: box.path }), "run the tests", opts, t.ops);
      expect(res).toEqual({ via: "socket" });
      expect(t.typed).toEqual([]);
      await Bun.sleep(30);
      expect(box.got).toEqual([`${PHONE_PREFIX}\nrun the tests`]);
      box.server.close();
    });
  }

  test("no Claude process known: nothing is typed", async () => {
    const box = await inbox();
    const t = fakeTerminals(true);
    const res = await deliver(
      sessionWith({ ...TMUX, claudePid: null, socket: box.path }),
      "hello",
      opts,
      t.ops,
    );
    expect(res).toEqual({ via: "socket" });
    expect(t.typed).toEqual([]);
    box.server.close();
  });

  test("the check failing counts as not in front", async () => {
    const box = await inbox();
    const t = fakeTerminals(true);
    t.ops.inFront = async () => {
      throw new Error("ps failed");
    };
    const res = await deliver(sessionWith({ ...ITERM, socket: box.path }), "hello", opts, t.ops);
    expect(res).toEqual({ via: "socket" });
    expect(t.typed).toEqual([]);
    box.server.close();
  });

  test("Enter pressed again for an unsent message: not when Claude has left the front", async () => {
    const t = fakeTerminals(true);
    let checks = 0;
    // In front for the typing, gone (suspended) by the time Enter would be pressed again.
    t.ops.inFront = async () => checks++ === 0;
    // The prompt is empty before typing; the message then sits in it, unsent.
    let screen = PROMPT;
    t.ops.tmuxScreen = async () => screen;
    t.ops.tmux = async () => {
      screen = `${RULE}\n❯ run the tests\n${RULE}`;
    };
    const res = await deliver(
      sessionWith(TMUX),
      "run the tests",
      { ...opts, submitted: () => false, submitWaitMs: 0 },
      t.ops,
    );
    expect(res.via).toBe("tmux");
    expect(t.entered).toEqual([]);
    // Still in front: Enter is pressed once more, as before.
    const again = fakeTerminals(true);
    let shown = PROMPT;
    again.ops.tmuxScreen = async () => shown;
    again.ops.tmux = async () => {
      shown = `${RULE}\n❯ run the tests\n${RULE}`;
    };
    await deliver(
      sessionWith(TMUX),
      "run the tests",
      { ...opts, submitted: () => false, submitWaitMs: 0 },
      again.ops,
    );
    expect(again.entered).toEqual(["tmux"]);
  });

  test("`relay shell` keeps its own check: no foreground lookup here", async () => {
    const t = fakeTerminals(false);
    const res = await deliver(
      sessionWith({ pty: "/tmp/pty.sock", ptyToken: "x", claudePid: 4242 }),
      "hi",
      opts,
      t.ops,
    );
    expect(res).toEqual({ via: "pty" });
    expect(t.asked).toEqual([]);
  });
});

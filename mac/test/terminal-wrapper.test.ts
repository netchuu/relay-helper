import { expect, test } from "bun:test";
import {
  candidateTtys,
  deliver,
  type KeyOps,
  pressEscape,
  type TypeOps,
  ttyOf,
  wrapperTtysOf,
} from "../src/daemon/inject.ts";
import { inFront, parseProcs } from "../src/platform/foreground.ts";
import type { TabView } from "../src/platform/types.ts";
import { inbox, opts, PROMPT, sessionWith } from "./support/terminals.ts";
import { waitFor } from "./support/wait.ts";

// Claude Code under a wrapper that gives it its own pty: the terminal tab belongs to the wrapper's terminal.

const ITERM = { termProgram: "iTerm.app", claudePid: 4242 };

/** pid ppid pgid tpgid tty command: zsh on ttys013, the wrapper on ttys013 (group 4100), claude on its own ttys015. */
const tree = (extra: string[] = []) =>
  parseProcs(
    [
      "    1     0     1     0 ??       /sbin/launchd",
      " 4000     1  4000  4100 ttys013  -zsh",
      " 4100  4000  4100  4100 ttys013  /Applications/Corral.app/Contents/MacOS/sd-wrap claude",
      " 4242  4100  4242  4242 ttys015  claude",
      ...extra,
    ].join("\n"),
    true,
  );

function ops(procs: ReturnType<typeof tree>, tabs: string[], typed: string[]): TypeOps {
  const snap = async () => procs;
  return {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmuxScreen: async () => null,
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: (pid) => ttyOf(pid, snap),
    viewerTtyOf: async () => null,
    wrapperTtysOf: (pid) => wrapperTtysOf(pid, snap),
    peek: async (_r, tty): Promise<TabView | null> =>
      tabs.includes(tty) ? { front: true, screen: PROMPT } : null,
    inFront: async (pid, tty, others) => inFront(procs, pid, tty, others),
    type: async (_r, tty, text) => {
      typed.push(`${tty}:${text}`);
      return true;
    },
    sleep: async () => {},
  };
}

test("the wrapper's tab gets the message and the inbox none", async () => {
  const box = await inbox();
  const typed: string[] = [];
  const res = await deliver(
    sessionWith({ ...ITERM, socket: box.path }),
    "run the tests",
    opts,
    ops(tree(), ["/dev/ttys013"], typed),
  );
  expect(res).toEqual({ via: "iterm" });
  expect(typed).toEqual(["/dev/ttys013:run the tests"]);
  expect(box.got).toEqual([]);
  box.server.close();
});

test("another program in front of the wrapper's tab: nothing is typed, the inbox gets it", async () => {
  const box = await inbox();
  const typed: string[] = [];
  const vim = tree([" 4300  4000  4300  4300 ttys013  vim notes.md"]).map((p) =>
    p.tty === "ttys013" ? { ...p, tpgid: 4300 } : p,
  );
  const res = await deliver(
    sessionWith({ ...ITERM, socket: box.path }),
    "run the tests",
    opts,
    ops(vim, ["/dev/ttys013"], typed),
  );
  expect(res).toEqual({ via: "socket" });
  expect(typed).toEqual([]);
  await waitFor(() => box.got.length >= 1, 30_000, "the inbox line");
  box.server.close();
});

test("Claude's own tty comes first, then each wrapper's, and the shell's tty is not extra", async () => {
  const snap = async () => tree();
  const { ttys } = await candidateTtys(sessionWith(ITERM), {
    ttyOf: (pid) => ttyOf(pid, snap),
    wrapperTtysOf: (pid) => wrapperTtysOf(pid, snap),
  });
  expect(ttys).toEqual([
    { tty: "/dev/ttys015", by: "process" },
    { tty: "/dev/ttys013", by: "parent sd-wrap" },
  ]);
});

test("a wrapper with a second child is no pass-through: no tab from it", async () => {
  const procs = tree([" 4150  4100  4150  4100 ttys013  logger"]);
  expect(await wrapperTtysOf(4242, async () => procs)).toEqual([]);
});

test("without a tab on any ancestor the message falls back to the inbox", async () => {
  const box = await inbox();
  const typed: string[] = [];
  const res = await deliver(
    sessionWith({ ...ITERM, socket: box.path }),
    "run the tests",
    opts,
    ops(tree(), ["/dev/ttys099"], typed),
  );
  expect(res).toEqual({ via: "socket" });
  expect(typed).toEqual([]);
  box.server.close();
});

test("Stop: Esc goes to the wrapper's tab too", async () => {
  const procs = tree();
  const snap = async () => procs;
  const sent: string[] = [];
  const keyOps: KeyOps = {
    pty: async () => ({ ok: false, reason: "not_foreground" }),
    tmux: async () => {},
    routes: () => ["iterm"],
    ttyOf: (pid) => ttyOf(pid, snap),
    viewerTtyOf: async () => null,
    wrapperTtysOf: (pid) => wrapperTtysOf(pid, snap),
    inFront: async (pid, tty, others) => inFront(procs, pid, tty, others),
    app: async (_r, tty) => {
      if (tty !== "/dev/ttys013") return false;
      sent.push(tty);
      return true;
    },
  };
  expect(await pressEscape(sessionWith(ITERM), keyOps)).toBe("iterm");
  expect(sent).toEqual(["/dev/ttys013"]);
});

test("a stopped wrapper with another claude in front of its tty: nothing is typed", async () => {
  const box = await inbox();
  const typed: string[] = [];
  const other = tree([" 4500  4000  4500  4500 ttys013  claude"]).map((p) =>
    p.tty === "ttys013" ? { ...p, tpgid: 4500 } : p,
  );
  const res = await deliver(
    sessionWith({ ...ITERM, socket: box.path }),
    "run the tests",
    opts,
    ops(other, ["/dev/ttys013"], typed),
  );
  expect(res).toEqual({ via: "socket" });
  expect(typed).toEqual([]);
  await waitFor(() => box.got.length >= 1, 30_000, "the inbox line");
  box.server.close();
});

test("plain script: the shell it opens on Claude's pty is walked through", async () => {
  const procs = parseProcs(
    [
      "    1     0     1     0 ??       /sbin/launchd",
      " 4000     1  4000  4100 ttys013  -zsh",
      " 4100  4000  4100  4100 ttys013  script -q out.log",
      " 4200  4100  4200  4242 ttys015  /bin/zsh -i",
      " 4242  4200  4242  4242 ttys015  claude",
    ].join("\n"),
    true,
  );
  expect(await wrapperTtysOf(4242, async () => procs)).toEqual([
    { tty: "/dev/ttys013", by: "parent script" },
  ]);
  expect(inFront(procs, 4242, "/dev/ttys013")).toBe(true);
});

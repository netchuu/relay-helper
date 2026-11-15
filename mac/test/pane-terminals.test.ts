import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import {
  defaultTypeOps,
  deliver,
  splitAttachmentPaths,
  type TypeOps,
  typingRouteFor,
  WaitForPause,
} from "../src/daemon/inject.ts";
import {
  kittyDoctorNote,
  kittyWindowInfo,
  paneTargetOf,
  paneTypeSteps,
  weztermPaneInfo,
} from "../src/daemon/paneTerminals.ts";
import { type HookEnv, Registry, replyRouteOf, type SessionRecord } from "../src/daemon/registry.ts";

// Replies to a Claude Code session in a WezTerm pane or a kitty window are typed through the terminal's own
// command line, run here against fake `wezterm` and `kitty` programs on PATH.

const RULE = "─".repeat(100);
const screen = (...prompt: string[]) =>
  ["⏺ Done.", RULE, ...prompt, RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const EMPTY = screen("❯ ");
const DRAFT = screen("❯ also check the signup");
const STUCK = (text: string) => screen(`❯ ${text}`);

const WEZ_ENV: HookEnv = {
  termProgram: "WezTerm",
  weztermPane: "7",
  weztermSocket: "/tmp/wez/gui-sock-1",
  claudePid: 4242,
};
const KITTY_ENV: HookEnv = {
  termProgram: "kitty",
  kittyWindowId: "5",
  kittyListenOn: "unix:/tmp/kitty-9",
  claudePid: 4242,
};

let dir: string;
let oldPath: string | undefined;

/** A fake terminal program: logs its arguments and what it reads on stdin, answers get-text and list from files. */
function fake(name: string) {
  const script = `#!/bin/sh
{ printf 'CALL %s\\n' "$*"; case "$*" in *send-text*) printf 'STDIN %s\\n' "$(cat | tr '\\r' '~' | tr '\\n' '|')";; esac; } >> ${dir}/log
case "$*" in
  *get-text*) cat ${dir}/screen ;;
  *" list "*) cat ${dir}/list.json ;;
  *" ls "*) cat ${dir}/ls.json ;;
esac
`;
  writeFileSync(join(dir, name), script);
  chmodSync(join(dir, name), 0o755);
}

const calls = () => {
  try {
    return readFileSync(join(dir, "log"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("CALL"));
  } catch {
    return [];
  }
};
const log = () => {
  try {
    return readFileSync(join(dir, "log"), "utf8");
  } catch {
    return "";
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-panes-"));
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  fake("wezterm");
  fake("kitty");
  writeFileSync(join(dir, "screen"), EMPTY);
  writeFileSync(join(dir, "list.json"), JSON.stringify([{ pane_id: 7, tty_name: "/dev/ttys042" }]));
  writeFileSync(
    join(dir, "ls.json"),
    JSON.stringify([{ tabs: [{ windows: [{ id: 5, foreground_processes: [{ pid: 4242 }] }] }] }]),
  );
});
afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

function session(env: HookEnv): SessionRecord {
  const db = openDb(":memory:");
  const registry = new Registry(db, new EventLog(db));
  return registry.touch("s", { cwd: "/p", env }).session;
}

function opsWith(front = true): TypeOps {
  return {
    ...defaultTypeOps,
    ttyOf: async () => "/dev/ttys042",
    inFront: async () => front,
    routes: () => [],
    sleep: async () => {},
  };
}

const opts = { idleSeconds: 600, userTypingNow: false, preferTyping: true };

describe("WezTerm", () => {
  test("types the text and Enter into the pane, through its socket", async () => {
    const res = await deliver(session(WEZ_ENV), "fix the login", opts, opsWith());
    expect(res).toEqual({ via: "wezterm" });
    const l = log();
    expect(l).toContain("CALL cli --no-auto-start get-text --pane-id 7 --escapes");
    expect(l).toContain("CALL cli --no-auto-start send-text --pane-id 7 --no-paste\nSTDIN fix the login\n");
    // Enter is a carriage return typed as a key, after the text
    expect(l.indexOf("--no-paste\nSTDIN ~\n")).toBeGreaterThan(l.indexOf("STDIN fix the login"));
  });

  test("multi-line text is pasted as one message, without --no-paste", async () => {
    await deliver(session(WEZ_ENV), "one\ntwo", opts, opsWith());
    expect(calls()).toContain("CALL cli --no-auto-start send-text --pane-id 7");
    expect(log()).toContain("STDIN one|two\n");
  });

  test("control characters are stripped", async () => {
    await deliver(session(WEZ_ENV), "a\u001bb\u0003c", opts, opsWith());
    expect(log()).toContain("STDIN abc\n");
  });

  test("a draft in the prompt holds the message", async () => {
    writeFileSync(join(dir, "screen"), DRAFT);
    await expect(deliver(session(WEZ_ENV), "hi", opts, opsWith())).rejects.toBeInstanceOf(WaitForPause);
    expect(calls().some((c) => c.includes("send-text"))).toBe(false);
  });

  test("while the person types, the message waits", async () => {
    const err = await deliver(session(WEZ_ENV), "hi", { ...opts, idleSeconds: 1 }, opsWith()).catch((e) => e);
    expect(err).toBeInstanceOf(WaitForPause);
    expect((err as WaitForPause).reason).toBe("typing");
    expect(calls().some((c) => c.includes("send-text"))).toBe(false);
  });

  test("nothing is typed when Claude Code isn't in front of the pane", async () => {
    const s = session({ ...WEZ_ENV, claudePid: 4242 });
    const res = await deliver(s, "hi", opts, { ...opsWith(false), sleep: async () => {} }).catch((e) => e);
    // no inbox socket in this fixture: it can't be delivered, but never typed
    expect(res).toBeInstanceOf(Error);
    expect(calls().some((c) => c.includes("send-text"))).toBe(false);
  });

  test("nothing is typed when the process runs on another tty than the pane", async () => {
    const ops = { ...opsWith(), ttyOf: async () => "/dev/ttys099" };
    const res = await deliver(session(WEZ_ENV), "hi", opts, ops).catch((e) => e);
    expect(res).toBeInstanceOf(Error);
    expect(calls().some((c) => c.includes("send-text"))).toBe(false);
  });

  test("a message still in the prompt after Enter gets Enter again", async () => {
    writeFileSync(join(dir, "screen"), STUCK("fix the login"));
    // the pane shows the message sitting there after typing; the draft check happens before typing, so start empty
    let reads = 0;
    const ops: TypeOps = {
      ...opsWith(),
      paneScreen: async (t) => (++reads === 1 ? EMPTY : (defaultTypeOps.paneScreen?.(t) ?? null)),
    };
    const res = await deliver(
      session(WEZ_ENV),
      "fix the login",
      { ...opts, submitted: () => false, submitWaitMs: 10 },
      { ...ops, sleep: async () => Bun.sleep(5) },
    );
    expect(res).toEqual({ via: "wezterm", submitted: false });
    const enters = log()
      .split("\n")
      .filter((l) => l === "STDIN ~");
    expect(enters.length).toBe(2);
  });

  test("the route is typed, and the pane is stored", async () => {
    const s = session(WEZ_ENV);
    expect(s).toMatchObject({ weztermPane: "7", weztermSocket: "/tmp/wez/gui-sock-1", canReceive: true });
    expect(replyRouteOf(s)).toEqual({ replyRoute: "typed" });
    expect(await typingRouteFor(s, opsWith())).toBe("wezterm");
  });
});

describe("kitty", () => {
  test("types the text and Enter into the window through the listen socket", async () => {
    const res = await deliver(session(KITTY_ENV), "fix the login", opts, opsWith());
    expect(res).toEqual({ via: "kitty" });
    const l = log();
    expect(l).toContain("CALL @ --to unix:/tmp/kitty-9 get-text --match id:5 --ansi");
    expect(l).toContain(
      "CALL @ --to unix:/tmp/kitty-9 send-text --match id:5 --stdin\nSTDIN fix the login\n",
    );
    expect(l.indexOf("--stdin\nSTDIN ~\n")).toBeGreaterThan(l.indexOf("STDIN fix the login"));
  });

  test("multi-line text is a bracketed paste", async () => {
    await deliver(session(KITTY_ENV), "one\ntwo", opts, opsWith());
    expect(calls()).toContain(
      "CALL @ --to unix:/tmp/kitty-9 send-text --match id:5 --stdin --bracketed-paste auto",
    );
  });

  test("a draft holds the message; not in front types nothing", async () => {
    writeFileSync(join(dir, "screen"), DRAFT);
    await expect(deliver(session(KITTY_ENV), "hi", opts, opsWith())).rejects.toBeInstanceOf(WaitForPause);
    writeFileSync(join(dir, "screen"), EMPTY);
    await deliver(session(KITTY_ENV), "hi", opts, opsWith(false)).catch(() => {});
    writeFileSync(
      join(dir, "ls.json"),
      JSON.stringify([{ tabs: [{ windows: [{ id: 5, foreground_processes: [{ pid: 1 }] }] }] }]),
    );
    await deliver(session(KITTY_ENV), "hi", opts, opsWith()).catch(() => {});
    expect(calls().some((c) => c.includes("send-text"))).toBe(false);
  });

  test("without remote control the session keeps the inbox, and doctor names the kitty.conf lines", () => {
    const s = session({ termProgram: "kitty", kittyWindowId: "5", kittyListenOn: null, claudePid: 4242 });
    expect(paneTargetOf(s)).toBeNull();
    expect(replyRouteOf(s).replyRoute).not.toBe("typed");
    const note = kittyDoctorNote([s]) ?? "";
    expect(note).toContain("allow_remote_control socket-only");
    expect(note).toContain("listen_on unix:/tmp/kitty");
    expect(kittyDoctorNote([session(KITTY_ENV)])).toBeNull();
  });
});

describe("what the terminals report", () => {
  test("the session records the variables, and forgets them in another terminal", () => {
    const db = openDb(":memory:");
    const registry = new Registry(db, new EventLog(db));
    registry.touch("s", { cwd: "/p", env: WEZ_ENV });
    registry.touch("s", { cwd: "/p", env: { claudePid: 4242 } }, false);
    expect(registry.get("s")?.weztermPane).toBe("7");
    registry.touch("s", {
      cwd: "/p",
      env: { weztermPane: null, weztermSocket: null, kittyWindowId: null, kittyListenOn: null },
    });
    expect(registry.get("s")).toMatchObject({ weztermPane: null, weztermSocket: null, kittyWindowId: null });
  });

  test("pane lookups", () => {
    expect(weztermPaneInfo(JSON.stringify([{ pane_id: 7, tty_name: "/dev/ttys001" }]), "7")).toEqual({
      tty: "/dev/ttys001",
    });
    expect(weztermPaneInfo("not json", "7")).toBeNull();
    expect(kittyWindowInfo("[]", "5")).toBeNull();
  });

  test("an attachment path is pasted on its own, then Enter after a pause", () => {
    const target = { kind: "wezterm", pane: "1", socket: null } as const;
    const steps = paneTypeSteps(target, "look\n/x/attachments/a/b.png", splitAttachmentPaths);
    expect(steps.map((s) => s.stdin)).toEqual(["look", " ", "/x/attachments/a/b.png", "\r"]);
    expect(steps.at(-1)?.waitMs).toBe(300);
  });
});

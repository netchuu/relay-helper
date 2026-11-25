import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideRelayPty, parseWrapArgs, TerminalModes, typedPart } from "../src/shell/ptyWrap.ts";

// `relay wrap` runs a stand-in for Claude Code in a pty of its own, inside a pty that plays the person's terminal.

const CLI = join(import.meta.dir, "../src/cli.ts");
const STUB = join(import.meta.dir, "support/wrap-claude.ts");
const dirs: string[] = [];
const procs: { kill(sig?: number | NodeJS.Signals): void }[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-wrap-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(bin, 0o755);
  const logPath = join(dir, "stub.log");
  const home = join(dir, "home");
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const keys = () =>
    log()
      .split("\n")
      .filter((l) => l.startsWith("KEYS "))
      .map((l) => JSON.parse(l.slice(5)) as string)
      .join("");
  const waitFor = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end && !check(); ) await Bun.sleep(20);
    return check();
  };
  /** Runs `relay wrap -- <args>` in a terminal of its own; `after` is shell text run once it ends. */
  const start = (args: string[], opts: { after?: string; env?: Record<string, string> } = {}) => {
    let out = "";
    const decoder = new TextDecoder();
    const script = `${[process.execPath, CLI, "wrap", "--claude", bin, "--", ...args].map((a) => `'${a}'`).join(" ")}; echo "code=$?"; ${opts.after ?? ""}`;
    const proc = Bun.spawn(["/bin/sh", "-c", script], {
      env: {
        ...process.env,
        RELAY_HOME: home,
        STUB_LOG: logPath,
        RELAY_PTY: "",
        TERM: "xterm-256color",
        ...opts.env,
      },
      terminal: {
        cols: 100,
        rows: 30,
        data(_t: unknown, d: Uint8Array) {
          out += decoder.decode(d, { stream: true });
        },
      },
    } as Parameters<typeof Bun.spawn>[1]);
    procs.push(proc);
    const term = (
      proc as unknown as { terminal: { write(d: string): void; resize(c: number, r: number): void } }
    ).terminal;
    return {
      proc,
      out: () => out,
      type: (d: string) => term.write(d),
      resize: (c: number, r: number) => term.resize(c, r),
    };
  };
  /** The route Claude Code was given, as its hooks would report it. */
  const route = () => {
    const m = /PTY (\S+) TOKEN (\S+)/.exec(log());
    return m ? { socket: m[1] as string, token: m[2] as string } : null;
  };
  const ask = (req: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const r = route();
      if (!r) return reject(new Error("no route"));
      const sock = connect(r.socket);
      let buf = "";
      sock.on("connect", () => sock.write(`${JSON.stringify({ token: r.token, ...req })}\n`));
      sock.on("data", (d) => {
        buf += d.toString();
      });
      sock.on("close", () => resolve(JSON.parse(buf)));
      sock.on("error", reject);
    });
  return { dir, bin, home, log, keys, waitFor, start, route, ask };
}

afterEach(() => {
  for (const p of procs.splice(0)) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already ended
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("wrap arguments", () => {
  test("claude comes from --claude, then RELAY_CLAUDE_BIN", () => {
    expect(parseWrapArgs(["--claude", "/x/claude", "--", "-c"], {})).toEqual({
      claude: "/x/claude",
      rest: ["-c"],
    });
    expect(parseWrapArgs(["--", "--resume", "a"], { RELAY_CLAUDE_BIN: "/y/claude" })).toEqual({
      claude: "/y/claude",
      rest: ["--resume", "a"],
    });
  });

  test("a terminal Relay already owns is not wrapped again", () => {
    expect(insideRelayPty({ RELAY_PTY: "/h/pty/w-123.sock" })).toBe(true);
    expect(insideRelayPty({ RELAY_PTY: "/h/pty/h-0a1b2c3d.sock" })).toBe(true);
    expect(insideRelayPty({ RELAY_PTY: "/h/pty/123.sock" })).toBe(false);
    expect(insideRelayPty({})).toBe(false);
  });
});

describe("what counts as typing", () => {
  test("replies to queries, focus and mouse reports are not typing", () => {
    expect(typedPart("\x1b[I\x1b[O")).toBe("");
    expect(typedPart("\x1b[?62;4c\x1b[12;40R")).toBe("");
    expect(typedPart("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe("");
    expect(typedPart("\x1b[<0;10;5M\x1b[<0;10;5m")).toBe("");
    expect(typedPart("a\x1b[Ib")).toBe("ab");
    expect(typedPart("\x1b[A")).toBe("\x1b[A");
  });
});

describe("terminal modes", () => {
  test("what a crashed program left on is turned off, and nothing else", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[>1u\x1b[?1049h");
    m.feed("\x1b[?1049l\x1b[?2004");
    m.feed("l");
    expect(m.undo()).toBe("\x1b[<1u\x1b[?1000l\x1b[?1006l\x1b[?25h");
    const clean = new TerminalModes();
    clean.feed("\x1b[?2004h\x1b[?2004l\x1b[>1u\x1b[<u");
    expect(clean.undo()).toBe("");
  });
});

describe("relay wrap", () => {
  test("keys, paste, mouse and focus reports reach Claude Code unchanged", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => w.out().includes("❯"))).toBe(true);
    const sent = "hi \x1b[200~pa\nsted\x1b[201~ \x1b[<0;1;1M\x1b[I\x1b[Z";
    w.type(sent);
    expect(await t.waitFor(() => t.keys().length >= sent.length)).toBe(true);
    expect(t.keys()).toBe(sent);
    expect(t.log()).toContain("TTY yes");
    w.type("/exit\r");
    await w.proc.exited;
  });

  test("a phone message arrives as typed keys, with Stop and Enter keys", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => t.route() !== null)).toBe(true);
    expect(t.route()?.socket).toContain("/pty/w-");
    const reply = await t.ask({ text: "fix the build", pid: 1, force: true });
    expect(reply).toEqual({ ok: true });
    expect(await t.waitFor(() => t.keys().endsWith("\x1b[200~fix the build\x1b[201~\r"))).toBe(true);
    expect(await t.ask({ key: "escape", pid: 1 })).toEqual({ ok: true });
    expect(await t.ask({ key: "enter", pid: 1 })).toEqual({ ok: true });
    expect(await t.waitFor(() => t.keys().endsWith("\x1b\r"))).toBe(true);
    const screen = (await t.ask({ op: "screen" })) as { ok: boolean; screen: string };
    expect(screen.screen).toContain("❯");
    expect(await t.ask({ text: "x", pid: 1, token: "wrong" })).toEqual({ ok: false, reason: "auth" });
    w.type("/exit\r");
    await w.proc.exited;
  });

  test("a message typed while the person has a draft stashes it first, and goes in at once", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => t.route() !== null)).toBe(true);
    w.type("my own draft");
    expect(await t.waitFor(() => t.keys() === "my own draft")).toBe(true);
    const asked = Date.now();
    expect(await t.ask({ text: "from the phone", pid: 1 })).toEqual({ ok: true, ...{} });
    expect(Date.now() - asked).toBeLessThan(1500);
    expect(await t.waitFor(() => t.keys().endsWith("\x13\x1b[200~from the phone\x1b[201~\r"))).toBe(true);
    expect(t.keys().startsWith("my own draft")).toBe(true);
    w.type("/exit\r");
    await w.proc.exited;
  }, 20_000);

  test("a window resize reaches Claude Code", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => t.log().includes("SIZE 100x30"))).toBe(true);
    w.resize(132, 41);
    expect(await t.waitFor(() => t.log().includes("SIZE 132x41"))).toBe(true);
    w.type("/exit\r");
    await w.proc.exited;
  });

  test("Ctrl-C is a key for Claude Code and doesn't end the wrapper", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => w.out().includes("❯"))).toBe(true);
    w.type("\x03");
    expect(await t.waitFor(() => t.keys() === "\x03")).toBe(true);
    await Bun.sleep(200);
    expect(w.out()).not.toContain("code=");
    w.type("/exit\r");
    await w.proc.exited;
    expect(w.out()).toContain("code=0");
  });

  test("Ctrl-Z stops the wrapper with Claude Code, and continuing brings both back", async () => {
    const t = setup();
    const w = t.start(["--"], { after: "" });
    expect(await t.waitFor(() => w.out().includes("❯"))).toBe(true);
    const state = async () => {
      const ps = Bun.spawn(["ps", "-o", "stat=", "-p", String(wrapperPid())], { stdout: "pipe" });
      return (await new Response(ps.stdout).text()).trim();
    };
    const wrapperPid = () => Number(/w-(\d+)\.sock/.exec(t.route()?.socket ?? "")?.[1]);
    w.type("\x1a");
    for (let i = 0; i < 100 && !(await state()).startsWith("T"); i++) await Bun.sleep(50);
    expect((await state()).startsWith("T")).toBe(true);
    expect(wrapperPid()).toBeGreaterThan(1);
    process.kill(wrapperPid(), "SIGCONT");
    expect(await t.waitFor(() => w.out().includes("continued"))).toBe(true);
    w.type("again");
    expect(await t.waitFor(() => t.keys().endsWith("again"))).toBe(true);
    w.type("\x15/exit\r");
    await w.proc.exited;
  }, 20_000);

  test("Claude Code's exit code is the wrapper's", async () => {
    const t = setup();
    const w = t.start(["exit", "7"]);
    await w.proc.exited;
    expect(w.out()).toContain("code=7");
    const s = setup();
    const x = s.start([], { env: { STUB_CODE: "3" } });
    expect(await s.waitFor(() => x.out().includes("❯"))).toBe(true);
    x.type("/exit\r");
    await x.proc.exited;
    expect(x.out()).toContain("code=3");
  });

  test("the terminal is given back after Claude Code dies with modes on", async () => {
    const t = setup();
    const w = t.start(["crash"], {
      after: "stty -a | grep -o -e '-icanon' -e ' icanon' -e '-echo ' -e ' echo '",
    });
    await w.proc.exited;
    const out = w.out();
    expect(out).toContain("code=137");
    for (const undo of ["\x1b[<1u", "\x1b[?1000l", "\x1b[?1006l", "\x1b[?2004l", "\x1b[?25h"])
      expect(out).toContain(undo);
    expect(out).toContain(" icanon");
    expect(out).not.toContain("-icanon");
  });

  test("a hangup ends Claude Code and the terminal is given back", async () => {
    const t = setup();
    const w = t.start([], { after: "stty -a | grep -o -e '-icanon' -e ' icanon'" });
    expect(await t.waitFor(() => w.out().includes("❯"))).toBe(true);
    const pid = Number(/w-(\d+)\.sock/.exec(t.route()?.socket ?? "")?.[1]);
    expect(pid).toBeGreaterThan(1);
    process.kill(pid, "SIGHUP");
    await w.proc.exited;
    expect(w.out()).toContain("code=129");
    expect(w.out()).toContain(" icanon");
  });

  test("the socket is gone after Claude Code ends", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => t.route() !== null)).toBe(true);
    const socket = t.route()?.socket as string;
    expect(existsSync(socket)).toBe(true);
    w.type("/exit\r");
    await w.proc.exited;
    expect(existsSync(socket)).toBe(false);
  });
});

describe("without Relay", () => {
  test("no daemon running: Claude Code starts and takes keys", async () => {
    const t = setup();
    const w = t.start([]);
    expect(await t.waitFor(() => w.out().includes("❯"))).toBe(true);
    w.type("ok");
    expect(await t.waitFor(() => t.keys() === "ok")).toBe(true);
    w.type("\x7f\x7f/exit\r");
    await w.proc.exited;
  });

  test("Relay's folder can't be made: Claude Code still starts, without the route", async () => {
    const t = setup();
    writeFileSync(t.home, "a file where the folder should be");
    const w = t.start([]);
    expect(await t.waitFor(() => w.out().includes("❯"))).toBe(true);
    expect(t.log()).toContain("PTY  TOKEN  TTY");
    w.type("hi");
    expect(await t.waitFor(() => t.keys() === "hi")).toBe(true);
    w.type("\x7f\x7f/exit\r");
    await w.proc.exited;
  });

  test("with no terminal (a pipe, claude -p) it runs claude directly and passes the code on", async () => {
    const t = setup();
    const proc = Bun.spawn([process.execPath, CLI, "wrap", "--claude", t.bin, "--", "exit", "5"], {
      env: { ...process.env, RELAY_HOME: t.home, STUB_LOG: join(t.dir, "stub.log"), RELAY_PTY: "" },
      stdin: "pipe",
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(5);
    expect(t.log()).toContain('START ["exit","5"] PTY  TOKEN  TTY no');
  });

  test("no claude installed: a plain message and 127", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "wrap", "--", "-p"], {
      env: { ...process.env, RELAY_CLAUDE_BIN: "", PATH: "/nonexistent" },
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(127);
    expect(await new Response(proc.stderr).text()).toContain("isn't installed");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostLauncher } from "../src/daemon/terminalHost.ts";
import { type AttachIO, attachTo, chatList, pickChat, runningChats } from "../src/shell/ptyAttach.ts";
import { Attachers, parseAttach, readHostState } from "../src/shell/ptyHost.ts";

// `relay attach` against a real `relay host` that runs a stub in place of Claude Code.

const CLI = join(import.meta.dir, "../src/cli.ts");
const STUB = join(import.meta.dir, "support/stub-claude.ts");
const dirs: string[] = [];
const hostPids: number[] = [];

async function startChat(id = "abcd1234") {
  const dir = mkdtempSync(join(tmpdir(), "relay-attach-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(bin, 0o755);
  const log = join(dir, "stub.log");
  process.env.STUB_LOG = log;
  const home = join(dir, "pty");
  const launcher = hostLauncher({ dir: home, self: [process.execPath, CLI] });
  const pane = await launcher.launch([bin], dir, id);
  const state = readHostState(home, id);
  if (state) hostPids.push(state.hostPid);
  await waitFor(() => existsSync(log));
  return { dir, home, log, pane, launcher };
}

class Window {
  input = new EventEmitter();
  out = "";
  cols = 100;
  rows = 30;
  private resizeCb: () => void = () => {};
  result: Promise<string>;
  constructor(socket: string, token: string) {
    const io: AttachIO = {
      socket,
      token,
      size: () => ({ cols: this.cols, rows: this.rows }),
      stdin: this.input as AttachIO["stdin"],
      write: (d) => {
        this.out += typeof d === "string" ? d : Buffer.from(d).toString("utf8");
      },
      onResize: (cb) => {
        this.resizeCb = cb;
      },
    };
    this.result = attachTo(io);
  }
  type(text: string) {
    this.input.emit("data", Buffer.from(text));
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizeCb();
  }
}

const waitFor = async (check: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !check(); ) await Bun.sleep(25);
  return check();
};
const sizes = (log: string) =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("SIZE "))
        .map((l) => l.slice(5))
    : [];
const keys = (log: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("KEYS "))
    .map((l) => JSON.parse(l.slice(5)) as string)
    .join("");

afterEach(() => {
  for (const pid of hostPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.STUB_LOG;
});

describe("relay attach: a real host", () => {
  test("shows the screen at once, takes keys, and detaching leaves the chat running", async () => {
    const { pane, log, launcher } = await startChat();
    const w = new Window(pane.socket, pane.token);
    expect(await waitFor(() => w.out.includes("redrawn 100x30"))).toBe(true);
    expect(w.out).toContain("❯");
    w.type("hi");
    expect(await waitFor(() => existsSync(log) && keys(log).includes("hi"))).toBe(true);
    w.type("\x1d");
    expect(await w.result).toBe("detached");
    expect(w.out).not.toContain("\x1d");
    // the window size goes back, and the chat still answers
    expect(await waitFor(() => sizes(log).at(-1) === "120x40")).toBe(true);
    expect((await launcher.look(pane))?.exited).toBe(false);
    await launcher.close(pane);
  });

  test("a resized window resizes the chat", async () => {
    const { pane, log, launcher } = await startChat();
    const w = new Window(pane.socket, pane.token);
    await waitFor(() => w.out.includes("redrawn 100x30"));
    w.resize(90, 25);
    expect(await waitFor(() => sizes(log).includes("90x25"))).toBe(true);
    w.type("\x1d");
    await w.result;
    await launcher.close(pane);
  });

  test("a window the chat's own size still makes it redraw", async () => {
    const { pane, launcher } = await startChat();
    const w = new Window(pane.socket, pane.token);
    w.cols = 120;
    w.rows = 40;
    expect(await waitFor(() => w.out.includes("redrawn"))).toBe(true);
    w.type("\x1d");
    await w.result;
    await launcher.close(pane);
  });

  test("two windows both see the chat, and one leaving leaves the other", async () => {
    const { pane, launcher, log } = await startChat();
    const a = new Window(pane.socket, pane.token);
    await waitFor(() => a.out.includes("redrawn 100x30"));
    const b = new Window(pane.socket, pane.token);
    b.cols = 80;
    b.rows = 24;
    await waitFor(() => b.out.includes("redrawn 80x24"));
    a.type("x");
    await waitFor(() => keys(log).includes("x"));
    // the stub doesn't echo; a redraw reaches both
    a.resize(100, 31);
    await waitFor(() => sizes(log).includes("100x31"));
    b.type("\x1d");
    expect(await b.result).toBe("detached");
    expect((await launcher.look(pane))?.exited).toBe(false);
    a.type("y");
    expect(await waitFor(() => keys(log).includes("xy"))).toBe(true);
    a.type("\x1d");
    expect(await a.result).toBe("detached");
    expect(await waitFor(() => sizes(log).at(-1) === "120x40")).toBe(true);
    await launcher.close(pane);
  });

  test("closing the window without the detach key leaves the chat running", async () => {
    const { pane, launcher } = await startChat();
    const w = new Window(pane.socket, pane.token);
    await waitFor(() => w.out.includes("redrawn"));
    w.input.emit("end");
    expect(await w.result).toBe("detached");
    expect((await launcher.look(pane))?.exited).toBe(false);
    await launcher.close(pane);
  });

  test("the window learns when the chat ends", async () => {
    const { pane } = await startChat();
    const w = new Window(pane.socket, pane.token);
    await waitFor(() => w.out.includes("redrawn"));
    w.type("/exit\r");
    expect(await w.result).toBe("ended");
  });

  test("a phone message goes in at once, also while the attached window types", async () => {
    const { pane, log, launcher } = await startChat();
    const w = new Window(pane.socket, pane.token);
    await waitFor(() => w.out.includes("redrawn"));
    w.type("a\r");
    const t0 = Date.now();
    const reply = await new Promise<string>((resolve) => {
      const sock = connect(pane.socket);
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
      });
      sock.on("close", () => resolve(buf));
      sock.on("connect", () =>
        sock.write(`${JSON.stringify({ token: pane.token, pid: pane.pid, text: "from phone" })}\n`),
      );
    });
    expect(reply).toContain('"ok":true');
    expect(Date.now() - t0).toBeLessThan(1800);
    expect(keys(log)).toContain("from phone");
    w.type("\x1d");
    await w.result;
    await launcher.close(pane);
  });

  test("a wrong token is refused", async () => {
    const { pane, launcher } = await startChat();
    const w = new Window(pane.socket, "nope");
    expect(await w.result).toBe("refused");
    await launcher.close(pane);
  });
});

describe("choosing a chat", () => {
  const sessions = [
    { id: "abcd1234-0000", name: "Fix login", project: "app", status: "idle" },
    { id: "ffff9999-0000", name: null, project: "site", status: "ended" },
    { id: "eeee5555-0000", name: "Fix logout", project: "app", status: "idle" },
  ];
  const chat = (id: string, name: string | null) => ({
    id,
    name,
    state: { socket: "s", token: "t", pid: 1, hostPid: 1 },
  });
  const chats = [chat("abcd1234", "Fix login"), chat("eeee5555", "Fix logout")];

  test("by id prefix or part of the name", () => {
    expect(pickChat("abc", chats, sessions)).toMatchObject({ chat: { id: "abcd1234" } });
    expect(pickChat("logout", chats, sessions)).toMatchObject({ chat: { id: "eeee5555" } });
    expect(pickChat("abcd1234-0000", chats, sessions)).toMatchObject({ chat: { id: "abcd1234" } });
  });

  test("an ambiguous name asks for more", () => {
    expect(pickChat("fix", chats, sessions)).toMatchObject({
      error: expect.stringContaining("More than one"),
    });
  });

  test("an ended or unknown chat says so and suggests resuming", () => {
    expect(pickChat("ffff", chats, sessions)).toEqual({
      error: "That chat isn't running in Relay's terminal. To continue it: claude --resume ffff9999-0000",
    });
    expect(pickChat("zzz", chats, sessions)).toMatchObject({
      error: expect.stringContaining("claude --resume"),
    });
  });

  test("the list names running chats", () => {
    expect(chatList(chats)).toBe("abcd1234  Fix login\neeee5555  Fix logout");
    expect(chatList([])).toContain("No chats");
  });

  test("only chats with a living host are listed", async () => {
    const { home, pane, launcher } = await startChat("live1234");
    writeFileSync(
      join(home, "h-dead0000.json"),
      JSON.stringify({ socket: "x", token: "t", pid: 1, hostPid: 2_000_000_000 }),
    );
    expect(runningChats(home, []).map((c) => c.id)).toEqual(["live1234"]);
    await launcher.close(pane);
  });
});

describe("host attach requests", () => {
  test("parseAttach checks token and size", () => {
    expect(parseAttach('{"op":"attach","token":"t","cols":80,"rows":24}', "t")).toEqual({
      cols: 80,
      rows: 24,
    });
    expect(parseAttach('{"op":"attach","token":"x","cols":80,"rows":24}', "t")).toBe("auth");
    expect(parseAttach('{"op":"attach","token":"t","cols":2,"rows":24}', "t")).toBeNull();
    expect(parseAttach('{"op":"screen","token":"t"}', "t")).toBeNull();
  });

  test("the chat takes the newest window's size and gives it back in order", () => {
    const a = new Attachers<string>({ cols: 120, rows: 40 });
    expect(a.add("a", 100, 30)).toEqual({ cols: 100, rows: 30 });
    expect(a.add("b", 80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(a.remove("b")).toEqual({ cols: 100, rows: 30 });
    expect(a.remove("a")).toEqual({ cols: 120, rows: 40 });
  });

  test("an older window leaving doesn't change the size", () => {
    const a = new Attachers<string>({ cols: 120, rows: 40 });
    a.add("a", 100, 30);
    a.add("b", 80, 24);
    expect(a.remove("a")).toBeNull();
    expect(a.update("b", 90, 25)).toEqual({ cols: 90, rows: 25 });
    expect(a.remove("b")).toEqual({ cols: 120, rows: 40 });
  });
});

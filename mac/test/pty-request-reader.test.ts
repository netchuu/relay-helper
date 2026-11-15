import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { typeIntoPty } from "../src/daemon/inject.ts";
import { answerRequest, type RequestContext, RequestReader } from "../src/shell/ptyShell.ts";

// A request longer than one socket chunk (8 KB) must reach the terminal whole, whatever script it is in.

describe("relay shell: long requests over the socket", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.listen> | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-pty-"));
  });
  afterEach(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  /** The socket server of `relay shell`, with the terminal replaced by a list of what was typed. */
  function serve(): string[] {
    const written: string[] = [];
    let t = 100_000;
    const ctx: RequestContext = {
      token: "tok",
      shellPid: 1,
      isForeground: async () => true,
      lastInput: () => 0,
      hasDraft: () => false,
      sentEnter: () => {},
      pasteOn: () => true,
      write: (d) => void written.push(d),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    } as RequestContext;
    server = Bun.listen<{ reader: RequestReader }>({
      unix: join(dir, "s.sock"),
      socket: {
        open(sock) {
          sock.data = { reader: new RequestReader() };
        },
        async data(sock, chunk) {
          const line = sock.data.reader.push(chunk);
          if (line === null || line === "overflow") return;
          sock.end(`${JSON.stringify(await answerRequest(line, ctx))}\n`);
        },
      },
    });
    return written;
  }

  test.each([
    ["Cyrillic", "Привет, мир! ".repeat(3_000)],
    ["emoji", "😀🎉".repeat(8_100)],
    ["Chinese", "你好世界".repeat(5_400)],
  ])("%s, over 64,000 bytes: typed with no U+FFFD", async (_name, text) => {
    expect(Buffer.byteLength(text)).toBeGreaterThan(64_000 - 1);
    const written = serve();
    const reply = await typeIntoPty(join(dir, "s.sock"), "tok", 7, text);
    expect(reply).toMatchObject({ ok: true });
    const typed = written.join("");
    expect(typed).not.toContain("�");
    expect(typed).toContain(text);
  });

  test("a short message is typed as before", async () => {
    const written = serve();
    expect(await typeIntoPty(join(dir, "s.sock"), "tok", 7, "hello")).toMatchObject({ ok: true });
    expect(written.join("")).toContain("hello");
  });

  test("a character split across chunks is decoded whole", () => {
    const bytes = new TextEncoder().encode("a€\n");
    const reader = new RequestReader();
    expect(reader.push(bytes.slice(0, 2))).toBeNull();
    expect(reader.push(bytes.slice(2))).toBe("a€");
  });

  test("a request that never ends is cut off", () => {
    const reader = new RequestReader();
    expect(reader.push(new Uint8Array(RequestReader.MAX_CHARS + 1).fill(97))).toBe("overflow");
  });
});

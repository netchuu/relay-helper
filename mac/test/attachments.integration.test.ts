import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_BYTES,
  type AttachmentRef,
  type AttachmentUpload,
  type RelayEvent,
} from "../../protocol/index.ts";
import { freePort } from "./support/local-worker.ts";

/**
 * Attachments sent from a phone, over the real daemon and hook client: files uploaded in chunks (through the admin
 * socket, as `relay send --attach` does, and over a phone's WebSocket), sent into a test session's inbox with and
 * without text, every refusal the phone shows, the turn that lists them, and `relay send --attach`.
 */
const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const HOME = join(ROOT, `relay-at-${process.pid}`);
const PORT = freePort();
const REPO = resolve(import.meta.dir, "../..");
const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}
const SOCK = join(HOME, "hook.sock");
const SID = "attach-sess-1";
const INBOX = join(HOME, "inbox.sock");
let daemon: ReturnType<typeof Bun.spawn> | null = null;
let inbox: Server;
/** What each delivery wrote to the session's inbox: the message's text. */
const delivered: string[] = [];

type Outcome<T> = { result?: T; error?: { code: string; message: string } };

async function call<T>(method: string, params: object = {}): Promise<Outcome<T>> {
  const res = await fetch("http://relay/admin/rpc", {
    method: "POST",
    unix: SOCK,
    body: JSON.stringify({ method, params }),
  });
  return (await res.json()) as Outcome<T>;
}

async function admin<T>(method: string, params: object = {}): Promise<T> {
  const body = await call<T>(method, params);
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function runHook(payload: object, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    env: { ...env, ...extraEnv },
  });
  await proc.exited;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting");
}

const base = (event: string, sessionId = SID) => ({
  session_id: sessionId,
  hook_event_name: event,
  cwd: REPO,
  transcript_path: "/nonexistent.jsonl",
});
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

/** Uploads like a phone: begin, every chunk, end. */
async function upload(bytes: Uint8Array, name: string, sessionId = SID): Promise<AttachmentRef> {
  const up = await admin<AttachmentUpload>("attachment.begin", {
    sessionId,
    name,
    mime: name.endsWith(".png") ? "image/png" : "application/pdf",
    size: bytes.length,
    sha256: sha(bytes),
  });
  for (let index = 0; index < up.chunks; index++) {
    const data = Buffer.from(bytes.subarray(index * up.chunkSize, (index + 1) * up.chunkSize)).toString(
      "base64",
    );
    await admin("attachment.chunk", { id: up.id, index, data });
  }
  return admin<AttachmentRef>("attachment.end", { id: up.id });
}

/** The text of the next message the inbox gets. */
async function nextDelivery(before: number): Promise<string> {
  return waitFor(async () => delivered[before]);
}

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: PORT, claudeBin: "/usr/bin/false", preferTyping: false }),
  );
  inbox = createServer((c) => {
    let data = "";
    c.on("data", (d) => {
      data += d.toString();
    });
    c.on("end", () => {
      const lines = data
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const user = lines.find((l) => l.type === "user");
      if (user) delivered.push(user.message.content as string);
    });
  });
  await new Promise<void>((r) => inbox.listen(INBOX, r));
  daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
    env,
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(() => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok));
  await runHook(base("SessionStart"), {
    CLAUDE_CODE_MESSAGING_SOCKET: INBOX,
    CLAUDE_CODE_MESSAGING_TOKEN: "tok-att",
  });
}, 30_000);

afterAll(() => {
  daemon?.kill();
  inbox?.close();
  rmSync(HOME, { recursive: true, force: true });
});

describe("attachments through the real daemon", () => {
  let photo: AttachmentRef;
  let pdf: AttachmentRef;

  test("uploads land under ~/.relay/attachments/<session>/ with 0600", async () => {
    const png = randomBytes(ATTACHMENT_CHUNK_BYTES + 321);
    photo = await upload(png, "screenshot.png");
    pdf = await upload(randomBytes(4000), "Cart totals.pdf");
    expect(photo.path.startsWith(join(HOME, "attachments", SID, ""))).toBe(true);
    expect(photo.path.endsWith("-screenshot.png")).toBe(true);
    expect(sha(readFileSync(photo.path))).toBe(sha(png));
    expect(statSync(photo.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(HOME, "attachments", SID)).mode & 0o777).toBe(0o700);
  });

  test("only attachments: the paths are the message", async () => {
    const before = delivered.length;
    const res = await admin<{ via: string }>("session.send", {
      sessionId: SID,
      text: "",
      attachments: [photo.id],
    });
    expect(res.via).toBe("socket");
    expect(await nextDelivery(before)).toBe(
      `📱 From the user, sent from their phone via Relay:\n${photo.path}`,
    );
  });

  test("text and attachments: the text, then each path on its own line, never quoted: saved names have no spaces", async () => {
    const before = delivered.length;
    await admin("session.send", {
      sessionId: SID,
      text: "Why is the total off?",
      attachments: [photo.id, pdf.id],
    });
    expect(await nextDelivery(before)).toBe(
      `📱 From the user, sent from their phone via Relay:\nWhy is the total off?\n${photo.path}\n${pdf.path}`,
    );
  });

  test("every limit is refused with a plain sentence", async () => {
    const eleven: string[] = [];
    for (let i = 0; i < 11; i++) eleven.push((await upload(randomBytes(16), `n${i}.png`)).id);
    expect((await call("session.send", { sessionId: SID, text: "", attachments: eleven })).error).toEqual({
      code: "bad_request",
      message: "You can attach up to 10 files to one message.",
    });
    const begin = (p: object) =>
      call("attachment.begin", { sessionId: SID, name: "f.bin", size: 1, sha256: "0".repeat(64), ...p });
    expect((await begin({ name: "big.mov", size: ATTACHMENT_MAX_BYTES + 1 })).error).toEqual({
      code: "bad_request",
      message: "big.mov is too large. Files can be up to 50 MB.",
    });
    expect((await begin({ name: "../../.ssh/authorized_keys" })).error).toEqual({
      code: "bad_request",
      message: "This file's name can't be used. Rename the file and try again.",
    });
    expect((await begin({ sessionId: "no-such-session" })).error).toEqual({
      code: "not_found",
      message: "This session has ended, so files can't be sent to it.",
    });
    // A bad hash.
    const bytes = randomBytes(100);
    const up = await admin<AttachmentUpload>("attachment.begin", {
      sessionId: SID,
      name: "bad.png",
      size: 100,
      sha256: sha(randomBytes(100)),
    });
    await admin("attachment.chunk", { id: up.id, index: 0, data: bytes.toString("base64") });
    expect((await call("attachment.end", { id: up.id })).error).toEqual({
      code: "conflict",
      message: "bad.png didn't arrive intact. Send it again.",
    });
    expect(
      (await call("session.send", { sessionId: SID, text: "", attachments: [up.id] })).error?.message,
    ).toBe("bad.png hasn't finished uploading.");
    expect((await call("session.send", { sessionId: SID, text: "" })).error).toEqual({
      code: "bad_request",
      message: "Type a message or attach a file.",
    });
    expect(
      (await call("session.send", { sessionId: "nope", text: "", attachments: [photo.id] })).error,
    ).toEqual({
      code: "not_found",
      message: "This session has ended, so files can't be sent to it.",
    });
  });

  test("the turn lists the attachments its prompt has, live and finished", async () => {
    const typed = `📱 From the user, sent from their phone via Relay:\nWhy is the total off?\n${photo.path}\n${pdf.path}`;
    await runHook({ ...base("UserPromptSubmit"), prompt: typed });
    const live = await admin<{ turnId: string; attachments?: AttachmentRef[] }>("session.live", {
      sessionId: SID,
    });
    expect(live.attachments).toEqual([photo, pdf]);
    const sync = await admin<{ events: RelayEvent[] }>("sync", { sinceSeq: 1 });
    const started = sync.events.find((e) => e.type === "turn.started" && e.turnId === live.turnId);
    expect(started && "attachments" in started ? started.attachments : null).toEqual([photo, pdf]);
    await runHook({
      ...base("Stop"),
      last_assistant_message: "The PDF rounds per line.",
      background_tasks: [],
    });
    const turns = await admin<{ id: string; attachments?: AttachmentRef[]; prompt: string }[]>(
      "session.turns",
      {
        sessionId: SID,
      },
    );
    expect(turns[0]?.attachments).toEqual([photo, pdf]);
    expect(turns[0]?.prompt).toBe(typed);
    const done = (await admin<{ events: RelayEvent[] }>("sync", { sinceSeq: 1 })).events.find(
      (e) => e.type === "turn.done" && e.turn.id === turns[0]?.id,
    );
    expect(done?.type === "turn.done" ? done.turn.attachments : null).toEqual([photo, pdf]);
  });

  test("a phone's WebSocket carries full chunks, and fetches the file and its pieces back", async () => {
    const { code } = (await fetch("http://relay/admin/pair", { method: "POST", unix: SOCK }).then((r) =>
      r.json(),
    )) as { code: string };
    const { token } = (await fetch(`http://127.0.0.1:${PORT}/pair`, {
      method: "POST",
      body: JSON.stringify({ code, deviceName: "Attach Phone" }),
    }).then((r) => r.json())) as { token: string };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: { authorization: `Bearer ${token}` },
    } as never);
    const frames: { type: string; id?: number; result?: unknown; error?: { message: string } }[] = [];
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));
    let next = 1;
    const rpc = async <T>(method: string, params: object) => {
      const id = next++;
      ws.send(JSON.stringify({ id, method, params }));
      const f = await waitFor(async () => frames.find((x) => x.type === "rpc" && x.id === id));
      if (f.error) throw new Error(f.error.message);
      return f.result as T;
    };
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES * 2);
    const up = await rpc<AttachmentUpload>("attachment.begin", {
      sessionId: SID,
      name: "from-phone.png",
      mime: "image/png",
      size: bytes.length,
      sha256: sha(bytes),
    });
    // Sent at once, the second chunk twice: repeats are harmless.
    await Promise.all(
      [0, 1, 1].map((index) =>
        rpc("attachment.chunk", {
          id: up.id,
          index,
          data: bytes.subarray(index * up.chunkSize, (index + 1) * up.chunkSize).toString("base64"),
        }),
      ),
    );
    const ref = await rpc<AttachmentRef>("attachment.end", { id: up.id });
    expect(await rpc<AttachmentRef>("attachment.end", { id: up.id })).toEqual(ref);
    const parts: Buffer[] = [];
    for (let index = 0; index < 2; index++) {
      const got = await rpc<{ data: string; sha256: string; chunks: number }>("attachment.get", {
        id: ref.id,
        index,
      });
      expect(got.chunks).toBe(2);
      expect(got.sha256).toBe(sha(bytes));
      parts.push(Buffer.from(got.data, "base64"));
    }
    expect(sha(Buffer.concat(parts))).toBe(sha(bytes));
    ws.close();
  });

  test("relay send --attach uploads local files and sends them with the text", async () => {
    const file = join(HOME, "notes from cli.txt");
    writeFileSync(file, "hello from the CLI\n");
    const before = delivered.length;
    const proc = Bun.spawn(
      ["bun", join(REPO, "mac/src/cli.ts"), "send", SID, "--attach", file, "Read", "this"],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("delivered via socket");
    const text = await nextDelivery(before);
    const path = text.split("\n").at(-1)?.replace(/^"|"$/g, "") ?? "";
    expect(text).toMatch(
      /^📱 From the user, sent from their phone via Relay:\nRead this\n\S+-notes_from_cli\.txt$/,
    );
    expect(readFileSync(path, "utf8")).toBe("hello from the CLI\n");
    // Only a file, no text.
    const only = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "send", SID, "--attach", file], {
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await only.exited).toBe(0);
    expect(await nextDelivery(before + 1)).toMatch(/\n\S+-notes_from_cli\.txt$/);
  }, 20_000);

  test("a picked file removed before Send is discarded: unfinished or saved, and then it can't be sent", async () => {
    const saved = await upload(randomBytes(2000), "removed.pdf");
    expect(existsSync(saved.path)).toBe(true);
    expect(await admin("attachment.discard", { id: saved.id })).toEqual({ id: saved.id, discarded: true });
    expect(existsSync(saved.path)).toBe(false);
    expect(
      (await call("session.send", { sessionId: SID, text: "", attachments: [saved.id] })).error?.message,
    ).toBe("One of the files is no longer on the computer. Attach it again.");
    const bytes = randomBytes(ATTACHMENT_CHUNK_BYTES + 5);
    const up = await admin<AttachmentUpload>("attachment.begin", {
      sessionId: SID,
      name: "half.pdf",
      size: bytes.length,
      sha256: sha(bytes),
    });
    expect(await admin("attachment.discard", { id: up.id })).toEqual({ id: up.id, discarded: true });
    expect(existsSync(join(HOME, "attachments", ".partial", up.id))).toBe(false);
    expect(await admin("attachment.discard", { id: up.id })).toEqual({ id: up.id, discarded: false });
  });

  test("an ended session refuses uploads and sends", async () => {
    await runHook(base("SessionEnd"));
    await waitFor(
      async () =>
        (await call("attachment.begin", { sessionId: SID, name: "x", size: 1, sha256: "0".repeat(64) }))
          .error,
    );
    expect(
      (await call("attachment.begin", { sessionId: SID, name: "x", size: 1, sha256: "0".repeat(64) })).error,
    ).toEqual({ code: "not_found", message: "This session has ended, so files can't be sent to it." });
    expect(
      (await call("session.send", { sessionId: SID, text: "", attachments: [photo.id] })).error?.code,
    ).toBe("not_found");
  });
});

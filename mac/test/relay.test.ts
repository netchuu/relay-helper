import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentRef,
  type AttachmentUpload,
  HostInfo,
} from "../../protocol/index.ts";
import {
  connectProof,
  type Identity,
  loadOrCreateIdentity,
  macIdFor,
  PhoneChannel,
  rawPublic,
} from "../src/daemon/e2e.ts";
import { freePort, type LocalWorker, startLocalWorker } from "./support/local-worker.ts";

/**
 * The whole relay path: the real Worker (wrangler dev, local), the real daemon, and a phone written
 * in TypeScript speaking the same encrypted protocol as the phone apps. Includes attack cases.
 */
const REPO = resolve(import.meta.dir, "../..");
const HOME = join(process.env.RELAY_TEST_ROOT ?? "/tmp", `relay-rl-${process.pid}`);
// Ports from the OS, not from the pid: test runs in parallel must not share them.
let workerPort = 0;
const APP_PORT = freePort();
let relayUrl = "";
const SOCK = join(HOME, "hook.sock");

const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}

let worker: LocalWorker | null = null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
  what = "the condition",
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
}

/** A phone: opens a stream through the Worker, does the handshake, then speaks JSON-RPC. */
class TestPhone {
  ws!: WebSocket;
  channel: PhoneChannel;
  inbox: Record<string, unknown>[] = [];
  closed: { code: number } | null = null;
  private nextId = 1;
  private gotHandshake!: Promise<void>;

  constructor(
    private macId: string,
    macKey: Uint8Array,
  ) {
    this.channel = new PhoneChannel(macKey);
  }

  async connect(): Promise<this> {
    this.ws = new WebSocket(`${relayUrl}/v1/connect?role=phone&mac=${this.macId}`);
    this.ws.binaryType = "arraybuffer";
    let resolveHs!: () => void;
    this.gotHandshake = new Promise((r) => (resolveHs = r));
    this.ws.onclose = (e) => (this.closed = { code: e.code });
    this.ws.onmessage = (m) => {
      const bytes = new Uint8Array(m.data as ArrayBuffer);
      if (bytes[0] === 0x02) {
        this.channel.receiveHandshake(bytes);
        resolveHs();
      } else {
        this.inbox.push(JSON.parse(this.channel.open(bytes)));
      }
    };
    await new Promise((r, j) => {
      this.ws.onopen = r;
      this.ws.onerror = j;
    });
    this.ws.send(this.channel.hello());
    await Promise.race([
      this.gotHandshake,
      Bun.sleep(5000).then(() => Promise.reject(new Error("no handshake"))),
    ]);
    return this;
  }

  async call(method: string, params: object = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.ws.send(this.channel.seal(JSON.stringify({ id, method, params })));
    return waitFor(async () => this.inbox.find((m) => m.type === "rpc" && m.id === id), 5000);
  }

  /** Several calls in flight at once (an attachment's chunks); resolves when every reply is in. */
  async callAll(calls: { method: string; params: object }[]): Promise<Record<string, unknown>[]> {
    const ids = calls.map(({ method, params }) => {
      const id = this.nextId++;
      this.ws.send(this.channel.seal(JSON.stringify({ id, method, params })));
      return id;
    });
    const end = Date.now() + 30_000;
    for (;;) {
      const replies = ids.map((id) => this.inbox.find((m) => m.type === "rpc" && m.id === id));
      if (replies.every(Boolean)) {
        this.inbox = this.inbox.filter((m) => !(m.type === "rpc" && ids.includes(m.id as number)));
        return replies as Record<string, unknown>[];
      }
      if (Date.now() > end) throw new Error("timed out waiting for the replies");
      await Bun.sleep(5);
    }
  }
}

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  // Fails at once with wrangler's output when it exits (a taken port, a broken install), else after 60 s.
  worker = await startLocalWorker({ cloudDir: join(REPO, "cloud"), stateDir: join(HOME, "worker"), env });
  workerPort = worker.port;
  relayUrl = `ws://127.0.0.1:${workerPort}`;
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: APP_PORT, claudeBin: "/usr/bin/false", preferTyping: false, relayUrl }),
  );
  daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
    env,
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(
    () => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok),
    20_000,
    `the helper's ${SOCK}`,
  );
}, 90_000);

afterAll(async () => {
  daemon?.kill();
  await worker?.stop();
  rmSync(HOME, { recursive: true, force: true });
});

describe("relay end to end", () => {
  const id = () => loadOrCreateIdentity(join(HOME, "identity.json"));
  let token = "";

  test("pairs over the relay with the code, then talks RPC and receives events", async () => {
    const identity = await waitFor(async () => {
      try {
        return id();
      } catch {
        return null;
      }
    });
    const { code } = (await fetch("http://relay/admin/pair", { method: "POST", unix: SOCK }).then((r) =>
      r.json(),
    )) as {
      code: string;
    };
    // The daemon's relay link may still be connecting: retry until the room answers.
    const phone = await waitFor(async () => {
      const p = new TestPhone(identity.macId, identity.boxPublic);
      return p.connect().catch(() => null);
    });

    const unauth = await phone.call("presence.get");
    expect((unauth.error as { code: string }).code).toBe("unauthorized");

    const paired = await phone.call("pair", { code, deviceName: "Relay Test" });
    token = (paired.result as { token: string }).token;
    expect(token.length).toBeGreaterThan(30);
    // The phone learns what it paired with, so it can say "Mac" or "computer".
    const host = HostInfo.parse((paired.result as { host: unknown }).host);
    expect(host.os).toBe(process.platform === "linux" ? "linux" : "macos");

    const presence = await phone.call("presence.get");
    expect((presence.result as { mode: string }).mode).toBeDefined();

    // "away" is the default (presence.ts), so a change to "here" is what sends an event.
    await phone.call("presence.set", { mode: "here" });
    await waitFor(async () => phone.inbox.find((m) => m.type === "event"));
    phone.ws.close();
  }, 60_000);

  test("a returning phone logs in with its token; a wrong token is refused and the stream dropped", async () => {
    const identity = id();
    const phone = await new TestPhone(identity.macId, identity.boxPublic).connect();
    const hello = (await phone.call("hello", { token })).result as { ok: boolean; host: unknown };
    expect(hello.ok).toBe(true);
    expect(HostInfo.safeParse(hello.host).success).toBe(true);
    // The apps' liveness check.
    expect((await phone.call("ping")).result).toEqual({ ok: true });
    phone.ws.close();

    const intruder = await new TestPhone(identity.macId, identity.boxPublic).connect();
    for (let i = 0; i < 3; i++) await intruder.call("hello", { token: `guess-${i}-${"x".repeat(30)}` });
    await waitFor(async () => intruder.closed);
  }, 30_000);

  test("a 50 MB attachment uploads through the relay in full-size chunks and lands with its hash", async () => {
    // A session to send it to, registered by the real hook client.
    const sessionId = "relay-attach-sess";
    const hook = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
      stdin: new Blob([
        JSON.stringify({
          session_id: sessionId,
          hook_event_name: "SessionStart",
          cwd: REPO,
          transcript_path: "/x.jsonl",
        }),
      ]),
      env,
      stdout: "ignore",
    });
    await hook.exited;
    const identity = id();
    const phone = await new TestPhone(identity.macId, identity.boxPublic).connect();
    expect(((await phone.call("hello", { token })).result as { ok: boolean }).ok).toBe(true);
    const bytes = randomBytes(ATTACHMENT_MAX_BYTES);
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const begin = await phone.call("attachment.begin", {
      sessionId,
      name: "IMG_0001.MOV",
      mime: "video/quicktime",
      size: bytes.length,
      sha256,
    });
    const up = begin.result as AttachmentUpload;
    expect(up.chunks).toBe(400);
    const chunk = (index: number) => ({
      method: "attachment.chunk",
      params: {
        id: up.id,
        index,
        data: bytes.subarray(index * up.chunkSize, (index + 1) * up.chunkSize).toString("base64"),
      },
    });
    // 32 chunks in flight at a time; then the first window again, as a phone retrying over a fresh path would.
    for (let start = 0; start < up.chunks; start += 32) {
      const replies = await phone.callAll(
        Array.from({ length: Math.min(32, up.chunks - start) }, (_, i) => chunk(start + i)),
      );
      expect(replies.every((r) => r.result)).toBe(true);
    }
    await phone.callAll(Array.from({ length: 32 }, (_, i) => chunk(i)));
    const ended = (await phone.call("attachment.end", { id: up.id })).result as AttachmentRef;
    expect(ended.path.startsWith(join(HOME, "attachments", sessionId, ""))).toBe(true);
    expect(statSync(ended.path).mode & 0o777).toBe(0o600);
    expect(statSync(ended.path).size).toBe(ATTACHMENT_MAX_BYTES);
    expect(new Bun.CryptoHasher("sha256").update(readFileSync(ended.path)).digest("hex")).toBe(sha256);
    // A retried end answers the same, and the stream is still open.
    expect((await phone.call("attachment.end", { id: up.id })).result).toEqual(ended);
    expect(phone.closed).toBeNull();
    phone.ws.close();
  }, 120_000);

  test("a phone with the wrong Mac key can't get through (the Mac drops the stream)", async () => {
    const identity = id();
    const fakeKey = rawPublic(generateKeyPairSync("x25519").publicKey);
    const phone = await new TestPhone(identity.macId, fakeKey).connect();
    phone.ws.send(phone.channel.seal(JSON.stringify({ id: 1, method: "hello", params: { token } })));
    await waitFor(async () => phone.closed);
    expect(phone.inbox).toEqual([]);
  }, 30_000);

  test("a phone still gets through when the room holds a dead Mac connection", async () => {
    // A helper that was killed or stalled leaves its socket behind: the room closes it when the new
    // connection arrives, but the close never completes. Phones must reach the new Mac, not crash on the old one.
    const mac = loadOrCreateIdentity(join(HOME, "stale-room-identity.json"));
    const macUrl = () => {
      const p = connectProof(mac);
      return `/v1/connect?role=mac&mac=${mac.macId}&pub=${p.pub}&ts=${p.ts}&sig=${p.sig}`;
    };
    // The dead one: a raw upgrade that never reads or answers anything afterwards.
    let upgraded!: () => void;
    const gotUpgrade = new Promise<void>((r) => (upgraded = r));
    const dead = await Bun.connect({
      hostname: "127.0.0.1",
      port: workerPort,
      socket: {
        data(_s, d) {
          if (Buffer.from(d).toString("latin1").startsWith("HTTP/1.1 101")) upgraded();
        },
      },
    });
    dead.write(
      `GET ${macUrl()} HTTP/1.1\r\nHost: 127.0.0.1:${workerPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await gotUpgrade;

    const live = new WebSocket(`${relayUrl}${macUrl()}`);
    live.binaryType = "arraybuffer";
    const opened: number[] = [];
    live.onmessage = (m) => {
      const bytes = new Uint8Array(m.data as ArrayBuffer);
      if (new DataView(bytes.buffer).getUint32(0) !== 0) return;
      const msg = JSON.parse(new TextDecoder().decode(bytes.subarray(4))) as { type: string; stream: number };
      if (msg.type === "open") opened.push(msg.stream);
    };
    await new Promise((r, j) => {
      live.onopen = r;
      live.onerror = j;
    });

    const phone = new WebSocket(`${relayUrl}/v1/connect?role=phone&mac=${mac.macId}`);
    const phoneOpen = await new Promise<boolean>((r) => {
      phone.onopen = () => r(true);
      phone.onerror = () => r(false);
    });
    expect(phoneOpen).toBe(true);
    await waitFor(async () => opened.length > 0, 5000);
    phone.close();
    live.close();
    dead.end();
  }, 30_000);

  test("the Worker refuses a Mac that can't prove it owns the room", async () => {
    const identity = id();
    const other = generateKeyPairSync("ed25519");
    const otherId = { ...identity, authPrivate: other.privateKey, authPublic: rawPublic(other.publicKey) };
    // Valid signature from a different key, presented for this Mac's room.
    const proof = connectProof({ ...otherId, macId: identity.macId });
    const url = `http://127.0.0.1:${workerPort}/v1/connect?role=mac&mac=${identity.macId}&pub=${proof.pub}&ts=${proof.ts}&sig=${proof.sig}`;
    const res = await fetch(url, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
    expect(macIdFor(otherId.authPublic)).not.toBe(identity.macId);
    // An old timestamp is refused too.
    const stale = connectProof(identity, Date.now() - 10 * 60_000);
    const res2 = await fetch(
      `http://127.0.0.1:${workerPort}/v1/connect?role=mac&mac=${identity.macId}&pub=${stale.pub}&ts=${stale.ts}&sig=${stale.sig}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(res2.status).toBe(401);
  }, 30_000);

  /** A bare Mac and phones for the room's own behaviour: frames recorded, nothing decrypted. */
  function rawRoom(name: string) {
    const mac = loadOrCreateIdentity(join(HOME, `${name}-identity.json`));
    const macUrl = (ts?: number) => {
      const p = connectProof(mac, ts);
      return `${relayUrl}/v1/connect?role=mac&mac=${mac.macId}&pub=${p.pub}&ts=${p.ts}&sig=${p.sig}`;
    };
    const openMac = async (ts?: number) => {
      const ws = new WebSocket(macUrl(ts));
      ws.binaryType = "arraybuffer";
      const got: { stream: number; payload: Uint8Array }[] = [];
      const rec = { ws, got, closed: null as number | null, opened: [] as number[] };
      ws.onclose = (e) => (rec.closed = e.code);
      ws.onmessage = (m) => {
        const b = new Uint8Array(m.data as ArrayBuffer);
        const stream = new DataView(b.buffer).getUint32(0);
        const payload = b.subarray(4);
        if (stream === 0) {
          const msg = JSON.parse(new TextDecoder().decode(payload)) as { type: string; stream: number };
          if (msg.type === "open") rec.opened.push(msg.stream);
        } else got.push({ stream, payload });
      };
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
      });
      return rec;
    };
    const openPhone = (id: string) => {
      const ws = new WebSocket(`${relayUrl}/v1/connect?role=phone&mac=${mac.macId}&phone=${id}`);
      ws.binaryType = "arraybuffer";
      const rec = {
        ws,
        closed: null as number | null,
        got: 0,
        open: new Promise<void>((r) => (ws.onopen = () => r())),
      };
      ws.onclose = (e) => (rec.closed = e.code);
      ws.onmessage = () => rec.got++;
      return rec;
    };
    /** The Mac connects once and leaves: only a room that has had its Mac makes a phone wait. */
    const macWasHere = async () => {
      const m = await openMac();
      m.ws.close();
      await waitFor(async () => m.closed !== null, 5000, "the Mac's close");
    };
    return { mac, macUrl, openMac, openPhone, macWasHere };
  }

  test("a phone in a room its Mac never connected to gets 4404 at once, without waiting", async () => {
    const r = rawRoom("never-room");
    const started = Date.now();
    const phone = r.openPhone("phone-never-one");
    await waitFor(async () => phone.closed, 5000, "the 4404");
    expect(phone.closed).toBe(4404);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  test("a phone that arrives before the Mac waits, and its handshake frame reaches the Mac that comes after", async () => {
    const r = rawRoom("wait-room");
    await r.macWasHere();
    const phone = r.openPhone("phone-wait-one");
    await phone.open;
    const hello = new Uint8Array(33).fill(1);
    phone.ws.send(hello);
    await Bun.sleep(1000);
    expect(phone.closed).toBeNull();
    const mac = await r.openMac();
    await waitFor(
      async () => mac.opened.length === 1 && mac.got.length === 1,
      5000,
      "open and the replayed hello",
    );
    expect([...(mac.got[0]?.payload ?? [])]).toEqual([...hello]);
    expect(phone.closed).toBeNull();
    // The stream works from here on, in both directions.
    const stream = mac.opened[0] as number;
    phone.ws.send(new Uint8Array([5, 6]));
    await waitFor(async () => mac.got.length === 2, 5000, "a frame after the replay");
    const back = new Uint8Array(6);
    new DataView(back.buffer).setUint32(0, stream);
    back.set([9, 9], 4);
    mac.ws.send(back);
    await waitFor(async () => phone.got === 1, 5000, "a frame to the phone");
    phone.ws.close();
    mac.ws.close();
  }, 30_000);

  test("a phone that waits for a Mac that doesn't come gets 4404 after about 8 s", async () => {
    const r = rawRoom("wait-timeout-room");
    await r.macWasHere();
    const started = Date.now();
    const phone = r.openPhone("phone-wait-two");
    await phone.open;
    await Bun.sleep(5000);
    expect(phone.closed).toBeNull();
    await waitFor(async () => phone.closed, 10_000, "the waiting room's 4404");
    expect(phone.closed).toBe(4404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(7500);
  }, 30_000);

  test("a replaced Mac: attached phones get 4002, and a late Mac attempt with an older ts is refused", async () => {
    const r = rawRoom("replace-room");
    const t = Date.now();
    const mac1 = await r.openMac(t);
    const phone = r.openPhone("phone-repl-one");
    await phone.open;
    await waitFor(async () => mac1.opened.length === 1, 5000, "open");
    // A late abandoned attempt (older ts) is refused and leaves the live Mac alone.
    const late = await fetch(r.macUrl(t - 1000).replace("ws://", "http://"), {
      headers: { upgrade: "websocket" },
    });
    expect(late.status).toBe(409);
    expect(mac1.closed).toBeNull();
    expect(phone.closed).toBeNull();
    const mac2 = await r.openMac(t + 1000);
    await waitFor(async () => phone.closed, 5000, "the phone's 4002");
    expect(phone.closed).toBe(4002);
    expect(mac1.closed).toBe(4000);
    mac2.ws.close();
  }, 30_000);

  test("an oversize frame from the Mac closes one phone's stream, not the Mac's socket", async () => {
    const r = rawRoom("oversize-room");
    const mac = await r.openMac();
    const a = r.openPhone("phone-over-aaa");
    const b = r.openPhone("phone-over-bbb");
    await Promise.all([a.open, b.open]);
    await waitFor(async () => mac.opened.length === 2, 5000, "both opens");
    const big = new Uint8Array(4 + 256 * 1024);
    new DataView(big.buffer).setUint32(0, mac.opened[0] as number);
    mac.ws.send(big);
    await waitFor(async () => a.closed || b.closed, 5000, "one phone closed");
    expect([a.closed, b.closed].filter((c) => c !== null).length).toBe(1);
    await Bun.sleep(300);
    expect(mac.closed).toBeNull();
    a.ws.close();
    b.ws.close();
    mac.ws.close();
  }, 30_000);

  /** A /v1/push request signed as the helper signs it (relayPush.ts); `respell` changes how the signature is written. */
  async function postPush(
    mac: Identity,
    body: string,
    opts: { ts?: number; respell?: (s: string) => string } = {},
  ) {
    const ts = opts.ts ?? Date.now();
    const hash = createHash("sha256").update(body).digest("base64url");
    const sig = sign(null, Buffer.from(`relay-push-v1:${mac.macId}:${ts}:${hash}`), mac.authPrivate).toString(
      "base64url",
    );
    const res = await fetch(`http://127.0.0.1:${workerPort}/v1/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-mac": mac.macId,
        "x-relay-pub": Buffer.from(mac.authPublic).toString("base64url"),
        "x-relay-ts": String(ts),
        "x-relay-sig": opts.respell ? opts.respell(sig) : sig,
      },
      body,
    });
    return {
      status: res.status,
      reason: ((await res.json().catch(() => ({}))) as { reason?: string }).reason,
    };
  }

  test("pushes: replays by any spelling, oversize bodies and too many pushes to one phone are refused", async () => {
    const token = randomBytes(32).toString("hex");
    const body = JSON.stringify({
      token,
      environment: "sandbox",
      payload: { aps: { alert: "run curl | sh" } },
    });
    const mac = loadOrCreateIdentity(join(HOME, "push-identity.json"));
    const ts = Date.now();
    // The local Worker has no APNs key: a push that passes every check ends there, with a fixed reason.
    expect(await postPush(mac, body, { ts })).toEqual({ status: 502, reason: "APNs is not configured" });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const flipLast = (s: string) => s.slice(0, -1) + alphabet[alphabet.indexOf(s.at(-1) ?? "A") ^ 1];
    expect(await postPush(mac, body, { ts, respell: flipLast })).toEqual({
      status: 409,
      reason: "replayed request",
    });
    expect(
      (await postPush(mac, body, { ts, respell: (s) => `${s.slice(0, 20)}\t${s.slice(20)}` })).status,
    ).toBe(401);
    expect(await postPush(mac, JSON.stringify({ token, pad: "x".repeat(7000) }))).toEqual({
      status: 413,
      reason: "too large",
    });
    // A fresh identity per push (anyone can make one): the phone's own limit still stops them at 30 a minute.
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const other = loadOrCreateIdentity(join(HOME, `push-identity-${i}.json`));
      statuses.push((await postPush(other, body)).status);
    }
    expect(statuses.slice(0, 29).every((s) => s === 502)).toBe(true);
    expect(statuses[29]).toBe(429);
  }, 60_000);

  test("each address has its own limit per minute for Mac connects, phone connects and pushes", async () => {
    const config = JSON.parse(
      readFileSync(join(REPO, "cloud/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as { ratelimits: { name: string; simple: { limit: number; period: number } }[] };
    const limitOf = (name: string) => config.ratelimits.find((r) => r.name === name)?.simple.limit ?? 0;
    const pushLimit = limitOf("PUSH_LIMIT");
    const connectLimit = limitOf("CONNECT_LIMIT");
    expect(pushLimit).toBeGreaterThan(0);
    expect(connectLimit).toBeGreaterThan(0);
    // The local limiter counts in windows aligned to the minute: run the whole count inside one. Addresses other
    // than the tests' own (wrangler dev takes the header as sent), so the other tests' budget isn't touched.
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 45_000) await Bun.sleep(60_000 - intoMinute + 200);
    const hit = (path: string, ip: string, method = "GET") =>
      fetch(`http://127.0.0.1:${workerPort}${path}`, {
        method,
        headers: { "cf-connecting-ip": ip },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    const a = "203.0.113.10";
    const b = "203.0.113.11";
    // Unsigned pushes: 400 while counted, 429 over the limit. No room is reached either way.
    for (let i = 0; i < pushLimit; i++) expect((await hit("/v1/push", a, "POST")).status).toBe(400);
    const over = await hit("/v1/push", a, "POST");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ reason: "too many requests" });
    // The pushes didn't use up the same address's connects, nor another address's pushes.
    expect((await hit(`/v1/connect?role=phone&mac=${"a".repeat(22)}`, a)).status).toBe(426);
    expect((await hit("/v1/push", b, "POST")).status).toBe(400);
    // Phone connects (without an upgrade: 426 while counted), then the Mac's are still free.
    for (let i = 0; i < connectLimit; i++) expect((await hit("/v1/connect?role=phone", b)).status).toBe(426);
    const tooMany = await hit("/v1/connect?role=phone", b);
    expect(tooMany.status).toBe(429);
    expect(await tooMany.text()).toBe("too many requests");
    expect((await hit("/v1/connect?role=mac", b)).status).toBe(426);
  }, 90_000);
});

import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { DB } from "../src/daemon/db.ts";
import { type Identity, macIdFor, rawPublic } from "../src/daemon/e2e.ts";
import type { EventLog } from "../src/daemon/events.ts";
import { type LinkClock, RelayLink } from "../src/daemon/relayLink.ts";

// A real WebSocket to a peer that stops reading: the link must not call a room silent while a big frame is still going out.

function identity(): Identity {
  const auth = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  const authPublic = rawPublic(auth.publicKey);
  return {
    macId: macIdFor(authPublic),
    authPrivate: auth.privateKey,
    authPublic,
    boxPrivate: box.privateKey,
    boxPublic: rawPublic(box.publicKey),
  } as Identity;
}

class StepClock implements LinkClock {
  t = 1_000_000;
  private tickers: (() => void)[] = [];
  now() {
    return this.t;
  }
  setTimeout() {
    return 0;
  }
  clearTimeout() {}
  setInterval(fn: () => void) {
    this.tickers.push(fn);
    return fn;
  }
  clearInterval(h: unknown) {
    this.tickers = this.tickers.filter((f) => f !== h);
  }
  tick(ms: number) {
    this.t += ms;
    for (const f of [...this.tickers]) f();
  }
}

let server: Server | null = null;
let link: RelayLink | null = null;
afterEach(() => {
  link?.stop();
  server?.close();
});

async function peerThatStopsReading(): Promise<{ url: string; socket: Promise<Socket> }> {
  let resolve!: (s: Socket) => void;
  const socket = new Promise<Socket>((r) => {
    resolve = r;
  });
  server = createServer((s) => {
    s.once("data", (buf) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(buf.toString())![1]!;
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      s.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      s.pause();
      resolve(s);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, socket };
}

async function connected(url: string, clock: StepClock) {
  let ws!: WebSocket;
  link = new RelayLink(
    url,
    identity(),
    { rpc: async () => ({ result: null }), events: {} as EventLog, db: {} as DB } as never,
    {
      clock,
      networkSignature: () => "net",
      createSocket: (u) => {
        ws = new WebSocket(u);
        return ws;
      },
    },
  );
  link.start();
  for (let i = 0; i < 200 && ws?.readyState !== WebSocket.OPEN; i++) await Bun.sleep(10);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  return ws;
}

function sendBig(bytes: number) {
  (link as unknown as { sendFrame(id: number, p: Uint8Array): void }).sendFrame(1, new Uint8Array(bytes));
}

test("a room pong held up behind a big frame on a real socket does not drop the link", async () => {
  const { url, socket } = await peerThatStopsReading();
  const clock = new StepClock();
  const ws = await connected(url, clock);
  await socket;
  sendBig(7_000_000);
  // Bun's bufferedAmount stays 0 here, so the guard can't rest on it.
  for (let i = 0; i < 4; i++) clock.tick(5000);
  expect(ws.readyState).toBe(WebSocket.OPEN);
});

test("a room that never answers is still dropped once the frame could have left", async () => {
  const { url, socket } = await peerThatStopsReading();
  const clock = new StepClock();
  const ws = await connected(url, clock);
  await socket;
  sendBig(7_000_000);
  for (let i = 0; i < 20; i++) clock.tick(5000);
  expect(ws.readyState).not.toBe(WebSocket.OPEN);
});

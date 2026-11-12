import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The helper pings its relay connection every keepalive interval and
// drops a link whose pong hasn't come back by the next ping, so a dead link is noticed within two intervals. A slow
// but alive relay (pong late, yet before the next ping) keeps the link. The interval is read once at start-up from
// RELAY_KEEPALIVE_MS, so each case runs the real RelayLink in a child process with a short interval, against a
// minimal WebSocket server here that answers pings when it's told to.

const INTERVAL = 300;

type Peer = { opened: number; closed: number | null; pings: number; roomPings: number };

/** A WebSocket server that answers each ping after `pongDelay` ms (null: never). Records each connection. */
function relayServer(pongDelay: number | null, roomPongs = 0) {
  const peers: Peer[] = [];
  const listener = Bun.listen<{ buf: Buffer; upgraded: boolean; peer: Peer | null }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: Buffer.alloc(0), upgraded: false, peer: null };
      },
      data(s, chunk) {
        s.data.buf = Buffer.concat([s.data.buf, Buffer.from(chunk)]);
        if (!s.data.upgraded) {
          const text = s.data.buf.toString("latin1");
          const end = text.indexOf("\r\n\r\n");
          if (end < 0) return;
          const key = /sec-websocket-key:\s*(\S+)/i.exec(text)?.[1] ?? "";
          const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          s.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          );
          s.data.upgraded = true;
          s.data.peer = { opened: Date.now(), closed: null, pings: 0, roomPings: 0 };
          peers.push(s.data.peer);
          s.data.buf = s.data.buf.subarray(end + 4);
        }
        // Client frames: FIN/opcode, masked length, mask, payload.
        while (s.data.buf.length >= 2) {
          const b = s.data.buf;
          const opcode = b[0]! & 0x0f;
          let len = b[1]! & 0x7f;
          let off = 2;
          if (len === 126) {
            if (b.length < 4) return;
            len = b.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (b.length < 10) return;
            len = Number(b.readBigUInt64BE(2));
            off = 10;
          }
          const masked = (b[1]! & 0x80) !== 0;
          const total = off + (masked ? 4 : 0) + len;
          if (b.length < total) return;
          const mask = masked ? b.subarray(off, off + 4) : null;
          const payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), total));
          if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
          s.data.buf = b.subarray(total);
          if (opcode === 0x9) {
            const peer = s.data.peer!;
            peer.pings++;
            if (pongDelay !== null)
              setTimeout(() => {
                if (peer.closed === null)
                  s.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
              }, pongDelay);
          } else if (opcode === 0x2 && s.data.peer) {
            // The room's own control channel: a ping on stream 0 is answered with a pong while `roomPongs` last.
            const text = Buffer.from(payload.subarray(4)).toString();
            if (payload.readUInt32BE(0) === 0 && text.includes('"ping"')) {
              if (s.data.peer.roomPings++ < roomPongs) {
                const body = Buffer.concat([Buffer.alloc(4), Buffer.from('{"type":"pong","stream":0}')]);
                s.write(Buffer.concat([Buffer.from([0x82, body.length]), body]));
              }
            }
          } else if (opcode === 0x8) {
            s.end();
          }
        }
      },
      close(s) {
        if (s.data.peer && s.data.peer.closed === null) s.data.peer.closed = Date.now();
      },
    },
  });
  return { port: listener.port, peers, stop: () => listener.stop(true) };
}

const CHILD = `
import { generateKeyPairSync } from "node:crypto";
import { macIdFor, rawPublic } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/e2e.ts"))};
import { RelayLink } from ${JSON.stringify(join(import.meta.dir, "../src/daemon/relayLink.ts"))};
const auth = generateKeyPairSync("ed25519");
const box = generateKeyPairSync("x25519");
const authPublic = rawPublic(auth.publicKey);
const identity = { macId: macIdFor(authPublic), authPrivate: auth.privateKey, authPublic, boxPrivate: box.privateKey, boxPublic: rawPublic(box.publicKey) };
const deps = { rpc: async () => ({ result: null }), events: {}, db: {} };
new RelayLink(process.env.RELAY_URL, identity, deps).start();
setInterval(() => {}, 1000);
`;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function runHelperLink(port: number) {
  const child = Bun.spawn(["bun", "-e", CHILD], {
    env: { ...process.env, RELAY_KEEPALIVE_MS: String(INTERVAL), RELAY_URL: `ws://127.0.0.1:${port}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanup.push(() => child.kill());
  return child;
}

async function waitFor(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
}

test("a relay that never answers pings is dropped within two intervals, and the helper connects again", async () => {
  const server = relayServer(null);
  cleanup.push(server.stop);
  runHelperLink(server.port);
  await waitFor(() => server.peers.length >= 1, 5000);
  expect(server.peers.length).toBeGreaterThanOrEqual(1);
  await waitFor(() => server.peers[0]!.closed !== null, INTERVAL * 6);
  const first = server.peers[0]!;
  expect(first.closed).not.toBeNull();
  // Ping at 1 interval, missed pong noticed at the next: about 2 intervals after it opened, never 3+.
  const lived = first.closed! - first.opened;
  expect(lived).toBeGreaterThanOrEqual(INTERVAL * 1.5);
  expect(lived).toBeLessThan(INTERVAL * 3);
  expect(first.pings).toBe(1);
  // The reconnect backoff is about a second.
  await waitFor(() => server.peers.length >= 2, 3000);
  expect(server.peers.length).toBeGreaterThanOrEqual(2);
}, 15_000);

test("a slow but alive relay (pong late, still before the next ping) keeps the link", async () => {
  const server = relayServer(Math.round(INTERVAL * 0.7), 1000);
  cleanup.push(server.stop);
  runHelperLink(server.port);
  await waitFor(() => server.peers.length >= 1, 5000);
  await Bun.sleep(INTERVAL * 7);
  expect(server.peers.length).toBe(1);
  expect(server.peers[0]!.closed).toBeNull();
  expect(server.peers[0]!.pings).toBeGreaterThanOrEqual(5);
}, 15_000);

test("a pong that comes back after the next ping is due counts as a dead link", async () => {
  const server = relayServer(Math.round(INTERVAL * 1.5));
  cleanup.push(server.stop);
  runHelperLink(server.port);
  await waitFor(() => server.peers.length >= 1, 5000);
  await waitFor(() => server.peers[0]!.closed !== null, INTERVAL * 6);
  const first = server.peers[0]!;
  expect(first.closed).not.toBeNull();
  expect(first.closed! - first.opened).toBeLessThan(INTERVAL * 3);
}, 15_000);

// The edge answers protocol pings itself, so a link can pass them while the room's code no longer hears the
// helper and phones never reach it. A room that answered control pings and then stops is a dead link.
test("a room that answered the helper's control ping and then stops is dropped, though the edge still pongs", async () => {
  const server = relayServer(0, 2);
  cleanup.push(server.stop);
  runHelperLink(server.port);
  await waitFor(() => server.peers.length >= 1, 5000);
  await waitFor(() => server.peers[0]!.closed !== null, INTERVAL * 8);
  const first = server.peers[0]!;
  expect(first.closed).not.toBeNull();
  expect(first.roomPings).toBe(4);
  await waitFor(() => server.peers.length >= 2, 3000);
  expect(server.peers.length).toBeGreaterThanOrEqual(2);
}, 15_000);

// The room's pong is required from the first ping (an older Worker that never answers is dropped, not trusted),
// within two intervals.
test("a room that never answers a control ping is dropped within three intervals, though the edge pongs", async () => {
  const server = relayServer(0, 0);
  cleanup.push(server.stop);
  runHelperLink(server.port);
  await waitFor(() => server.peers.length >= 1, 5000);
  await waitFor(() => server.peers[0]!.closed !== null, INTERVAL * 6);
  const first = server.peers[0]!;
  expect(first.closed).not.toBeNull();
  expect(first.closed! - first.opened).toBeLessThan(INTERVAL * 4);
  expect(first.roomPings).toBe(2);
  await waitFor(() => server.peers.length >= 2, 3000);
  expect(server.peers.length).toBeGreaterThanOrEqual(2);
}, 15_000);

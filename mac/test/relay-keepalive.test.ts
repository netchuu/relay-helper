import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { DB } from "../src/daemon/db.ts";
import { macIdFor, rawPublic } from "../src/daemon/e2e.ts";
import type { EventLog } from "../src/daemon/events.ts";
import { type LinkClock, RelayLink } from "../src/daemon/relayLink.ts";
import { waitFor } from "./support/wait.ts";

// The helper pings its relay link and drops it when the room's answer misses two pings. RelayLink runs here on a
// clock the test steps, against a real socket, so the number of pings before a drop is the same on a busy Mac.

/** Each tick() runs every interval once; timeouts (the reconnect backoff) fire when `advance` passes them. */
class StepClock implements LinkClock {
  t = 1_000_000;
  private tickers: (() => void)[] = [];
  private timeouts: { at: number; fn: () => void }[] = [];
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const h = { at: this.t + ms, fn };
    this.timeouts.push(h);
    return h;
  }
  clearTimeout(h: unknown) {
    this.timeouts = this.timeouts.filter((x) => x !== h);
  }
  setInterval(fn: () => void) {
    this.tickers.push(fn);
    return fn;
  }
  clearInterval(h: unknown) {
    this.tickers = this.tickers.filter((f) => f !== h);
  }
  tick() {
    this.t += 5000;
    for (const f of [...this.tickers]) f();
  }
  advance(ms: number) {
    this.t += ms;
    for (const h of this.timeouts.filter((x) => x.at <= this.t)) {
      this.clearTimeout(h);
      h.fn();
    }
  }
}

type Peer = {
  closed: boolean;
  pings: number;
  roomPings: number;
  pongs: number;
  held: (() => void)[];
  write: (frame: Buffer) => void;
};

/**
 * A WebSocket server that answers protocol pings at once (or never) and the room's control pings while
 * `roomPongs` last. With `late`, a room pong waits in `held` until the test calls it.
 */
function relayServer(edgePongs: boolean, roomPongs = 0, late = false) {
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
          s.data.peer = {
            closed: false,
            pings: 0,
            roomPings: 0,
            pongs: 0,
            held: [],
            write: (f) => void s.write(f),
          };
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
            if (edgePongs) s.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          } else if (opcode === 0x2 && s.data.peer) {
            // The room's own control channel: a ping on stream 0 is answered with a pong while `roomPongs` last.
            const text = Buffer.from(payload.subarray(4)).toString();
            if (payload.readUInt32BE(0) === 0 && text.includes('"ping"')) {
              if (s.data.peer.roomPings++ < roomPongs) {
                const body = Buffer.concat([Buffer.alloc(4), Buffer.from('{"type":"pong","stream":0}')]);
                const send = () => {
                  if (!s.data.peer!.closed) s.write(Buffer.concat([Buffer.from([0x82, body.length]), body]));
                };
                if (late) s.data.peer.held.push(send);
                else send();
              }
            }
          } else if (opcode === 0xa) {
            if (s.data.peer) s.data.peer.pongs++;
          } else if (opcode === 0x8) {
            s.end();
          }
        }
      },
      close(s) {
        if (s.data.peer) s.data.peer.closed = true;
      },
    },
  });
  return { port: listener.port, peers, stop: () => listener.stop(true) };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function startLink(port: number) {
  const auth = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  const authPublic = rawPublic(auth.publicKey);
  const identity = {
    macId: macIdFor(authPublic),
    authPrivate: auth.privateKey,
    authPublic,
    boxPrivate: box.privateKey,
    boxPublic: rawPublic(box.publicKey),
  };
  const clock = new StepClock();
  const link = new RelayLink(
    `ws://127.0.0.1:${port}`,
    identity,
    { rpc: async () => ({ result: null }), events: {} as EventLog, db: {} as DB } as never,
    { clock, networkSignature: () => "net" },
  );
  link.start();
  cleanup.push(() => link.stop());
  return clock;
}

/** One keepalive interval: the link sends its pings (or drops), and we wait until the server saw what it should. */
async function tick(clock: StepClock, peer: Peer, expectRoomPings: number | "drop") {
  clock.tick();
  if (expectRoomPings === "drop") await waitFor(() => peer.closed, 30_000, "the link to drop");
  else await waitFor(() => peer.roomPings === expectRoomPings, 30_000, `${expectRoomPings} room pings`);
}

/** Releases the held room pongs, then pings the link: its pong comes after them on the same stream, so they are handled. */
async function release(peer: Peer) {
  for (const send of peer.held.splice(0)) send();
  const before = peer.pongs;
  peer.write(Buffer.from([0x89, 0]));
  await waitFor(() => peer.pongs > before, 30_000, "the link to handle the pongs");
}

async function connect(edgePongs: boolean, roomPongs: number, late = false) {
  const server = relayServer(edgePongs, roomPongs, late);
  cleanup.push(server.stop);
  const clock = startLink(server.port);
  const peer = await waitFor(() => server.peers[0], 30_000, "the helper to connect");
  return { server, clock, peer };
}

async function reconnects(server: { peers: Peer[] }, clock: StepClock) {
  clock.advance(5_000);
  await waitFor(() => server.peers.length >= 2, 30_000, "a second connection");
}

test("a relay that never answers pings is dropped on the third interval, and the helper connects again", async () => {
  const { server, clock, peer } = await connect(false, 0);
  await tick(clock, peer, 1);
  await tick(clock, peer, 2);
  await tick(clock, peer, "drop");
  expect(peer.pings).toBe(2);
  await reconnects(server, clock);
});

test("a room whose pong comes after the next ping keeps the link", async () => {
  const { server, clock, peer } = await connect(true, 1000, true);
  await tick(clock, peer, 1);
  for (let n = 2; n <= 8; n++) {
    await tick(clock, peer, n);
    await release(peer);
  }
  expect(server.peers.length).toBe(1);
  expect(peer.closed).toBe(false);
});

// The edge answers protocol pings itself, so a link can pass them while the room's code no longer hears the
// helper and phones never reach it. A room that answered control pings and then stops is a dead link.
test("a room that answered the helper's control ping and then stops is dropped, though the edge still pongs", async () => {
  const { server, clock, peer } = await connect(true, 2);
  await tick(clock, peer, 1);
  await tick(clock, peer, 2);
  await tick(clock, peer, 3);
  await tick(clock, peer, 4);
  await tick(clock, peer, "drop");
  expect(peer.roomPings).toBe(4);
  await reconnects(server, clock);
});

test("a room whose answers come an interval late and then stop is dropped all the same", async () => {
  const { server, clock, peer } = await connect(true, 2, true);
  await tick(clock, peer, 1);
  await tick(clock, peer, 2);
  await release(peer);
  await tick(clock, peer, 3);
  await tick(clock, peer, 4);
  await tick(clock, peer, "drop");
  expect(peer.roomPings).toBe(4);
  await reconnects(server, clock);
});

// The room's pong is required from the first ping (an older Worker that never answers is dropped, not trusted),
// within two intervals.
test("a room that never answers a control ping is dropped on the third interval, though the edge pongs", async () => {
  const { server, clock, peer } = await connect(true, 0);
  await tick(clock, peer, 1);
  await tick(clock, peer, 2);
  await tick(clock, peer, "drop");
  expect(peer.roomPings).toBe(2);
  await reconnects(server, clock);
});

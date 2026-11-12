import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { DB } from "../src/daemon/db.ts";
import { type Identity, macIdFor, rawPublic } from "../src/daemon/e2e.ts";
import type { EventLog } from "../src/daemon/events.ts";
import { backoffDelay, type LinkClock, RelayLink } from "../src/daemon/relayLink.ts";

// How fast the helper gets back on the relay. The link runs on a fake clock and fake sockets, so every
// schedule is exact and no test waits in real time.

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

const deps = { rpc: async () => ({ result: null }), events: {} as EventLog, db: {} as DB } as never;

class FakeClock implements LinkClock {
  t = 1_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  setInterval(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers.delete(h as number);
  }
  clearInterval(h: unknown) {
    this.timers.delete(h as number);
  }
  /** Moves time forward, firing timers in order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, tm] of this.timers) if (tm.at <= end && tm.at < nextAt) [nextId, nextAt] = [id, tm.at];
      if (nextId < 0) break;
      const tm = this.timers.get(nextId)!;
      this.t = Math.max(this.t, nextAt);
      if (tm.every) tm.at = this.t + tm.every;
      else this.timers.delete(nextId);
      tm.fn();
    }
    this.t = Math.max(this.t, end);
  }
  /** The machine slept: wall-clock time passes, no timer fires meanwhile. */
  sleep(ms: number) {
    this.t += ms;
  }
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  pings = 0;
  sent: Uint8Array[] = [];
  terminated = false;
  closedWith: number | null = null;
  private pongListeners: (() => void)[] = [];
  addEventListener(type: string, fn: () => void) {
    if (type === "pong") this.pongListeners.push(fn);
  }
  ping() {
    this.pings++;
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
    // Like Bun: onclose doesn't follow promptly, so nothing here may depend on it.
  }
  // test controls
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail(message: string) {
    this.readyState = 3;
    this.onerror?.({ message });
    this.onclose?.({ code: 1006 });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  pong() {
    for (const l of this.pongListeners) l();
  }
  roomPong() {
    const body = new TextEncoder().encode('{"type":"pong","stream":0}');
    const frame = new Uint8Array(4 + body.length);
    frame.set(body, 4);
    this.onmessage?.({ data: frame.buffer });
  }
}

// WebSocket.OPEN / CONNECTING are read from the global in the link: they match the fake's numbers.

function setup(over: { random?: () => number; net?: { v: string } } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const net = over.net ?? { v: "wifi" };
  const link = new RelayLink("ws://relay.test", identity(), deps, {
    clock,
    random: over.random ?? (() => 0.5),
    networkSignature: () => net.v,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
  });
  return { clock, sockets, link, net };
}

let current: RelayLink | null = null;
afterEach(() => current?.stop());

/** Runs the link with a live room: edge and room both answer every ping. */
function keepAlive(clock: FakeClock, s: FakeSocket, ms: number) {
  for (let i = 0; i < ms / 1000; i++) {
    clock.advance(1000);
    if (s.pings > 0) {
      s.pong();
      s.roomPong();
    }
  }
}

test("backoff: 0.5 s doubling to 5 s after fast failures, cap 15 s otherwise, jitter inside the cap", () => {
  // jitter 1 = the top of the range, 0 = the bottom (60%)
  expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffDelay(n, true, 1))).toEqual([
    500, 1000, 2000, 4000, 5000, 5000, 5000,
  ]);
  expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffDelay(n, false, 1))).toEqual([
    1000, 2000, 4000, 8000, 15000, 15000, 15000,
  ]);
  for (let i = 0; i < 200; i++) {
    const j = Math.random();
    for (const n of [0, 3, 12]) {
      expect(backoffDelay(n, true, j)).toBeLessThanOrEqual(5000);
      expect(backoffDelay(n, false, j)).toBeLessThanOrEqual(15000);
      expect(backoffDelay(n, true, j)).toBeGreaterThanOrEqual(0.6 * Math.min(5000, 500 * 2 ** n) - 1);
    }
  }
});

test("fast failures retry on the 0.5 s to 5 s schedule and reset on open", () => {
  const { clock, sockets, link } = setup({ random: () => 0.999 });
  current = link;
  link.start();
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    const before = clock.now();
    sockets.at(-1)!.fail("ECONNREFUSED");
    const n = sockets.length;
    while (sockets.length === n) clock.advance(10);
    seen.push(Math.round((clock.now() - before) / 10) * 10);
  }
  expect(seen).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  sockets.at(-1)!.open();
  expect(link.connected).toBe(true);
});

test("a slow failure (connect timeout) backs off from 1 s up to the 15 s cap", () => {
  const { clock, sockets, link } = setup({ random: () => 0.999 });
  current = link;
  link.start();
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = sockets.length;
    clock.advance(8000); // connect timeout: 8 s
    expect(sockets.at(n - 1)!.terminated).toBe(true);
    const from = clock.now();
    while (sockets.length === n) clock.advance(10);
    seen.push(Math.round((clock.now() - from) / 100) * 100);
  }
  expect(seen).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
});

test("the first retry after a link that had been up is immediate (under 250 ms) and attempt resets", () => {
  const { clock, sockets, link } = setup({ random: () => 0.999 });
  current = link;
  link.start();
  sockets[0]!.fail("x");
  clock.advance(5000);
  sockets[1]!.open();
  keepAlive(clock, sockets[1]!, 3000);
  const before = clock.now();
  sockets[1]!.serverClose(1006);
  while (sockets.length < 3) clock.advance(10);
  expect(clock.now() - before).toBeLessThanOrEqual(250);
  // the failure after that starts the schedule over at 0.5 s
  const t0 = clock.now();
  sockets[2]!.fail("x");
  while (sockets.length < 4) clock.advance(10);
  expect(clock.now() - t0).toBeLessThanOrEqual(510);
});

test("a dead link (no pong) reconnects without a 2 s wait for onclose", () => {
  const { clock, sockets, link } = setup({ random: () => 0.5 });
  current = link;
  link.start();
  sockets[0]!.open();
  // pings at 5 s and 10 s; the second tick finds the first unanswered and drops
  clock.advance(10_000);
  const droppedAt = clock.now();
  expect(sockets[0]!.terminated).toBe(true);
  expect(link.connected).toBe(false);
  while (sockets.length < 2) clock.advance(10);
  // retry delay is 0 to 250 ms, never the old 2 s
  expect(clock.now() - droppedAt).toBeLessThanOrEqual(250);
});

test("a room that never answers its control ping is dropped within two intervals of the first ping", () => {
  const { clock, sockets, link } = setup();
  current = link;
  link.start();
  const s = sockets[0]!;
  s.open();
  for (let i = 0; i < 20; i++) {
    clock.advance(1000);
    if (s.pings > 0) s.pong(); // the edge always answers
    if (s.terminated) break;
  }
  // first ping at 5 s, dropped at 15 s: ping, one missed interval, second missed interval
  expect(s.terminated).toBe(true);
  expect(s.sent.length).toBe(2);
});

test("a wake while connected reconnects at once", () => {
  const { clock, sockets, link } = setup();
  current = link;
  link.start();
  sockets[0]!.open();
  keepAlive(clock, sockets[0]!, 2000);
  clock.sleep(60_000);
  clock.advance(1000); // the watchdog tick arrives late
  expect(sockets[0]!.terminated).toBe(true);
  expect(sockets.length).toBe(2);
});

test("a wake during backoff skips the rest of the timer", () => {
  const { clock, sockets, link } = setup({ random: () => 0.999 });
  current = link;
  link.start();
  // three slow failures: the next wait is 8 s
  for (let i = 0; i < 4; i++) {
    const n = sockets.length;
    clock.advance(8000);
    while (sockets.length === n && i < 3) clock.advance(100);
  }
  const n = sockets.length;
  expect(link.connected).toBe(false);
  clock.sleep(30_000);
  clock.advance(1000);
  expect(sockets.length).toBe(n + 1);
});

test("a network change reconnects at once, during backoff and while connected", () => {
  const { clock, sockets, link, net } = setup({ random: () => 0.999 });
  current = link;
  link.start();
  // five attempts time out: the wait before the sixth is about 12 s
  for (let i = 0; i < 5; i++) {
    const n = sockets.length;
    clock.advance(8000);
    while (sockets.length === n && i < 4) clock.advance(100);
  }
  expect(sockets.length).toBe(5);
  net.v = "hotspot";
  clock.advance(2000);
  expect(sockets.length).toBe(6); // did not wait out the rest of the 12 s
  sockets[5]!.open();
  keepAlive(clock, sockets[5]!, 3000);
  net.v = "wifi";
  keepAlive(clock, sockets[5]!, 2000);
  expect(sockets[5]!.terminated).toBe(true);
  expect(sockets.length).toBe(7);
  // no change: no reconnect
  sockets[6]!.open();
  keepAlive(clock, sockets[6]!, 10_000);
  expect(sockets.length).toBe(7);
});

test("a late attempt that opens after being given up is closed, and a single 4000 retries normally", () => {
  const { clock, sockets, link } = setup({ random: () => 0.5 });
  current = link;
  link.start();
  clock.advance(8000); // gave up on attempt 1
  expect(sockets[0]!.terminated).toBe(true);
  sockets[0]!.open(); // it opens anyway
  expect(sockets[0]!.closedWith).toBe(1000);
  expect(link.connected).toBe(false);
  while (sockets.length < 2) clock.advance(100);
  sockets[1]!.open();
  // the room closed the live one with 4000 because of the late attempt: one 4000 is not a second daemon
  const before = clock.now();
  sockets[1]!.serverClose(4000);
  while (sockets.length < 3) clock.advance(10);
  expect(clock.now() - before).toBeLessThanOrEqual(250);
});

test("only a second 4000 in a row waits 30 s", () => {
  const { clock, sockets, link } = setup({ random: () => 0.5 });
  current = link;
  link.start();
  sockets[0]!.open();
  sockets[0]!.serverClose(4000);
  clock.advance(300);
  expect(sockets.length).toBe(2);
  sockets[1]!.open();
  sockets[1]!.serverClose(4000);
  clock.advance(29_000);
  expect(sockets.length).toBe(2);
  clock.advance(1500);
  expect(sockets.length).toBe(3);
  // a different close resets the count
  sockets[2]!.open();
  sockets[2]!.serverClose(1006);
  clock.advance(300);
  expect(sockets.length).toBe(4);
  sockets[3]!.open();
  sockets[3]!.serverClose(4000);
  clock.advance(300);
  expect(sockets.length).toBe(5);
});

test("stop cancels the watchdog, timers and pending attempt", () => {
  const { clock, sockets, link, net } = setup();
  link.start();
  sockets[0]!.fail("x");
  link.stop();
  net.v = "other";
  clock.advance(60_000);
  expect(sockets.length).toBe(1);
});

// Time to reconnect, measured on the fake clock (RELAY_PRINT_TIMES=1 prints the times).
test("time to reconnect: short blip, long outage, wake while connected, wake during backoff", () => {
  const times: Record<string, number> = {};
  const measure = (label: string, trigger: (c: FakeClock, s: FakeSocket[], net: { v: string }) => void) => {
    const { clock, sockets, link, net } = setup({ random: () => 0.5 });
    link.start();
    sockets[0]!.open();
    keepAlive(clock, sockets[0]!, 3000);
    const before = clock.now();
    trigger(clock, sockets, net);
    const woke = label.startsWith("wake") ? clock.now() : before;
    const n = sockets.length;
    let guard = 0;
    while (sockets.length === n && guard++ < 100_000) clock.advance(10);
    times[label] = clock.now() - woke;
    link.stop();
  };
  measure("blip", (_c, s) => s[0]!.serverClose(1006));
  measure("wake while connected", (c) => {
    c.sleep(120_000); // timed from the moment the machine wakes
  });
  expect(times.blip!).toBeLessThanOrEqual(250);
  expect(times["wake while connected"]!).toBeLessThanOrEqual(1000);

  // long outage: every attempt fails fast, then the network comes back (the interface list changes)
  {
    const { clock, sockets, link, net } = setup({ random: () => 0.5 });
    link.start();
    for (let i = 0; i < 12; i++) {
      const n = sockets.length;
      sockets.at(-1)!.fail("ENETUNREACH");
      while (sockets.length === n) clock.advance(100);
    }
    const n = sockets.length;
    sockets.at(-1)!.fail("ENETUNREACH");
    const before = clock.now();
    net.v = "back";
    while (sockets.length === n) clock.advance(100);
    times["network back after a long outage"] = clock.now() - before;
    expect(times["network back after a long outage"]!).toBeLessThanOrEqual(2100);
    link.stop();
  }
  // wake during backoff (deep in the schedule)
  {
    const { clock, sockets, link } = setup({ random: () => 0.999 });
    link.start();
    for (let i = 0; i < 8; i++) {
      const n = sockets.length;
      sockets.at(-1)!.fail("x");
      while (sockets.length === n) clock.advance(100);
    }
    const n = sockets.length;
    sockets.at(-1)!.fail("x");
    clock.sleep(30_000);
    const before = clock.now();
    while (sockets.length === n) clock.advance(100);
    times["wake during backoff"] = clock.now() - before;
    expect(times["wake during backoff"]!).toBeLessThanOrEqual(1100);
    link.stop();
  }
  if (process.env.RELAY_PRINT_TIMES) console.log(JSON.stringify(times));
});

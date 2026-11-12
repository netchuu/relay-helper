import { afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";

// The relay room with fake sockets. A phone that reconnects (an LTE drop leaves its old socket half-open on the
// room's side) must still get in: it replaces its own earlier socket by the id it sends, many phones behind one
// carrier address are fine, the total stays capped, and the helper's ping is answered by the room itself.

class FakeSocket {
  readyState = 1;
  closed: { code: number; reason: string } | null = null;
  sent: Uint8Array[] = [];
  attachment: unknown = null;
  tags: string[] = [];
  /** A socket the room closed stays listed until the close completes: it never does here, like a dead path. */
  accept() {}
  /** Set to make send() throw, like a socket that closed between the room's check and its send. */
  throwOnSend = false;
  send(data: Uint8Array) {
    if (this.throwOnSend) throw new Error("socket is closed");
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 2;
  }
  serializeAttachment(a: unknown) {
    this.attachment = a;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

class FakeState {
  sockets: FakeSocket[] = [];
  alarm: number | null = null;
  data = new Map<string, unknown>();
  /** Storage writes, alarms included: what a made-up room must not cost. */
  writes = 0;
  storage = {
    get: async (k: string) => this.data.get(k),
    put: async (k: string, v: unknown) => {
      this.writes++;
      this.data.set(k, v);
    },
    getAlarm: async () => this.alarm,
    setAlarm: async (at: number) => {
      this.writes++;
      this.alarm = at;
    },
  };
  getWebSockets(tag?: string) {
    return this.sockets.filter((s) => !tag || s.tags.includes(tag));
  }
  getTags(ws: FakeSocket) {
    return ws.tags;
  }
  acceptWebSocket(ws: FakeSocket, tags: string[]) {
    ws.tags = tags;
    this.sockets.push(ws);
  }
}

let lastServer: FakeSocket;
let Room: new (
  ctx: FakeState,
  env: unknown,
) => {
  fetch(r: Request): Promise<Response>;
  webSocketMessage(ws: FakeSocket, m: ArrayBuffer | string): Promise<void>;
  webSocketClose(ws: FakeSocket, code: number): Promise<void>;
  webSocketError(ws: FakeSocket): Promise<void>;
  alarm(): Promise<void>;
};

beforeAll(async () => {
  mock.module("cloudflare:workers", () => ({
    DurableObject: class {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
    },
  }));
  // biome-ignore lint/suspicious/noExplicitAny: a fake of the Workers runtime's pair
  (globalThis as any).WebSocketPair = class {
    0 = new FakeSocket();
    1 = new FakeSocket();
    constructor() {
      lastServer = this[1];
    }
  };
  // By a variable, so the root typecheck doesn't pull the Worker (and its runtime types) in.
  const worker = "../../cloud/src/index.ts";
  Room = (await import(worker)).Room as typeof Room;
});

const MAC = "a".repeat(22);

/** A connect that the room may refuse before upgrading (a stale Mac): the response, and the server socket. */
function connectRaw(
  room: InstanceType<typeof Room>,
  role: string,
  opts: { phone?: string; ip?: string; ts?: number } = {},
) {
  const url = new URL(`https://relay.test/v1/connect?role=${role}&mac=${MAC}`);
  if (opts.ts !== undefined) url.searchParams.set("ts", String(opts.ts));
  if (opts.phone) url.searchParams.set("phone", opts.phone);
  const headers = new Headers({ "cf-connecting-ip": opts.ip ?? "10.0.0.1" });
  return room
    .fetch(new Request(url.toString(), { headers }))
    .then((response) => ({ response, server: lastServer }));
}

function connect(
  room: InstanceType<typeof Room>,
  role: string,
  opts: { phone?: string; ip?: string; ts?: number } = {},
) {
  const url = new URL(`https://relay.test/v1/connect?role=${role}&mac=${MAC}`);
  if (opts.ts !== undefined) url.searchParams.set("ts", String(opts.ts));
  if (opts.phone) url.searchParams.set("phone", opts.phone);
  const headers = new Headers({ "cf-connecting-ip": opts.ip ?? "10.0.0.1" });
  return room.fetch(new Request(url.toString(), { headers })).then(() => lastServer);
}

function control(sock: FakeSocket) {
  return sock.sent
    .filter((f) => new DataView(f.buffer, f.byteOffset).getUint32(0) === 0)
    .map((f) => JSON.parse(new TextDecoder().decode(f.subarray(4))) as { type: string; stream: number });
}

function newRoom() {
  const state = new FakeState();
  const room = new Room(state, {});
  return { state, room };
}

test("a phone that reconnects many times without its old sockets closing is still let in", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  let last!: FakeSocket;
  for (let i = 0; i < 20; i++) last = await connect(room, "phone", { phone: "phone-one-id" });
  expect(last.closed).toBeNull();
  const opens = control(mac).filter((m) => m.type === "open");
  expect(opens.length).toBe(20);
  // Each earlier stream was closed toward the helper as the next one opened.
  expect(control(mac).filter((m) => m.type === "closed").length).toBe(19);
});

test("phones without an id: eight behind one address get in, the ninth is refused", async () => {
  const { room } = newRoom();
  await connect(room, "mac");
  const phones: FakeSocket[] = [];
  for (let i = 0; i < 8; i++) phones.push(await connect(room, "phone", { ip: "100.64.0.1" }));
  expect(phones.every((p) => p.closed === null)).toBe(true);
  const ninth = await connect(room, "phone", { ip: "100.64.0.1" });
  expect(ninth.closed?.code).toBe(4429);
});

test("phones with ids behind one carrier address are all let in, up to the total cap", async () => {
  const { room } = newRoom();
  await connect(room, "mac");
  for (let i = 0; i < 32; i++) {
    const p = await connect(room, "phone", { phone: `phone-id-${i}-xxxx`, ip: "100.64.0.1" });
    expect(p.closed).toBeNull();
  }
  const over = await connect(room, "phone", { phone: "phone-id-over-xx", ip: "100.64.0.1" });
  expect(over.closed?.code).toBe(4429);
  // A phone already in the room reconnects at the cap: it replaces its own socket, so it still gets in.
  const again = await connect(room, "phone", { phone: "phone-id-3-xxxx", ip: "100.64.0.1" });
  expect(again.closed).toBeNull();
});

afterEach(() => {
  mock.restore();
});

function frame(stream: number, payload: Uint8Array | number[]): ArrayBuffer {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, stream);
  out.set(payload, 4);
  return out.buffer;
}

function ctl(msg: object): ArrayBuffer {
  return frame(0, new TextEncoder().encode(JSON.stringify(msg)));
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill).buffer;

function streamOf(phone: FakeSocket): number {
  return (phone.attachment as { stream: number }).stream;
}

/** A room whose Mac connected once and is gone now (its socket dead, as after a dropped network). */
async function roomMacLeft() {
  const r = newRoom();
  const mac = await connect(r.room, "mac");
  mac.readyState = 3;
  await r.room.webSocketClose(mac, 1006);
  return r;
}

test("a phone in a room its Mac never connected to gets 4404 at once, and the room writes nothing", async () => {
  const { room, state } = newRoom();
  const p = await connect(room, "phone", { phone: "phone-one-id" });
  expect(p.closed?.code).toBe(4404);
  expect(state.alarm).toBeNull();
  expect(state.writes).toBe(0);
  expect(state.getWebSockets("phone")).toEqual([]);
  // Its first Mac connect is written once; later ones only read it (from memory, in the same object).
  await connect(room, "mac", { ts: 1 });
  await connect(room, "mac", { ts: 2 });
  expect(state.writes).toBe(1);
  // A fresh object for the same room (after eviction) still knows: a phone now waits for the Mac.
  const again = new Room(state, {});
  for (const s of state.sockets) s.readyState = 3;
  const q = await connect(again, "phone", { phone: "phone-two-id" });
  expect(q.closed).toBeNull();
  expect(state.alarm).not.toBeNull();
});

test("a phone arriving while the Mac is away waits, and gets 4404 only after the waiting room's time", async () => {
  const { room, state } = await roomMacLeft();
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const p = await connect(room, "phone", { phone: "phone-one-id" });
  expect(p.closed).toBeNull();
  expect(state.alarm).toBe(now + 8000);
  clock.mockReturnValue(now + 7999);
  await room.alarm();
  expect(p.closed).toBeNull();
  clock.mockReturnValue(now + 8000);
  await room.alarm();
  expect(p.closed?.code).toBe(4404);
});

test("a phone that arrives 1 s before the Mac gets its handshake replayed to the new Mac, no 4404", async () => {
  const { room } = await roomMacLeft();
  const p = await connect(room, "phone", { phone: "phone-one-id" });
  const hello = new Uint8Array(33).fill(1);
  await room.webSocketMessage(p, hello.buffer);
  await room.webSocketMessage(p, bytes(33, 9)); // a second frame before the Mac is there is dropped
  const mac = await connect(room, "mac");
  expect(p.closed).toBeNull();
  const stream = streamOf(p);
  expect(control(mac)).toEqual([{ type: "open", stream }]);
  const replay = mac.sent.find((f) => new DataView(f.buffer, f.byteOffset).getUint32(0) === stream);
  expect(replay && [...replay.subarray(4)]).toEqual([...hello]);
  // From now on it is an ordinary stream: frames go through, no waiting left.
  await room.webSocketMessage(p, bytes(5));
  expect(mac.sent.length).toBe(3);
  await room.alarm();
  expect(p.closed).toBeNull();
});

test("a waiting phone stays waiting while another one's oversize wait frame closes that one", async () => {
  const { room } = await roomMacLeft();
  const p = await connect(room, "phone");
  const q = await connect(room, "phone");
  await room.webSocketMessage(q, bytes(2000));
  expect(q.closed?.code).toBe(1009);
  expect(p.closed).toBeNull();
});

test("the Mac replaced while phones are attached: they are closed with 4002, the new Mac isn't told they closed", async () => {
  const { room } = newRoom();
  const mac1 = await connect(room, "mac", { ts: 1000 });
  const a = await connect(room, "phone", { phone: "phone-aaaa-id" });
  const b = await connect(room, "phone", { phone: "phone-bbbb-id" });
  const mac2 = await connect(room, "mac", { ts: 2000 });
  expect(mac1.closed?.code).toBe(4000);
  expect(a.closed?.code).toBe(4002);
  expect(b.closed?.code).toBe(4002);
  expect(control(mac2)).toEqual([]);
  await room.webSocketClose(a, 4002);
  expect(control(mac2)).toEqual([]);
  // The old Mac's close completing doesn't take phones that connect to the new one down.
  const c = await connect(room, "phone", { phone: "phone-cccc-id" });
  await room.webSocketClose(mac1, 4000);
  expect(c.closed).toBeNull();
});

test("a Mac whose signed ts is older than the current one's is refused and doesn't evict it", async () => {
  const { room } = newRoom();
  const live = await connect(room, "mac", { ts: 5000 });
  const late = await connectRaw(room, "mac", { ts: 4000 });
  expect(late.response.status).toBe(409);
  expect(live.closed).toBeNull();
  const same = await connectRaw(room, "mac", { ts: 5000 });
  expect(same.response.status).toBe(101);
  expect(live.closed?.code).toBe(4000);
  // Once that Mac is gone, an older ts is fine again (nothing to evict).
  same.server.readyState = 3;
  const after = await connectRaw(room, "mac", { ts: 100 });
  expect(after.response.status).toBe(101);
});

test("an oversize frame from the Mac closes only that phone's stream; a text frame from the Mac is dropped", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  const a = await connect(room, "phone", { phone: "phone-aaaa-id" });
  const b = await connect(room, "phone", { phone: "phone-bbbb-id" });
  await room.webSocketMessage(mac, frame(streamOf(a), new Uint8Array(256 * 1024)));
  expect(a.closed?.code).toBe(1009);
  expect(b.closed).toBeNull();
  expect(mac.closed).toBeNull();
  await room.webSocketMessage(mac, "hello");
  await room.webSocketMessage(mac, frame(streamOf(b), [1, 2, 3]));
  expect(mac.closed).toBeNull();
  expect(b.sent.length).toBe(1);
  expect(b.closed).toBeNull();
});

test("a text or oversize frame from a phone closes that phone only", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  const a = await connect(room, "phone", { phone: "phone-aaaa-id" });
  const b = await connect(room, "phone", { phone: "phone-bbbb-id" });
  const c = await connect(room, "phone", { phone: "phone-cccc-id" });
  await room.webSocketMessage(a, "text");
  await room.webSocketMessage(b, bytes(256 * 1024 + 1));
  expect(a.closed?.code).toBe(1003);
  expect(b.closed?.code).toBe(1009);
  expect(c.closed).toBeNull();
  expect(mac.closed).toBeNull();
});

test("frames, close and re-announce to a closed-but-listed phone don't throw or reach it", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  const a = await connect(room, "phone", { phone: "phone-aaaa-id" });
  const b = await connect(room, "phone", { phone: "phone-bbbb-id" });
  a.readyState = 2; // closed by the room, still listed
  await room.webSocketMessage(mac, frame(streamOf(a), [1]));
  await room.webSocketMessage(mac, ctl({ type: "close", stream: streamOf(a) }));
  expect(a.sent.length).toBe(0);
  expect(a.closed).toBeNull();
  // A socket whose send() throws doesn't break delivery to the others.
  b.throwOnSend = true;
  await room.webSocketMessage(mac, frame(streamOf(b), [1]));
  // A Mac reconnecting skips the dead phone.
  const mac2 = await connect(room, "mac", { ts: Date.now() + 1 });
  expect(control(mac2)).toEqual([]);
  expect(b.closed?.code).toBe(4002);
});

test("a dead Mac socket doesn't make the room throw when a phone sends", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  const a = await connect(room, "phone", { phone: "phone-aaaa-id" });
  mac.readyState = 3;
  await room.webSocketMessage(a, bytes(3));
  expect(a.closed?.code).toBe(4404);
});

test("webSocketClose / webSocketError: a phone closing tells the Mac, the Mac closing sends the phones 4404", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  const a = await connect(room, "phone", { phone: "phone-aaaa-id" });
  const b = await connect(room, "phone", { phone: "phone-bbbb-id" });
  const sa = streamOf(a);
  await room.webSocketClose(a, 1000);
  await room.webSocketError(b);
  expect(control(mac).filter((m) => m.type === "closed")).toEqual([
    { type: "closed", stream: sa },
    { type: "closed", stream: streamOf(b) },
  ]);
  const c = await connect(room, "phone", { phone: "phone-cccc-id" });
  mac.readyState = 3;
  await room.webSocketError(mac);
  expect(c.closed?.code).toBe(4404);
});

test("a waiting phone is not closed when no Mac is connected and a Mac socket's close completes", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  mac.readyState = 3;
  const w = await connect(room, "phone", { phone: "phone-aaaa-id" });
  await room.webSocketClose(mac, 1006);
  expect(w.closed).toBeNull();
});

test("a malformed phone id counts as no id", async () => {
  const { room, state } = newRoom();
  await connect(room, "mac");
  const p = await connect(room, "phone", { phone: "x y" });
  expect(p.tags.some((t) => t.startsWith("ip:"))).toBe(true);
  expect(state.getWebSockets("phone").length).toBe(1);
});

test("the room answers the helper's ping with a pong", async () => {
  const { room } = newRoom();
  const mac = await connect(room, "mac");
  const ping = new TextEncoder().encode(JSON.stringify({ type: "ping" }));
  const frame = new Uint8Array(4 + ping.length);
  frame.set(ping, 4);
  await room.webSocketMessage(mac, frame.buffer);
  expect(control(mac).map((m) => m.type)).toEqual(["pong"]);
});

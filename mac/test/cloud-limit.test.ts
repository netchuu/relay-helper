import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressKey } from "../../cloud/src/limit.ts";
import { connectProof, type Identity, loadOrCreateIdentity } from "../src/daemon/e2e.ts";

// The Worker's per-address request limit with its bindings faked: over the limit a /v1/ request gets 429 before
// any Durable Object is touched or its body read; under it, it goes on; a missing or failing limiter lets
// everything through; and each route class (Mac connect, phone connect, push) has its own count. The same
// against the real Worker (wrangler dev, with its local limiter) is in relay.test.ts.

let worker: { fetch(r: Request, env: unknown): Promise<Response> };

beforeAll(async () => {
  mock.module("cloudflare:workers", () => ({
    DurableObject: class {
      constructor(
        public ctx: unknown,
        public env: unknown,
      ) {}
    },
  }));
  // By a variable, so the root typecheck doesn't pull the Worker (and its runtime types) in.
  const path = "../../cloud/src/index.ts";
  worker = (await import(path)).default;
});

afterEach(() => {
  mock.restore();
});

/** A limiter like Cloudflare's: `limit` requests per key, counted from the first call. Records every key. */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

/** A ROOM namespace that only records that it was used; every room answers 200. */
function fakeRooms() {
  const touched: string[] = [];
  const room = {
    fetch: async () => {
      touched.push("fetch");
      return new Response("room");
    },
    push: async () => {
      touched.push("push");
      return { status: 200 };
    },
  };
  return {
    touched,
    ROOM: {
      idFromName: (name: string) => {
        touched.push(`id:${name}`);
        return name;
      },
      get: () => {
        touched.push("get");
        return room;
      },
    },
  };
}

const identity = (): Identity =>
  loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "relay-id-")), "id.json"));

const IP = "198.51.100.7";
const MAC = "a".repeat(22);

function phoneConnect(ip = IP) {
  return new Request(`https://relay.test/v1/connect?role=phone&mac=${MAC}&phone=phone-one-id`, {
    headers: { upgrade: "websocket", "cf-connecting-ip": ip },
  });
}

function macConnect(id: Identity, ip = IP) {
  const p = connectProof(id);
  return new Request(
    `https://relay.test/v1/connect?role=mac&mac=${id.macId}&pub=${p.pub}&ts=${p.ts}&sig=${p.sig}`,
    { headers: { upgrade: "websocket", "cf-connecting-ip": ip } },
  );
}

/** A push signed as the helper signs it; `body` may be a stream, to see whether the Worker reads it. */
function push(
  id: Identity,
  ip = IP,
  body: string | ReadableStream<Uint8Array> = JSON.stringify({
    token: "ab".repeat(32),
    environment: "production",
    payload: {},
  }),
) {
  const ts = Date.now();
  const text = typeof body === "string" ? body : "";
  const hash = createHash("sha256").update(text).digest("base64url");
  const sig = sign(null, Buffer.from(`relay-push-v1:${id.macId}:${ts}:${hash}`), id.authPrivate).toString(
    "base64url",
  );
  return new Request("https://relay.test/v1/push", {
    method: "POST",
    headers: {
      "cf-connecting-ip": ip,
      "x-relay-mac": id.macId,
      "x-relay-pub": Buffer.from(id.authPublic).toString("base64url"),
      "x-relay-ts": String(ts),
      "x-relay-sig": sig,
    },
    body,
  });
}

describe("over the limit", () => {
  test("a phone connect, a Mac connect and a push get 429 before any Durable Object is touched", async () => {
    const rooms = fakeRooms();
    const env = { ROOM: rooms.ROOM, CONNECT_LIMIT: fakeLimiter(0), PUSH_LIMIT: fakeLimiter(0) };
    const id = identity();
    const phone = await worker.fetch(phoneConnect(), env);
    expect(phone.status).toBe(429);
    expect(await phone.text()).toBe("too many requests");
    expect(phone.headers.get("retry-after")).toBe("60");
    expect((await worker.fetch(macConnect(id), env)).status).toBe(429);
    const pushed = await worker.fetch(push(id), env);
    expect(pushed.status).toBe(429);
    expect(await pushed.json()).toEqual({ reason: "too many requests" });
    expect(rooms.touched).toEqual([]);
  });

  test("an over-limit push's body is never read", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const rooms = fakeRooms();
    const res = await worker.fetch(push(identity(), IP, body), {
      ROOM: rooms.ROOM,
      PUSH_LIMIT: fakeLimiter(0),
    });
    expect(res.status).toBe(429);
    expect(pulled).toBe(0);
    expect(rooms.touched).toEqual([]);
  });

  test("requests that would fail anyway (a bad macId, no upgrade, a bad signature) are counted too", async () => {
    const rooms = fakeRooms();
    const limiter = fakeLimiter(2);
    const env = { ROOM: rooms.ROOM, CONNECT_LIMIT: limiter };
    const bad = (path: string, headers: Record<string, string> = {}) =>
      worker.fetch(
        new Request(`https://relay.test${path}`, { headers: { "cf-connecting-ip": IP, ...headers } }),
        env,
      );
    expect((await bad("/v1/connect?role=phone&mac=short", { upgrade: "websocket" })).status).toBe(400);
    expect((await bad(`/v1/connect?role=phone&mac=${MAC}`)).status).toBe(426);
    expect((await bad(`/v1/connect?role=phone&mac=${MAC}`, { upgrade: "websocket" })).status).toBe(429);
    expect(limiter.keys).toEqual([`phone:${IP}`, `phone:${IP}`, `phone:${IP}`]);
    expect(rooms.touched).toEqual([]);
  });
});

describe("under the limit", () => {
  test("connects and pushes go on to their rooms, each counted once", async () => {
    const rooms = fakeRooms();
    const connects = fakeLimiter(10);
    const pushes = fakeLimiter(10);
    const env = { ROOM: rooms.ROOM, CONNECT_LIMIT: connects, PUSH_LIMIT: pushes };
    const id = identity();
    expect((await worker.fetch(phoneConnect(), env)).status).toBe(200);
    expect((await worker.fetch(macConnect(id), env)).status).toBe(200);
    expect((await worker.fetch(push(id), env)).status).toBe(200);
    expect(rooms.touched.filter((t) => t === "fetch" || t === "push")).toEqual(["fetch", "fetch", "push"]);
    expect(connects.keys).toEqual([`phone:${IP}`, `mac:${IP}`]);
    expect(pushes.keys).toEqual([`push:${IP}`]);
  });

  test("/health and the site's pages aren't counted", async () => {
    const connects = fakeLimiter(0);
    const pushes = fakeLimiter(0);
    const env = { ...fakeRooms(), CONNECT_LIMIT: connects, PUSH_LIMIT: pushes };
    expect((await worker.fetch(new Request("https://relay.test/health"), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://relay.test/"), env)).status).not.toBe(429);
    expect((await worker.fetch(new Request("https://relay.test/v2/other"), env)).status).toBe(404);
    expect([...connects.keys, ...pushes.keys]).toEqual([]);
  });
});

describe("the key", () => {
  test("pushes don't use up the connect budget, nor phones the Mac's, nor one address another's", async () => {
    const rooms = fakeRooms();
    // One binding for both, as if the two were the same: the class in the key still keeps the counts apart.
    const shared = fakeLimiter(3);
    const env = { ROOM: rooms.ROOM, CONNECT_LIMIT: shared, PUSH_LIMIT: shared };
    const id = identity();
    for (let i = 0; i < 3; i++) expect((await worker.fetch(push(id), env)).status).toBe(200);
    expect((await worker.fetch(push(id), env)).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await worker.fetch(phoneConnect(), env)).status).toBe(200);
    expect((await worker.fetch(phoneConnect(), env)).status).toBe(429);
    expect((await worker.fetch(macConnect(id), env)).status).toBe(200);
    expect((await worker.fetch(phoneConnect("198.51.100.8"), env)).status).toBe(200);
    expect(new Set(shared.keys)).toEqual(
      new Set([`push:${IP}`, `phone:${IP}`, `mac:${IP}`, "phone:198.51.100.8"]),
    );
  });

  test("an IPv6 address counts by its /64", async () => {
    expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0DB8:0001:0002:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("")).toBe("");
    const limiter = fakeLimiter(1);
    const env = { ...fakeRooms(), CONNECT_LIMIT: limiter };
    expect((await worker.fetch(phoneConnect("2001:db8:1:2::a"), env)).status).toBe(200);
    expect((await worker.fetch(phoneConnect("2001:db8:1:2:ffff::b"), env)).status).toBe(429);
    expect((await worker.fetch(phoneConnect("2001:db8:1:3::a"), env)).status).toBe(200);
  });
});

describe("without a working limiter, requests go through", () => {
  test("a missing binding", async () => {
    const rooms = fakeRooms();
    const id = identity();
    for (let i = 0; i < 5; i++) {
      expect((await worker.fetch(phoneConnect(), { ROOM: rooms.ROOM })).status).toBe(200);
      expect((await worker.fetch(push(id), { ROOM: rooms.ROOM })).status).toBe(200);
    }
  });

  test("a binding that throws or answers nonsense; the log names no address and no error", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const rooms = fakeRooms();
    const throwing = {
      limit: async ({ key }: { key: string }) => {
        throw new Error(`limiter down for ${key}`);
      },
    };
    const env = { ROOM: rooms.ROOM, CONNECT_LIMIT: throwing, PUSH_LIMIT: throwing };
    const id = identity();
    expect((await worker.fetch(phoneConnect(), env)).status).toBe(200);
    expect((await worker.fetch(macConnect(id), env)).status).toBe(200);
    expect((await worker.fetch(push(id), env)).status).toBe(200);
    const odd = { limit: async () => undefined };
    expect((await worker.fetch(phoneConnect(), { ROOM: rooms.ROOM, CONNECT_LIMIT: odd })).status).toBe(200);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain("limiter down");
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

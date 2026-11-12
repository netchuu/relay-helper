/**
 * Relay's Cloudflare Worker: forwards end-to-end-encrypted bytes between an iPhone and its Mac.
 * It never sees plaintext. Protocol: docs/RELAY.md.
 */
import { DurableObject } from "cloudflare:workers";
import { type LimitEnv, routeClass, withinLimit } from "./limit";
import {
  MAX_PUSH_BODY,
  mintProviderToken,
  PROVIDER_TOKEN_LIFETIME_MS,
  type PushEnv,
  type PushRequest,
  parsePushRequest,
  pushSigningInput,
  readBody,
  sendPush,
  TOKEN_PUSHES_PER_HOUR,
  TOKEN_PUSHES_PER_MINUTE,
} from "./push";
import { sitePage } from "./site";

interface Env extends PushEnv, LimitEnv {
  ROOM: DurableObjectNamespace<Room>;
}

/** Pushes a Mac may send per hour: generous for real use, a ceiling for a leaked identity key. */
const PUSHES_PER_HOUR = 600;
/** Not a real room: the Durable Object that keeps the shared APNs provider token (MAC_ID can't match it). */
const APNS_TOKEN_ROOM = "~apns-provider-token";
/** Not a real room either: the prefix of the Durable Object that counts pushes to one device token. */
const PUSH_TOKEN_ROOM = "~push-token:";

const MAC_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_FRAME = 256 * 1024;
/** Phone sockets a room holds in all: the ceiling against abuse. */
const MAX_PHONES = 32;
/**
 * Only for a phone that sends no `phone` id (an older app): at most this many per address. A phone with an id is
 * counted by its id (a reconnect replaces its earlier socket), not by address, because mobile carriers put many
 * users behind one address (CGNAT) and four per address locked real phones out.
 */
const MAX_PHONES_PER_IP = 8;
/** A phone's own id, chosen by the app: random, the same for all its connections of one run. */
const PHONE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CLOCK_SKEW_MS = 5 * 60_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Each address's request limit (limit.ts), first on every /v1/ route: over it, no Durable Object is touched
    // and no body is read.
    const limitClass = routeClass(url);
    if (limitClass && !(await withinLimit(env, limitClass, request))) {
      const headers = { "retry-after": "60" };
      return limitClass === "push"
        ? Response.json({ reason: "too many requests" }, { status: 429, headers })
        : new Response("too many requests", { status: 429, headers });
    }
    if (url.pathname === "/v1/push" && request.method === "POST") return handlePush(request, env);
    if (url.pathname !== "/v1/connect") {
      if (request.method === "GET") {
        const page = sitePage(url.pathname);
        if (page) return page;
      }
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected a WebSocket upgrade", { status: 426 });
    const role = url.searchParams.get("role");
    const macId = url.searchParams.get("mac") ?? "";
    if (!MAC_ID.test(macId) || (role !== "mac" && role !== "phone"))
      return new Response("bad request", { status: 400 });
    if (role === "mac" && !(await verifyMac(url, macId)))
      return new Response("unauthorized", { status: 401 });
    const room = env.ROOM.get(env.ROOM.idFromName(macId));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** The Mac proves it owns `macId`: macId is derived from its Ed25519 key, and it signs a fresh timestamp. */
async function verifyMac(url: URL, macId: string): Promise<boolean> {
  const ts = Number(url.searchParams.get("ts"));
  return verifySigned(
    macId,
    url.searchParams.get("pub") ?? "",
    url.searchParams.get("sig") ?? "",
    ts,
    `relay-mac-v1:${macId}:${ts}`,
  );
}

/** Unpadded base64url, the only spelling the helper sends (atob would also take whitespace and padding). */
const B64URL = /^[A-Za-z0-9_-]+$/;

async function verifySigned(
  macId: string,
  pubB64: string,
  sigB64: string,
  ts: number,
  message: string,
): Promise<boolean> {
  if (!B64URL.test(pubB64) || !B64URL.test(sigB64)) return false;
  try {
    const pub = fromB64url(pubB64);
    const sig = fromB64url(sigB64);
    if (
      pub.length !== 32 ||
      sig.length !== 64 ||
      !Number.isFinite(ts) ||
      Math.abs(Date.now() - ts) > CLOCK_SKEW_MS
    )
      return false;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pub));
    if (toB64url(digest).slice(0, 22) !== macId) return false;
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/**
 * POST /v1/push. Headers x-relay-mac, x-relay-pub, x-relay-ts, x-relay-sig sign the body's SHA-256
 * (pushSigningInput). The Mac's room applies its rate limit and drops replays; the token's own room applies
 * the per-device limit.
 */
async function handlePush(request: Request, env: Env): Promise<Response> {
  const macId = request.headers.get("x-relay-mac") ?? "";
  if (!MAC_ID.test(macId)) return Response.json({ reason: "bad request" }, { status: 400 });
  const body = await readBody(request, MAX_PUSH_BODY);
  if (body === null) return Response.json({ reason: "too large" }, { status: 413 });
  const ts = Number(request.headers.get("x-relay-ts"));
  const sig = request.headers.get("x-relay-sig") ?? "";
  const bodyHash = toB64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
  );
  const ok = await verifySigned(
    macId,
    request.headers.get("x-relay-pub") ?? "",
    sig,
    ts,
    pushSigningInput(macId, ts, bodyHash),
  );
  if (!ok) return Response.json({ reason: "unauthorized" }, { status: 401 });
  const parsed = parsePushRequest(body);
  if (typeof parsed === "string") return Response.json({ reason: parsed }, { status: 400 });
  const room = env.ROOM.get(env.ROOM.idFromName(macId));
  // Replays are found by what was signed, not by the signature's spelling: base64 has several for the same bytes.
  const result = await room.push(`${ts}:${bodyHash}`, parsed);
  return Response.json(result, {
    status: result.status === 200 ? 200 : result.status >= 500 ? 502 : result.status,
  });
}

/**
 * A phone that arrived while the Mac was away waits (`wait`), holding its handshake frame (`hello`: 33 bytes, far
 * under the 2 KiB attachment limit), until the Mac connects and gets `open` plus the frame, or WAIT_MS pass.
 */
type Attachment =
  | { role: "mac"; ts: number }
  | { role: "phone"; stream: number; wait?: { since: number; hello?: Uint8Array }; quiet?: boolean };

/** How long a phone waits for a Mac that dropped a moment ago before it gets 4404. */
const WAIT_MS = 8_000;
/** The most a waiting phone may send before the Mac is there (its handshake is 33 bytes). */
const MAX_WAIT_FRAME = 1024;
/** Storage key, set at the room's first Mac connect: only a room that has had its Mac makes a phone wait. */
const MAC_SEEN = "macSeen";

/**
 * One room per Mac. Uses the WebSocket Hibernation API, so an idle room costs nothing while sockets
 * stay open. Phones get a stream id; frames to/from the Mac are prefixed with it.
 *
 * Close codes the room sends: 4000 Mac replaced by a newer connection; 4001 phone replaced by its own newer one;
 * 4002 phone: the Mac reconnected, its keys for this stream are gone, connect again; 4404 phone: Mac offline
 * (after waiting WAIT_MS, or at once in a room its Mac never connected to); 4429 too many connections.
 * 1003/1009 phone: a text or oversize frame.
 */
export class Room extends DurableObject<Env> {
  private pushTimes: number[] = [];
  private recentSigs = new Map<string, number>();
  /** Cache of the MAC_SEEN storage key; undefined until read. */
  private macSeen: boolean | undefined;

  /**
   * Replay check and rate limit for this Mac, then the device token's own limit, then APNs or FCM. `signed`
   * names what the Mac signed (its ts and body hash). This Mac's counts are in memory: a restarted room starts
   * fresh. Errors come back as a fixed reason, never the exception's text (it can quote a secret).
   */
  async push(signed: string, req: PushRequest): Promise<{ status: number; reason?: string }> {
    const now = Date.now();
    for (const [s, at] of this.recentSigs) if (now - at > CLOCK_SKEW_MS * 2) this.recentSigs.delete(s);
    if (this.recentSigs.has(signed)) return { status: 409, reason: "replayed request" };
    this.recentSigs.set(signed, now);
    this.pushTimes = this.pushTimes.filter((t) => now - t < 3_600_000);
    if (this.pushTimes.length >= PUSHES_PER_HOUR) return { status: 429, reason: "too many pushes" };
    this.pushTimes.push(now);
    try {
      const tokenRoom = this.env.ROOM.get(this.env.ROOM.idFromName(await pushTokenRoom(req)));
      if (!(await tokenRoom.allowTokenPush()))
        return { status: 429, reason: "too many pushes to this device" };
      // One provider token for all rooms and Worker instances, kept by a single Durable Object.
      const tokenKeeper = this.env.ROOM.get(this.env.ROOM.idFromName(APNS_TOKEN_ROOM));
      return await sendPush(this.env, req, () => tokenKeeper.apnsToken());
    } catch {
      return { status: 503, reason: "push failed" };
    }
  }

  /**
   * Only on a PUSH_TOKEN_ROOM instance: counts one push to its device token, or says no when the token had
   * TOKEN_PUSHES_PER_MINUTE in the last minute or TOKEN_PUSHES_PER_HOUR in the last hour. Kept in storage, so
   * the count survives the object being evicted between bursts.
   */
  async allowTokenPush(): Promise<boolean> {
    const now = Date.now();
    const times = ((await this.ctx.storage.get<number[]>("pushTimes")) ?? []).filter(
      (t) => now - t < 3_600_000,
    );
    if (
      times.length >= TOKEN_PUSHES_PER_HOUR ||
      times.filter((t) => now - t < 60_000).length >= TOKEN_PUSHES_PER_MINUTE
    )
      return false;
    times.push(now);
    await this.ctx.storage.put("pushTimes", times);
    return true;
  }

  /** Only on the APNS_TOKEN_ROOM instance: the shared provider token, minted at most every 40 minutes.
   * Kept in storage so a restart doesn't mint a new one; a Durable Object runs one call at a time. */
  async apnsToken(): Promise<string> {
    const now = Date.now();
    const cached = await this.ctx.storage.get<{ token: string; issuedAt: number }>("apnsToken");
    if (cached && now - cached.issuedAt < PROVIDER_TOKEN_LIFETIME_MS) return cached.token;
    const token = await mintProviderToken(this.env, now);
    await this.ctx.storage.put("apnsToken", { token, issuedAt: now });
    return token;
  }

  async fetch(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const role = params.get("role");

    if (role === "mac") {
      // A late, abandoned attempt (older signed ts) must not evict the live connection.
      const ts = Number(params.get("ts"));
      const current = this.mac();
      const currentTs = current ? (current.deserializeAttachment() as Attachment | null) : null;
      if (currentTs?.role === "mac" && Number.isFinite(ts) && ts < currentTs.ts)
        return new Response("a newer connection holds this room", { status: 409 });
      if (!(await this.hasSeenMac())) {
        await this.ctx.storage.put(MAC_SEEN, true);
        this.macSeen = true;
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      for (const old of this.ctx.getWebSockets("mac")) {
        try {
          old.close(4000, "replaced by a newer connection");
        } catch {
          // already closed
        }
      }
      this.ctx.acceptWebSocket(server, ["mac"]);
      server.serializeAttachment({ role: "mac", ts: Number.isFinite(ts) ? ts : 0 } satisfies Attachment);
      for (const phone of this.livePhones()) {
        const a = phone.deserializeAttachment() as Attachment;
        if (a.role !== "phone") continue;
        if (a.wait) {
          // Arrived while the Mac was away: open its stream and replay its handshake.
          const hello = a.wait.hello;
          phone.serializeAttachment({ role: "phone", stream: a.stream } satisfies Attachment);
          safeSend(server, control({ type: "open", stream: a.stream }));
          if (hello) safeSend(server, withStream(a.stream, hello));
        } else {
          // Its keys lived in the Mac's memory and are gone: end it now so the phone reconnects at once,
          // rather than looking connected on a dead stream until its next ping or the 30 s auth timer.
          phone.serializeAttachment({ ...a, quiet: true } satisfies Attachment);
          closeQuietly(phone, 4002, "mac reconnected");
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (!this.mac() && !(await this.hasSeenMac())) {
      // No Mac has ever connected here (most likely a made-up macId): nothing to wait for, so 4404 at once rather
      // than a wait whose alarm would cost a storage write.
      server.accept();
      server.close(4404, "mac offline");
      return new Response(null, { status: 101, webSocket: client });
    }
    const mac = this.mac();
    // A phone that connects again replaces its own earlier sockets (found by the id it sends, not by address), so
    // ones left half-open by a dropped LTE connection can't fill the room and lock it out.
    const rawId = params.get("phone") ?? "";
    const phoneId = PHONE_ID.test(rawId) ? rawId : null;
    if (phoneId) {
      for (const old of this.livePhones(`ph:${phoneId}`)) {
        const a = old.deserializeAttachment() as Attachment;
        if (a.role === "phone" && !a.wait && mac)
          safeSend(mac, control({ type: "closed", stream: a.stream }));
        if (a.role === "phone") old.serializeAttachment({ ...a, quiet: true } satisfies Attachment);
        closeQuietly(old, 4001, "replaced by a newer connection");
      }
    }
    if (this.livePhones().filter((p) => !phoneId || !this.hasTag(p, `ph:${phoneId}`)).length >= MAX_PHONES) {
      server.accept();
      server.close(4429, "too many connections");
      return new Response(null, { status: 101, webSocket: client });
    }
    // Phones aren't authenticated here (the Mac does that inside the encrypted stream). A phone without an id is
    // capped per address, so one client can't take every slot; the total cap above holds for all. The Mac also
    // drops streams that don't authenticate within 30 s.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ipTag = `ip:${ip}`.slice(0, 200);
    if (!phoneId && this.livePhones(ipTag).length >= MAX_PHONES_PER_IP) {
      server.accept();
      server.close(4429, "too many connections from this address");
      return new Response(null, { status: 101, webSocket: client });
    }
    const stream = this.newStreamId();
    this.ctx.acceptWebSocket(
      server,
      phoneId ? ["phone", `p:${stream}`, `ph:${phoneId}`] : ["phone", `p:${stream}`, ipTag],
    );
    // No Mac: it may be back in a second, so take the phone in and wait instead of sending it to its own backoff.
    if (mac) {
      server.serializeAttachment({ role: "phone", stream } satisfies Attachment);
      safeSend(mac, control({ type: "open", stream }));
    } else {
      server.serializeAttachment({ role: "phone", stream, wait: { since: Date.now() } } satisfies Attachment);
      await this.scheduleWaitCheck(Date.now() + WAIT_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether this room's Mac has ever connected: written once, at its first connect, then read from memory. */
  private async hasSeenMac(): Promise<boolean> {
    this.macSeen ??= (await this.ctx.storage.get<boolean>(MAC_SEEN)) === true;
    return this.macSeen;
  }

  /** Wakes the room when the oldest waiting phone's time is up (an alarm survives hibernation; a timer wouldn't). */
  private async scheduleWaitCheck(at: number): Promise<void> {
    const storage = this.ctx.storage;
    const existing = await storage.getAlarm();
    if (existing === null || existing > at) await storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let next = 0;
    for (const phone of this.livePhones()) {
      const a = phone.deserializeAttachment() as Attachment;
      if (a.role !== "phone" || !a.wait) continue;
      const due = a.wait.since + WAIT_MS;
      if (due <= now) closeQuietly(phone, 4404, "mac offline");
      else next = next === 0 ? due : Math.min(next, due);
    }
    if (next) await this.ctx.storage.setAlarm(next);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    if (a.role === "phone") {
      if (typeof message === "string" || message.byteLength > MAX_FRAME) {
        closeQuietly(ws, typeof message === "string" ? 1003 : 1009, "binary frames up to 256 KiB only");
        return;
      }
      const mac = this.mac();
      if (a.wait) {
        // The Mac isn't here yet: keep the first frame (the handshake) to replay when it arrives.
        if (message.byteLength > MAX_WAIT_FRAME) closeQuietly(ws, 1009, "frame too large");
        else if (!a.wait.hello && !mac)
          ws.serializeAttachment({
            ...a,
            wait: { since: a.wait.since, hello: new Uint8Array(message) },
          } satisfies Attachment);
        return;
      }
      if (!mac) {
        closeQuietly(ws, 4404, "mac offline");
        return;
      }
      safeSend(mac, withStream(a.stream, new Uint8Array(message)));
      return;
    }
    // From the Mac. Text has no stream id: drop it. An oversize frame closes only its own stream, not the Mac's
    // socket (and with it every phone).
    if (typeof message === "string") return;
    if (message.byteLength < 4) return;
    const stream = new DataView(message).getUint32(0);
    if (message.byteLength > MAX_FRAME) {
      if (stream !== 0) {
        const phone = this.phone(stream);
        if (phone) closeQuietly(phone, 1009, "frame too large");
      }
      return;
    }
    const payload = message.slice(4);
    if (stream === 0) {
      const msg = parseControl(payload);
      // The helper checks the room still hears it: a round trip through this code, not just the edge's own pong.
      if (msg?.type === "ping") safeSend(ws, control({ type: "pong", stream: 0 }));
      if (msg?.type === "close") {
        const phone = this.phone(msg.stream);
        if (phone) closeQuietly(phone, 1000, "closed by mac");
      }
      return;
    }
    const phone = this.phone(stream);
    if (phone) safeSend(phone, payload);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a?.role === "phone") {
      if (!a.wait && !a.quiet) {
        const mac = this.mac();
        if (mac) safeSend(mac, control({ type: "closed", stream: a.stream }));
      }
    } else if (
      a?.role === "mac" &&
      !this.ctx.getWebSockets("mac").some((m) => m !== ws && m.readyState === WebSocket.OPEN)
    ) {
      // The live Mac went away (not just a replaced one): established phones can't reach it any more.
      // Waiting ones keep waiting for it.
      for (const phone of this.livePhones()) {
        const pa = phone.deserializeAttachment() as Attachment;
        if (pa.role === "phone" && !pa.wait) closeQuietly(phone, 4404, "mac offline");
      }
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  /**
   * The Mac's live connection. One the room replaced stays listed until its close completes, which never
   * happens when that helper was killed or its network died, so skip anything that isn't open.
   */
  private mac(): WebSocket | undefined {
    return this.ctx.getWebSockets("mac").find((m) => m.readyState === WebSocket.OPEN);
  }

  /** Phone sockets that are open, optionally those with `tag`. */
  private livePhones(tag = "phone"): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((p) => p.readyState === WebSocket.OPEN);
  }

  private hasTag(ws: WebSocket, tag: string): boolean {
    return this.ctx.getTags(ws).includes(tag);
  }

  /** The open phone socket of a stream: a closed one stays listed until its close completes. */
  private phone(stream: number): WebSocket | undefined {
    return this.ctx.getWebSockets(`p:${stream}`).find((p) => p.readyState === WebSocket.OPEN);
  }

  private newStreamId(): number {
    const ids = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(ids);
      const id = ids[0] ?? 0;
      if (id !== 0 && this.ctx.getWebSockets(`p:${id}`).length === 0) return id;
    }
  }
}

/** The name of the Durable Object that counts pushes to this request's device token (by its hash). */
async function pushTokenRoom(req: PushRequest): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(req.token));
  return `${PUSH_TOKEN_ROOM}${req.platform ?? "apns"}:${toB64url(new Uint8Array(digest))}`;
}

/** send() throws on a socket that closed meanwhile; one dead peer must not break the rest. */
function safeSend(ws: WebSocket, data: Uint8Array | ArrayBuffer): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(data);
  } catch {
    // closing
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // already closed
  }
}

function withStream(stream: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, stream);
  frame.set(payload, 4);
  return frame;
}

function control(msg: { type: "open" | "closed" | "pong"; stream: number }): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const frame = new Uint8Array(4 + json.length);
  frame.set(json, 4); // stream id 0
  return frame;
}

function parseControl(payload: ArrayBuffer): { type: string; stream: number } | null {
  try {
    const msg = JSON.parse(new TextDecoder().decode(payload)) as { type?: unknown; stream?: unknown };
    // A ping has no stream; it counts as stream 0.
    return typeof msg.type === "string" && (typeof msg.stream === "number" || msg.type === "ping")
      ? { type: msg.type, stream: typeof msg.stream === "number" ? msg.stream : 0 }
      : null;
  } catch {
    return null;
  }
}

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

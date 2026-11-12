import { networkInterfaces } from "node:os";
import { errMessage, log } from "../log.ts";
import { ClientSession } from "./clientSession.ts";
import type { DB } from "./db.ts";
import { connectProof, type Identity, MacChannel } from "./e2e.ts";
import type { EventLog } from "./events.ts";
import type { RpcOutcome } from "./rpc.ts";

type Rpc = (method: string, params: unknown, actor: string) => Promise<RpcOutcome>;

const MAX_STREAMS = 32;

const AUTH_TIMEOUT_MS = 30_000;

interface Stream {
  channel: MacChannel;
  session: ClientSession | null;
  /** Closes the stream unless the phone authenticates (pair/hello) in time. */
  authTimer: ReturnType<typeof setTimeout>;
}

/**
 * Keeps this Mac connected to its room on the Cloudflare relay and serves each phone stream through
 * an end-to-end-encrypted MacChannel + ClientSession. Reconnects within seconds; never blocks hooks.
 */
/**
 * How often the helper pings its relay connection. A pong must be back by the next ping (so a dead link is
 * dropped within two intervals), and the room's own pong within two intervals of the first ping.
 */
const KEEPALIVE_MS = Number(process.env.RELAY_KEEPALIVE_MS) || 5_000;
/**
 * How long a connection attempt may take to open. Without a limit, an attempt that stalls (the TCP
 * connection opens but the upgrade never answers, common on a phone hotspot) never opens and never
 * closes, so nothing retries and the helper stays offline until it restarts.
 */
const CONNECT_TIMEOUT_MS = 8_000;
/** The watchdog ticks this often; a tick that comes more than WAKE_JUMP_MS late means the machine slept. */
const WATCHDOG_MS = 1_000;
const WAKE_JUMP_MS = 5_000;
/** The network interfaces are compared every NETWORK_POLL_MS. */
const NETWORK_POLL_MS = 2_000;
/** An attempt that fails sooner than this is a refused or unroutable connection, not a stalled one. */
const FAST_FAIL_MS = 1_000;
/** Backoff: 0.5 s doubling to 5 s after fast failures, 1 s doubling to 15 s otherwise; jitter stays inside the cap. */
const FAST_BACKOFF = { base: 500, cap: 5_000 };
const SLOW_BACKOFF = { base: 1_000, cap: 15_000 };
/** The first retry after a link that had been up waits at most this long. */
const REOPEN_MAX_MS = 250;
/** The wait after a second 4000 (replaced by another connection) in a row, e.g. a second daemon on the same room. */
const REPLACED_PENALTY_MS = 30_000;

/** The pieces of time the link uses, so tests can drive it with a fake clock. */
export interface LinkClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realClock: LinkClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** The machine's external addresses, sorted: it changes when the network does (Wi-Fi switch, VPN, cable, hotspot). */
function networkSignature(): string {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) if (!a.internal) out.push(`${name}/${a.address}`);
  }
  return out.sort().join(",");
}

export interface RelayLinkOptions {
  connectTimeoutMs?: number;
  clock?: LinkClock;
  random?: () => number;
  /** Creates the socket (tests pass a fake). */
  createSocket?: (url: URL) => WebSocket;
  /** A string that changes when the machine's network does. */
  networkSignature?: () => string;
}

/** How long to wait before the next attempt. `jitter` is in [0, 1). Exported for the tests. */
export function backoffDelay(attempt: number, fastFail: boolean, jitter: number): number {
  const { base, cap } = fastFail ? FAST_BACKOFF : SLOW_BACKOFF;
  const top = Math.min(cap, base * 2 ** Math.min(attempt, 10));
  return Math.round(top * (0.6 + 0.4 * jitter));
}

export class RelayLink {
  private ws: WebSocket | null = null;
  private streams = new Map<number, Stream>();
  private stopped = false;
  private attempt = 0;
  private timer: unknown = null;
  private keepalive: unknown = null;
  private watchdog: unknown = null;
  /** Ends the current attempt without scheduling a retry (the caller connects again). */
  private abandonCurrent: (() => void) | null = null;
  /** Unanswered room control pings on this connection; the room must answer within two intervals. */
  private roomMissed = 0;
  private awaitingRoomPong = false;
  private replacedInARow = 0;
  private readonly clock: LinkClock;
  private readonly random: () => number;
  private readonly signature: () => string;

  constructor(
    private readonly relayUrl: string,
    private readonly identity: Identity,
    private readonly deps: { rpc: Rpc; events: EventLog; db: DB },
    private readonly opts: RelayLinkOptions = {},
  ) {
    this.clock = opts.clock ?? realClock;
    this.random = opts.random ?? Math.random;
    this.signature = opts.networkSignature ?? networkSignature;
  }

  start(): void {
    this.stopped = false;
    this.startWatchdog();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.watchdog) this.clock.clearInterval(this.watchdog);
    this.watchdog = null;
    this.stopKeepalive();
    this.abandonCurrent?.();
    this.ws?.close(1000, "daemon stopping");
    this.ws = null;
    this.closeAllStreams();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * A permanent watchdog: a tick that arrives more than 5 s late means the machine slept (the socket is stale,
   * and a retry timer may be minutes away), and a change of network interfaces means the old route is gone.
   * Either one reconnects at once, also while waiting out a backoff.
   */
  private startWatchdog(): void {
    if (this.watchdog) this.clock.clearInterval(this.watchdog);
    let last = this.clock.now();
    let lastNetworkCheck = last;
    let net = this.safeSignature();
    this.watchdog = this.clock.setInterval(() => {
      const now = this.clock.now();
      const jumped = now - last > WAKE_JUMP_MS;
      last = now;
      if (jumped) {
        log.info("woke from sleep; reconnecting now");
        lastNetworkCheck = now;
        net = this.safeSignature();
        this.reconnectNow();
        return;
      }
      if (now - lastNetworkCheck >= NETWORK_POLL_MS) {
        lastNetworkCheck = now;
        const next = this.safeSignature();
        if (next !== net) {
          net = next;
          log.info("network changed; reconnecting now");
          this.reconnectNow();
        }
      }
    }, WATCHDOG_MS);
  }

  private safeSignature(): string {
    try {
      return this.signature();
    } catch {
      return "";
    }
  }

  /** Drops whatever the link is doing (live socket, pending attempt, backoff timer) and connects again at once. */
  private reconnectNow(): void {
    if (this.stopped) return;
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.abandonCurrent?.();
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    this.timer = null;
    const proof = connectProof(this.identity);
    const url = new URL("/v1/connect", this.relayUrl);
    url.searchParams.set("role", "mac");
    url.searchParams.set("mac", this.identity.macId);
    url.searchParams.set("pub", proof.pub);
    url.searchParams.set("ts", proof.ts);
    url.searchParams.set("sig", proof.sig);
    const ws = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    const startedAt = this.clock.now();
    let wasUp = false;
    let lastError = "";
    let closed = false;
    const detach = () => {
      closed = true;
      this.clock.clearTimeout(openTimer);
      this.stopKeepalive();
      this.closeAllStreams();
      if (this.ws === ws) this.ws = null;
      if (this.abandonCurrent === abandon) this.abandonCurrent = null;
    };
    const abandon = () => {
      if (closed) return;
      detach();
      try {
        ws.terminate();
      } catch {
        // never opened, or already closed
      }
    };
    this.abandonCurrent = abandon;
    const onClosed = (code: number) => {
      if (closed) return;
      detach();
      if (this.stopped) return;
      // 4000 = replaced by another connection for the same room. Once can be our own late attempt (retry
      // normally); twice in a row is a second daemon: back off longer.
      this.replacedInARow = code === 4000 ? this.replacedInARow + 1 : 0;
      const failedFast = this.clock.now() - startedAt < FAST_FAIL_MS;
      let delay: number;
      if (wasUp) {
        delay = Math.round(this.random() * REOPEN_MAX_MS);
        this.attempt = 0;
      } else {
        delay = backoffDelay(this.attempt++, failedFast, this.random());
      }
      if (this.replacedInARow >= 2) delay = Math.max(delay, REPLACED_PENALTY_MS);
      log.info("relay disconnected", { code, retryInMs: delay, wasUp, cause: lastError || undefined });
      this.timer = this.clock.setTimeout(() => this.connect(), delay);
    };

    const openTimer = this.clock.setTimeout(() => {
      if (ws.readyState !== WebSocket.CONNECTING) return;
      lastError ||= "connect timeout";
      log.info("relay connection attempt timed out; retrying");
      try {
        ws.terminate();
      } catch {
        // never opened
      }
      onClosed(1006);
    }, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      // Opened after the attempt was given up: a newer attempt owns the connection now.
      if (closed) {
        try {
          ws.close(1000, "superseded");
        } catch {
          // already gone
        }
        return;
      }
      this.clock.clearTimeout(openTimer);
      this.attempt = 0;
      wasUp = true;
      log.info("relay connected", { room: this.identity.macId });
      this.startKeepalive(ws, () => {
        try {
          ws.terminate();
        } catch {
          // already dead
        }
        // terminate() doesn't fire onclose promptly; the link is dead, so carry on without waiting for it.
        onClosed(1006);
      });
    };
    ws.onmessage = (event) => {
      if (closed || typeof event.data === "string") return;
      this.onFrame(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = (event) => onClosed(event.code);
    ws.onerror = (event) => {
      // onclose follows; keep the cause (DNS, no route, TLS...) for its log line.
      const e = event as { message?: string; error?: { message?: string; code?: string } };
      lastError = [e.error?.code, e.error?.message ?? e.message].filter(Boolean).join(" ") || "error";
      log.info("relay connection error", { cause: lastError });
    };
  }

  /**
   * After the computer sleeps or loses its network, the socket can look open on both ends while nothing
   * gets through: the Worker keeps the room, phones can't reach this helper, and nobody notices. So ping
   * every KEEPALIVE_MS (Cloudflare answers pings itself) and drop the socket when a pong doesn't come
   * back before the next ping. The room's own pong is required too, within two intervals of the
   * first ping, so a room that never hears this socket is dropped as well.
   */
  private startKeepalive(ws: WebSocket, drop: () => void): void {
    this.stopKeepalive();
    let awaitingPong = false;
    this.roomMissed = 0;
    this.awaitingRoomPong = false;
    ws.addEventListener("pong", () => {
      awaitingPong = false;
    });
    this.keepalive = this.clock.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingRoomPong) this.roomMissed++;
      // The edge answers protocol pings itself, so a pong proves only the path to the edge. The room's own pong
      // proves its code still hears this socket and can send to it: without it, phones that open streams never
      // reach this helper while everything else looks healthy.
      const roomSilent = this.roomMissed >= 2;
      if (awaitingPong || roomSilent) {
        log.info("relay connection went quiet; reconnecting", { missedPong: awaitingPong, roomSilent });
        this.stopKeepalive();
        drop();
        return;
      }
      awaitingPong = true;
      ws.ping();
      this.awaitingRoomPong = true;
      this.sendFrame(0, new TextEncoder().encode(JSON.stringify({ type: "ping" })));
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive) this.clock.clearInterval(this.keepalive);
    this.keepalive = null;
  }

  private onFrame(frame: Uint8Array): void {
    if (frame.length < 4) return;
    const streamId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
    const payload = frame.subarray(4);
    if (streamId === 0) {
      this.onControl(payload);
      return;
    }

    const stream = this.streams.get(streamId);
    if (!stream) return;
    try {
      const { reply, messages } = stream.channel.receive(payload);
      if (reply) this.sendFrame(streamId, reply);
      for (const text of messages) {
        stream.session ??= new ClientSession(
          (out) => this.sendFrame(streamId, stream.channel.seal(out)),
          this.deps,
          () => this.closeStream(streamId, true),
        );
        void stream.session
          .handle(text)
          .catch((err) => log.warn("relay rpc failed", { err: errMessage(err) }));
      }
    } catch (err) {
      // Bad handshake, tampered or replayed frame: drop the stream.
      log.warn("relay stream rejected", { err: errMessage(err) });
      this.closeStream(streamId, true);
    }
  }

  private onControl(payload: Uint8Array): void {
    let msg: { type?: string; stream?: number };
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (msg.type === "pong") {
      this.awaitingRoomPong = false;
      this.roomMissed = 0;
      return;
    }
    if (typeof msg.stream !== "number") return;
    if (msg.type === "open") {
      if (this.streams.size >= MAX_STREAMS) {
        this.closeStream(msg.stream, true);
        return;
      }
      const streamId = msg.stream;
      // An idle or unauthenticated stream holds one of the room's slots: drop it after 30 s.
      const authTimer = setTimeout(() => {
        if (!this.streams.get(streamId)?.session?.isAuthenticated) this.closeStream(streamId, true);
      }, AUTH_TIMEOUT_MS);
      this.streams.set(streamId, { channel: new MacChannel(this.identity), session: null, authTimer });
    } else if (msg.type === "closed") {
      this.closeStream(msg.stream, false);
    }
  }

  private sendFrame(streamId: number, payload: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, streamId);
    frame.set(payload, 4);
    this.ws.send(frame);
  }

  private closeStream(streamId: number, tellRelay: boolean): void {
    const stream = this.streams.get(streamId);
    if (stream) clearTimeout(stream.authTimer);
    stream?.session?.close();
    this.streams.delete(streamId);
    if (tellRelay) {
      const json = new TextEncoder().encode(JSON.stringify({ type: "close", stream: streamId }));
      this.sendFrame(0, json);
    }
  }

  private closeAllStreams(): void {
    for (const s of this.streams.values()) {
      clearTimeout(s.authTimer);
      s.session?.close();
    }
    this.streams.clear();
  }
}

import type { RelayEvent } from "../../../protocol/index.ts";
import { RELAY_FRAME_BYTES, RpcRequest } from "../../../protocol/index.ts";
import { log } from "../log.ts";
import { hostInfo } from "../platform/index.ts";
import {
  authenticate,
  type Device,
  isDeviceActive,
  onDeviceRevoked,
  pairingAttemptAllowed,
  redeemPairingCode,
} from "./auth.ts";
import type { DB } from "./db.ts";
import type { EventLog } from "./events.ts";
import type { RpcOutcome } from "./rpc.ts";

type Rpc = (method: string, params: unknown, actor: string) => Promise<RpcOutcome>;

/**
 * The relay's frame limit (cloud/src/index.ts MAX_FRAME): an attachment chunk is about 175 KB of JSON
 * (ATTACHMENT_CHUNK_BYTES in base64), so the old 64 KiB limit would close the stream on the first one.
 */
const MAX_MESSAGE = RELAY_FRAME_BYTES;
/** What a reply may take: the frame limit less the stream id and encryption the link adds. */
const MAX_REPLY_BYTES = RELAY_FRAME_BYTES - 1024;

/**
 * One phone connection over the relay's encrypted stream. Same JSON protocol as the direct WebSocket,
 * plus `pair` and `hello` (which replace the HTTP pairing endpoint and the Bearer header). Nothing but
 * `pair`/`hello` is served until the phone has authenticated on this stream.
 */
export class ClientSession {
  private device: Device | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopRevokeWatch: (() => void) | null = null;
  private failedAuth = 0;
  private closed = false;

  get isAuthenticated(): boolean {
    return this.device !== null;
  }

  constructor(
    private readonly send: (text: string) => void,
    private readonly deps: { rpc: Rpc; events: EventLog; db: DB },
    private readonly onFatal: () => void,
  ) {}

  async handle(text: string): Promise<void> {
    if (this.closed) return;
    if (text.length > MAX_MESSAGE) return this.fatal("message too large");
    let req: RpcRequest;
    try {
      req = RpcRequest.parse(JSON.parse(text));
    } catch {
      return this.reply(null, { error: { code: "bad_request", message: "invalid message" } });
    }
    const id = req.id ?? null;
    const params = (req.params ?? {}) as Record<string, unknown>;

    if (req.method === "pair") {
      if (!pairingAttemptAllowed())
        return this.reply(id, {
          error: { code: "unavailable", message: "too many attempts, wait a minute" },
        });
      const code = typeof params.code === "string" ? params.code : "";
      const name = typeof params.deviceName === "string" ? params.deviceName : "iPhone";
      const res = code ? redeemPairingCode(this.deps.db, code, name) : null;
      if (!res) return this.authFailed(id, "invalid or expired pairing code");
      this.authenticated(res.device);
      log.info("device paired over relay", { device: res.device.name });
      return this.reply(id, {
        result: { deviceId: res.device.id, token: res.token, pushKey: res.pushKey, host: await hostInfo() },
      });
    }

    if (req.method === "hello") {
      const token = typeof params.token === "string" ? params.token : "";
      const device = token ? authenticate(this.deps.db, `Bearer ${token}`) : null;
      if (!device) return this.authFailed(id, "this iPhone is no longer paired");
      this.authenticated(device);
      return this.reply(id, { result: { ok: true, host: await hostInfo() } });
    }

    if (!this.device) return this.reply(id, { error: { code: "unauthorized", message: "say hello first" } });
    if (!isDeviceActive(this.deps.db, this.device.id)) return this.fatal("device revoked");
    this.reply(id, await this.deps.rpc(req.method, req.params, `device:${this.device.id}`), req.method);
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopRevokeWatch?.();
    this.stopRevokeWatch = null;
  }

  private authenticated(device: Device): void {
    this.device = device;
    // Revoked while connected: end the stream; the phone's next hello is refused and it asks to re-pair.
    this.stopRevokeWatch?.();
    this.stopRevokeWatch = onDeviceRevoked((id) => {
      if (id === device.id) this.fatal("device revoked");
    });
    if (!this.unsubscribe) {
      this.unsubscribe = this.deps.events.subscribe((event: RelayEvent) => this.sendEvent(event));
    }
  }

  private authFailed(id: string | number | null, message: string): void {
    this.failedAuth++;
    this.reply(id, { error: { code: "unauthorized", message } });
    // Don't let one stream guess tokens or codes.
    if (this.failedAuth >= 3) this.fatal("too many failed attempts");
  }

  /**
   * A result over the relay's frame limit would make the relay close the Mac's whole link, for every phone: it's
   * answered with an error instead, and the method is logged.
   */
  private reply(id: string | number | null, outcome: RpcOutcome, method?: string): void {
    let text = JSON.stringify({ type: "rpc", id, ...outcome });
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_REPLY_BYTES) {
      log.warn("reply too big for the relay, sent an error instead", { method: method ?? "?", bytes });
      text = JSON.stringify({
        type: "rpc",
        id,
        error: { code: "unavailable", message: "the answer was too big to send" },
      });
    }
    this.send(text);
  }

  private sendEvent(event: RelayEvent): void {
    const text = JSON.stringify({ type: "event", event });
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_REPLY_BYTES) {
      log.warn("event too big for the relay, not sent", { type: event.type, seq: event.seq, bytes });
      return;
    }
    this.send(text);
  }

  private fatal(reason: string): void {
    log.warn("closing relay stream", { reason });
    this.close();
    this.onFatal();
  }
}

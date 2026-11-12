import { createCipheriv, createHash, randomBytes, sign } from "node:crypto";
import type { Identity } from "./e2e.ts";
import { b64url } from "./e2e.ts";
import type { FcmMessage, FcmResult } from "./fcm.ts";
import type { ApnsEnvironment, ApnsResult } from "./push.ts";

const FCM_TOKEN = /^[A-Za-z0-9:_-]{20,4096}$/;

/**
 * POSTs a body to the relay's /v1/push, signed with this Mac's relay identity over the body's hash:
 * `relay-push-v1:<macId>:<ts>:<b64url(sha256(body))>` (cloud/src/push.ts).
 */
async function signedPush(
  endpoint: string,
  identity: Identity,
  body: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; reason?: string }> {
  const ts = Date.now();
  const bodyHash = b64url(createHash("sha256").update(body).digest());
  const sig = sign(
    null,
    Buffer.from(`relay-push-v1:${identity.macId}:${ts}:${bodyHash}`),
    identity.authPrivate,
  );
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-mac": identity.macId,
        "x-relay-pub": b64url(identity.authPublic),
        "x-relay-ts": String(ts),
        "x-relay-sig": b64url(sig),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json().catch(() => ({}))) as { status?: number; reason?: string };
    return { status: reply.status ?? res.status, reason: reply.reason };
  } catch (err) {
    return { status: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** wss://host → https://host/v1/push */
const pushEndpoint = (relayUrl: string) => new URL("/v1/push", relayUrl.replace(/^ws/, "http")).toString();

/**
 * Sends APNs pushes through the relay Worker, which holds the app's APNs key. The Mac signs each
 * request with its relay identity (the same Ed25519 key that opens its room), over the body's hash:
 * `relay-push-v1:<macId>:<ts>:<b64url(sha256(body))>` (cloud/src/push.ts).
 */
export class RelayApns {
  private readonly endpoint: string;

  constructor(
    relayUrl: string,
    private readonly identity: Identity,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = pushEndpoint(relayUrl);
  }

  async send(
    deviceToken: string,
    environment: ApnsEnvironment,
    payload: object,
    opts: { pushType?: "alert" | "background"; collapseId?: string; priority?: 5 | 10 } = {},
  ): Promise<ApnsResult> {
    if (!/^[0-9a-f]{64,200}$/i.test(deviceToken)) return { status: 400, reason: "BadDeviceToken" };
    const body = JSON.stringify({
      token: deviceToken.toLowerCase(),
      environment,
      payload,
      ...(opts.collapseId ? { collapseId: opts.collapseId.slice(0, 64) } : {}),
      ...(opts.pushType ? { pushType: opts.pushType } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
    });
    return signedPush(this.endpoint, this.identity, body, this.fetchImpl);
  }
}

/**
 * Sends Android pushes through the relay Worker, which holds the Firebase service-account key: the same
 * signed request as RelayApns, with `platform: "fcm"`. The Mac seals the text for the phone first
 * (sealedFcmMessage), so Google and Cloudflare see only the category and an opaque blob.
 */
export class RelayFcm {
  private readonly endpoint: string;

  constructor(
    relayUrl: string,
    private readonly identity: Identity,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = pushEndpoint(relayUrl);
  }

  async send(deviceToken: string, message: FcmMessage): Promise<FcmResult> {
    if (!FCM_TOKEN.test(deviceToken)) return { status: 400, reason: "INVALID_ARGUMENT" };
    const body = JSON.stringify({
      platform: "fcm",
      token: deviceToken,
      payload: { data: message.data },
      ...(message.android.collapse_key ? { collapseId: message.android.collapse_key.slice(0, 64) } : {}),
    });
    return signedPush(this.endpoint, this.identity, body, this.fetchImpl);
  }
}

/**
 * Encrypts a notification's text for one phone: AES-256-GCM with that phone's push key, random
 * 12-byte nonce, sent as base64(nonce || ciphertext || tag), the layout CryptoKit's
 * `AES.GCM.SealedBox(combined:)` reads. Only the phone's Notification Service Extension can open it.
 */
export function sealForPhone(keyB64: string, plaintext: object): string {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("push key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

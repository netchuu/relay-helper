/**
 * Push notifications through the relay. Each Mac signs its request with the same Ed25519 identity it
 * uses to open its room; the Worker holds the one APNs key and the one Firebase (FCM) service-account
 * key, so no user's Mac needs either.
 *
 * Anyone can make a Mac identity, so the Worker doesn't pass a sender's notification through: it builds
 * the APNs payload itself from a few checked fields (the category, the thread id and the encrypted blob
 * the phone opens) under a fixed visible alert, GENERIC_ALERT. The phone's Notification Service Extension
 * replaces that alert with the decrypted text; a blob it can't open leaves the fixed alert showing.
 * FCM messages keep their data map, minus the keys a phone shows as text (FCM_TEXT_KEYS).
 */

export interface PushEnv {
  /** The APNs auth key (.p8 contents, PEM). Wrangler secret. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** The app's bundle id. */
  APNS_TOPIC?: string;
  /** Tests only: send to this base URL instead of Apple's servers. */
  APNS_BASE_URL?: string;
  /** The Firebase service-account key (the JSON file Google issues). Wrangler secret. */
  FCM_SERVICE_ACCOUNT?: string;
  /** Tests only: send to these URLs instead of Google's. */
  FCM_BASE_URL?: string;
  FCM_TOKEN_URL?: string;
}

export interface PushRequest {
  /** "apns" (the default, so iOS-era helpers keep working) or "fcm" for Android. */
  platform?: "apns" | "fcm";
  token: string;
  /** APNs only. */
  environment: "sandbox" | "production";
  /** Built by the Worker (parsePushRequest), never the sender's own. APNs: aps/relay. FCM: `{data}`. */
  payload: Record<string, unknown>;
  collapseId?: string;
}

/** The only visible text the Worker sends to Apple. The same as the helper's sealed payload uses. */
export const GENERIC_ALERT = { title: "Relay", body: "New activity on your Mac" } as const;
/** The categories the iOS app registers (notifier.ts → Category). Anything else becomes NOTICE. */
export const CATEGORIES = new Set([
  "QUESTION",
  "PLAN",
  "PERMISSION",
  "PERMISSION_ALWAYS",
  "PERMISSION_REVIEW",
  "DONE",
  "NOTICE",
]);
/** FCM data keys a phone shows as text. The Worker drops them: only sealed text reaches a phone. */
export const FCM_TEXT_KEYS = ["title", "body", "question", "options"] as const;

export const MAX_PUSH_BODY = 6 * 1024;
const MAX_PAYLOAD = 4096; // APNs limit for alert payloads
const TOKEN = /^[0-9a-f]{64,200}$/;
const FCM_TOKEN = /^[A-Za-z0-9:_-]{20,4096}$/;
const MAX_FCM_DATA = 4000; // FCM allows 4 KB of data
/** Thread ids (session ids, "relay") and collapse ids (prompt ids): plain ids, else left out. */
const THREAD_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COLLAPSE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** sealForPhone's base64(nonce || ciphertext || tag). */
const SEALED = /^[A-Za-z0-9+/]{40,4000}={0,2}$/;

export function parsePushRequest(body: string): PushRequest | string {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(body);
  } catch {
    return "invalid JSON";
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) return "invalid JSON";
  if (req.platform !== undefined && req.platform !== "apns" && req.platform !== "fcm")
    return "invalid platform";
  if (req.collapseId !== undefined && (typeof req.collapseId !== "string" || req.collapseId.length > 64))
    return "invalid collapseId";
  const collapseId =
    typeof req.collapseId === "string" && COLLAPSE_ID.test(req.collapseId) ? req.collapseId : undefined;
  if (req.platform === "fcm") return parseFcm(req, collapseId);
  if (typeof req.token !== "string" || !TOKEN.test(req.token)) return "invalid token";
  if (req.environment !== "sandbox" && req.environment !== "production") return "invalid environment";
  if (!isObject(req.payload)) return "invalid payload";
  // A silent push would turn into a visible one here; no helper sends one.
  if (req.pushType !== undefined && req.pushType !== "alert") return "invalid pushType";
  if (req.priority !== undefined && req.priority !== 5 && req.priority !== 10) return "invalid priority";
  const payload = apnsPayloadFrom(req.payload);
  if (typeof payload === "string") return payload;
  return { token: req.token, environment: req.environment, payload, ...(collapseId ? { collapseId } : {}) };
}

/**
 * The APNs payload the Worker sends, from the sender's: its category (one the app knows), its thread id and
 * its sealed blob (`relay.enc`), under GENERIC_ALERT. Everything else, the sender's alert text and any
 * plain `relay` data from an older helper included, is left out.
 */
export function apnsPayloadFrom(sent: Record<string, unknown>): Record<string, unknown> | string {
  const aps = isObject(sent.aps) ? sent.aps : {};
  const relay = isObject(sent.relay) ? sent.relay : {};
  const category = typeof aps.category === "string" && CATEGORIES.has(aps.category) ? aps.category : "NOTICE";
  const threadId = aps["thread-id"];
  const enc = relay.enc;
  if (enc !== undefined && (typeof enc !== "string" || !SEALED.test(enc))) return "invalid payload";
  const payload = {
    aps: {
      alert: { ...GENERIC_ALERT },
      sound: "default",
      category,
      ...(typeof threadId === "string" && THREAD_ID.test(threadId) ? { "thread-id": threadId } : {}),
      // The extension runs for every push, so it can open the blob.
      "mutable-content": 1,
    },
    ...(typeof enc === "string" ? { relay: { v: 1, enc } } : {}),
  };
  if (JSON.stringify(payload).length > MAX_PAYLOAD) return "payload too large";
  return payload;
}

function parseFcm(req: Record<string, unknown>, collapseId: string | undefined): PushRequest | string {
  if (typeof req.token !== "string" || !FCM_TOKEN.test(req.token)) return "invalid token";
  const sent = isObject(req.payload) ? req.payload.data : undefined;
  if (!isObject(sent)) return "invalid payload";
  if (!Object.values(sent).every((v) => typeof v === "string")) return "invalid payload";
  if (JSON.stringify(sent).length > MAX_FCM_DATA) return "payload too large";
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(sent))
    if (!(FCM_TEXT_KEYS as readonly string[]).includes(key)) data[key] = value as string;
  return {
    platform: "fcm",
    token: req.token,
    environment: "production",
    payload: { data },
    ...(collapseId ? { collapseId } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pushes one device token may get, from all Macs together. A Mac identity costs nothing to make, so the per-Mac
 * limit alone doesn't protect a phone whose token someone has. Real use (a few sessions, a phone paired to a
 * couple of Macs) stays far below both.
 */
export const TOKEN_PUSHES_PER_MINUTE = 30;
export const TOKEN_PUSHES_PER_HOUR = 300;

/**
 * The request body as text, or null when it is over `max` bytes. A declared length over the limit is refused
 * before anything is read; a body without one (chunked) is read only up to the limit.
 */
export async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The string the Mac signs: binds the request body (by hash) to its room and a fresh timestamp. */
export function pushSigningInput(macId: string, ts: number, bodySha256B64url: string): string {
  return `relay-push-v1:${macId}:${ts}:${bodySha256B64url}`;
}

/** How long one provider token is reused. Apple accepts it for an hour and answers 429
 * TooManyProviderTokenUpdates when tokens change more often than about every 20 minutes. */
export const PROVIDER_TOKEN_LIFETIME_MS = 40 * 60_000;

/** Supplies the APNs provider token. In production one Durable Object holds it for every Worker instance
 * (Room.apnsToken); each instance minting its own made Apple reject pushes. */
export type ProviderTokenSource = () => Promise<string>;

/** Signs a fresh ES256 provider token. Callers cache it (see PROVIDER_TOKEN_LIFETIME_MS). */
export async function mintProviderToken(env: PushEnv, now = Date.now()): Promise<string> {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) throw new Error("APNs is not configured");
  const der = Uint8Array.from(atob(env.APNS_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "ES256", kid: env.APNS_KEY_ID })}.${enc({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`;
  // WebCrypto ECDSA signatures are already the raw r||s form JWT wants.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)),
  );
  return `${unsigned}.${b64url(sig)}`;
}

/** Sends one notification. Deployed Workers reach APNs over HTTP/2 (`wrangler dev` can't). */
export async function sendToApns(
  env: PushEnv,
  req: PushRequest,
  providerToken: ProviderTokenSource = () => mintProviderToken(env),
): Promise<{ status: number; reason?: string }> {
  if (!env.APNS_TOPIC) return { status: 503, reason: "APNs is not configured" };
  const base =
    env.APNS_BASE_URL ??
    (req.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com");
  const headers: Record<string, string> = {
    authorization: `bearer ${await providerToken()}`,
    "apns-topic": env.APNS_TOPIC,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
    "content-type": "application/json",
  };
  if (req.collapseId) headers["apns-collapse-id"] = req.collapseId;
  const res = await fetch(`${base}/3/device/${req.token}`, {
    method: "POST",
    headers,
    body: JSON.stringify(req.payload),
  });
  if (res.status === 200) return { status: 200 };
  const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason;
  return { status: res.status, reason };
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// -------------------------------------------------------------------------------------------------
// FCM (Android)

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
let fcmAccess: { token: string; expiresAt: number; account: string } | null = null;

function serviceAccount(env: PushEnv): ServiceAccount {
  if (!env.FCM_SERVICE_ACCOUNT) throw new Error("FCM is not configured");
  let sa: Partial<ServiceAccount>;
  try {
    sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as Partial<ServiceAccount>;
  } catch {
    // JSON.parse's message quotes the text around the error: part of the secret.
    throw new Error("FCM service account is not valid JSON");
  }
  if (!sa?.project_id || !sa.client_email || !sa.private_key)
    throw new Error("FCM service account is incomplete");
  return sa as ServiceAccount;
}

/** An OAuth access token from the service-account key (RS256 assertion, RFC 7523), cached 55 minutes. */
async function fcmAccessToken(
  env: PushEnv,
  sa: ServiceAccount,
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<string> {
  if (fcmAccess && fcmAccess.account === sa.client_email && now < fcmAccess.expiresAt) return fcmAccess.token;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tokenUrl = env.FCM_TOKEN_URL ?? GOOGLE_TOKEN_URL;
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const iat = Math.floor(now / 1000);
  const unsigned = `${enc({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) })}.${enc(
    {
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
    },
  )}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  fcmAccess = { token: body.access_token, expiresAt: now + 55 * 60_000, account: sa.client_email };
  return body.access_token;
}

/** Sends one data-only FCM message; the app builds the notification and its buttons itself. */
export async function sendToFcm(
  env: PushEnv,
  req: PushRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; reason?: string }> {
  const sa = serviceAccount(env);
  const bearer = await fcmAccessToken(env, sa, fetchImpl);
  const base = env.FCM_BASE_URL ?? "https://fcm.googleapis.com";
  const res = await fetchImpl(`${base}/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token: req.token,
        data: (req.payload as { data: Record<string, string> }).data,
        android: {
          priority: "high",
          ttl: "3600s",
          ...(req.collapseId ? { collapse_key: req.collapseId } : {}),
        },
      },
    }),
  });
  if (res.status === 200) return { status: 200 };
  if (res.status === 401) fcmAccess = null;
  const err = (
    (await res.json().catch(() => ({}))) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    }
  ).error;
  return { status: res.status, reason: err?.details?.find((d) => d.errorCode)?.errorCode ?? err?.status };
}

/** Tests only: forget the cached Google access token. */
export function resetFcmCache(): void {
  fcmAccess = null;
}

export function sendPush(
  env: PushEnv,
  req: PushRequest,
  providerToken?: ProviderTokenSource,
): Promise<{ status: number; reason?: string }> {
  return req.platform === "fcm" ? sendToFcm(env, req) : sendToApns(env, req, providerToken);
}

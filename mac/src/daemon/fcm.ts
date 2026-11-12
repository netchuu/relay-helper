import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RELAY_HOME } from "../config.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Google issues access tokens for an hour; refresh a little early. */
const ACCESS_TOKEN_TTL_MS = 55 * 60_000;
const FCM_TOKEN = /^[A-Za-z0-9:_-]{20,4096}$/;

const ServiceAccount = z.object({
  type: z.literal("service_account").optional(),
  project_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  private_key_id: z.string().optional(),
  private_key: z.string().includes("PRIVATE KEY"),
  client_email: z.string().includes("@"),
});
export type FcmServiceAccount = z.infer<typeof ServiceAccount>;

export type FcmConfigCheck =
  | { state: "missing"; path: string }
  | { state: "bad_mode"; path: string; mode: number }
  | { state: "bad_json"; path: string }
  | { state: "invalid"; path: string; problem: string }
  | { state: "ok"; path: string; config: FcmServiceAccount };

export function fcmConfigPath(home = RELAY_HOME): string {
  return join(home, "fcm", "service-account.json");
}

/**
 * Inspects ~/.relay/fcm/service-account.json without ever returning key material in an error. The key
 * can send pushes to every install of the app, so a file other local users can read is refused.
 */
export function checkFcmConfig(home = RELAY_HOME): FcmConfigCheck {
  const path = fcmConfigPath(home);
  if (!existsSync(path)) return { state: "missing", path };
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) return { state: "bad_mode", path, mode };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "bad_json", path };
  }
  const parsed = ServiceAccount.safeParse(raw);
  if (!parsed.success) {
    // Name the fields only; zod messages can quote the offending value.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    return { state: "invalid", path, problem: `bad or missing ${fields.join(", ")}` };
  }
  try {
    createPrivateKey(parsed.data.private_key);
  } catch {
    return { state: "invalid", path, problem: "private_key is not a readable PEM key" };
  }
  return { state: "ok", path, config: parsed.data };
}

/** Reads the service-account key; push to Android is simply off when it is missing or unusable. */
export function loadFcmConfig(home = RELAY_HOME): { config: FcmServiceAccount | null; problem?: string } {
  const check = checkFcmConfig(home);
  switch (check.state) {
    case "ok":
      return { config: check.config };
    case "missing":
      return { config: null };
    case "bad_mode":
      return {
        config: null,
        problem: `${check.path} is mode ${check.mode.toString(8)}; run chmod 600 on it`,
      };
    case "bad_json":
      return { config: null, problem: `${check.path} is not valid JSON` };
    case "invalid":
      return { config: null, problem: `${check.path}: ${check.problem}` };
  }
}

export interface FcmResult {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  /** FCM's errorCode (UNREGISTERED, INVALID_ARGUMENT, …) or, failing that, the Google API status. */
  reason?: string;
}

export interface FcmMessage {
  data: Record<string, string>;
  android: { priority: "high" | "normal"; collapse_key?: string; ttl: string };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Sends FCM HTTP v1 messages with an OAuth access token minted from the service-account key. */
export class Fcm {
  private readonly key: KeyObject;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private access: { token: Promise<string>; expiresAt: number } | null = null;

  constructor(
    readonly config: FcmServiceAccount,
    opts: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.key = createPrivateKey(config.private_key);
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
  }

  /** The RS256 assertion exchanged for an access token (RFC 7523). */
  assertion(now = this.now()): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const iat = Math.floor(now / 1000);
    const header = {
      alg: "RS256",
      typ: "JWT",
      ...(this.config.private_key_id ? { kid: this.config.private_key_id } : {}),
    };
    const claims = { iss: this.config.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
    const unsigned = `${enc(header)}.${enc(claims)}`;
    const signature = sign("sha256", Buffer.from(unsigned), this.key);
    return `${unsigned}.${signature.toString("base64url")}`;
  }

  /** A cached access token; concurrent callers share one exchange. */
  accessToken(): Promise<string> {
    const now = this.now();
    if (this.access && now < this.access.expiresAt) return this.access.token;
    const token = this.exchange(now);
    const entry = { token, expiresAt: now + ACCESS_TOKEN_TTL_MS };
    this.access = entry;
    token.catch(() => {
      if (this.access === entry) this.access = null;
    });
    return token;
  }

  private async exchange(now: number): Promise<string> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: this.assertion(now),
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!res.ok || !body.access_token)
      throw new Error(
        `Google token exchange failed: HTTP ${res.status}${body.error ? ` ${body.error}` : ""}`,
      );
    return body.access_token;
  }

  async send(deviceToken: string, message: FcmMessage): Promise<FcmResult> {
    if (!FCM_TOKEN.test(deviceToken)) return { status: 400, reason: "INVALID_ARGUMENT" };
    let res: Response;
    try {
      const bearer = await this.accessToken();
      res = await this.fetch(
        `https://fcm.googleapis.com/v1/projects/${this.config.project_id}/messages:send`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ message: { token: deviceToken, ...message } }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      return { status: 0, reason: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 200) return { status: 200 };
    // A revoked or expired access token: mint a new one next time.
    if (res.status === 401) this.access = null;
    const text = await res.text().catch(() => "");
    return { status: res.status, reason: fcmReason(text) };
  }
}

/** Pulls `errorCode` out of FCM's error details, falling back to the Google API status. */
function fcmReason(text: string): string | undefined {
  try {
    const err = (
      JSON.parse(text) as {
        error?: { status?: string; details?: { "@type"?: string; errorCode?: string }[] };
      }
    ).error;
    const code = err?.details?.find((d) => d.errorCode)?.errorCode;
    return code ?? err?.status;
  } catch {
    return text ? text.slice(0, 200) : undefined;
  }
}

/** FCM registration tokens that will never work again and should be forgotten. */
export function isDeadFcmToken(result: FcmResult): boolean {
  return (
    result.reason === "UNREGISTERED" ||
    result.status === 404 ||
    (result.status === 400 && result.reason === "INVALID_ARGUMENT")
  );
}

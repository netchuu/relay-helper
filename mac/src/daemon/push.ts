import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CHILD_PATH, RELAY_HOME } from "../config.ts";

const ApnsConfig = z.object({
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  keyPath: z.string(),
  bundleId: z.string(),
});
export type ApnsConfig = z.infer<typeof ApnsConfig>;

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsResult {
  status: number;
  reason?: string;
}

/** Reads ~/.relay/apns/apns.json; push is simply off when it is missing. */
export function loadApnsConfig(home = RELAY_HOME): ApnsConfig | null {
  const path = join(home, "apns", "apns.json");
  if (!existsSync(path)) return null;
  const parsed = ApnsConfig.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data : null;
}

/**
 * Sends APNs requests with token (JWT) auth straight from the Mac. Uses curl for HTTP/2 because Bun's
 * node:http2 client got no response from Apple in testing (Bun 1.3.10), while macOS curl (nghttp2) works.
 */
export class Apns {
  private readonly key: KeyObject;
  private jwt: { token: string; issuedAt: number } | null = null;

  constructor(readonly config: ApnsConfig) {
    this.key = createPrivateKey(readFileSync(config.keyPath));
  }

  /** Apple accepts a token for up to an hour and rejects refreshing more than every 20 minutes. */
  bearer(now = Date.now()): string {
    if (this.jwt && now - this.jwt.issuedAt < 40 * 60_000) return this.jwt.token;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "ES256", kid: this.config.keyId })}.${enc({ iss: this.config.teamId, iat: Math.floor(now / 1000) })}`;
    const signature = sign("sha256", Buffer.from(unsigned), { key: this.key, dsaEncoding: "ieee-p1363" });
    this.jwt = { token: `${unsigned}.${signature.toString("base64url")}`, issuedAt: now };
    return this.jwt.token;
  }

  async send(
    deviceToken: string,
    environment: ApnsEnvironment,
    payload: object,
    opts: {
      pushType?: "alert" | "background";
      collapseId?: string;
      priority?: 5 | 10;
      expirySeconds?: number;
    } = {},
  ): Promise<ApnsResult> {
    if (!/^[0-9a-f]{64,200}$/i.test(deviceToken)) return { status: 400, reason: "BadDeviceToken" };
    const host = environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
    const pushType = opts.pushType ?? "alert";
    const headers = [
      `authorization: bearer ${this.bearer()}`,
      `apns-topic: ${this.config.bundleId}`,
      `apns-push-type: ${pushType}`,
      `apns-priority: ${opts.priority ?? (pushType === "background" ? 5 : 10)}`,
      `apns-expiration: ${Math.floor(Date.now() / 1000) + (opts.expirySeconds ?? 3600)}`,
      ...(opts.collapseId ? [`apns-collapse-id: ${opts.collapseId.slice(0, 64)}`] : []),
    ];
    const args = [
      "curl",
      "-sS",
      "--http2",
      "--max-time",
      "15",
      "-X",
      "POST",
      "--data-binary",
      "@-",
      "-w",
      "\n%{http_code}",
    ];
    // Headers go through a private file, not argv: `ps` shows every process's arguments to other
    // local users, and the bearer JWT can push to any app on the team for up to an hour.
    const dir = mkdtempSync(join(tmpdir(), "relay-apns-"));
    const headerFile = join(dir, "headers");
    writeFileSync(headerFile, `${headers.join("\n")}\n`, { mode: 0o600 });
    args.push("-H", `@${headerFile}`);
    args.push(`https://${host}/3/device/${deviceToken}`);
    let out: string;
    let err: string;
    let code: number;
    try {
      const proc = Bun.spawn(args, {
        stdin: new Blob([JSON.stringify(payload)]),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: CHILD_PATH },
      });
      [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (code !== 0) return { status: 0, reason: err.trim() || `curl exited ${code}` };
    const lines = out.trimEnd().split("\n");
    const status = Number(lines.pop());
    const body = lines.join("\n");
    let reason: string | undefined;
    if (body) {
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        reason = body.slice(0, 200);
      }
    }
    return { status, reason };
  }
}

/** Device tokens that will never work again and should be forgotten. */
export function isDeadToken(result: ApnsResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 &&
      (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))
  );
}

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Prompt, RpcSchemas } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { checkFcmConfig, Fcm, type FcmMessage, isDeadFcmToken, loadFcmConfig } from "../src/daemon/fcm.ts";
import { type Alert, Category, fcmMessage, Notifier, promptAlert } from "../src/daemon/notifier.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = {
  type: "service_account" as const,
  project_id: "relay-test",
  private_key_id: "kid123",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_email: "relay@relay-test.iam.gserviceaccount.com",
};
const FCM_TOKEN = "dGVzdC10b2tlbg:APA91b-abc_DEF123456789";
const HEX_TOKEN = "ab".repeat(32);

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

/** A fake Google: token endpoint plus messages:send answering with `sendStatus`/`sendBody`. */
function fakeGoogle(sendStatus = 200, sendBody: object = { name: "projects/relay-test/messages/1" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: `ya29.token${calls.length}`, expires_in: 3599 });
    return Response.json(sendBody, { status: sendStatus });
  };
  return { calls, fetch };
}

describe("FCM OAuth", () => {
  test("signs an RS256 assertion Google can verify", () => {
    const fcm = new Fcm(serviceAccount);
    const jwt = fcm.assertion(1_000_000);
    const [h = "", p = "", s = ""] = jwt.split(".");
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid123" });
    expect(decode(p)).toEqual({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1000,
      exp: 4600,
    });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  test("exchanges the assertion once and caches the access token for 55 minutes", async () => {
    let now = 1_000_000;
    const google = fakeGoogle();
    const fcm = new Fcm(serviceAccount, { fetch: google.fetch, now: () => now });
    const [a, b] = await Promise.all([fcm.accessToken(), fcm.accessToken()]);
    expect(a).toBe(b);
    expect(google.calls).toHaveLength(1);
    const body = new URLSearchParams(String(google.calls[0]?.init.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")?.split(".")).toHaveLength(3);
    now += 54 * 60_000;
    expect(await fcm.accessToken()).toBe(a);
    now += 2 * 60_000;
    expect(await fcm.accessToken()).not.toBe(a);
    expect(google.calls).toHaveLength(2);
  });

  test("a failed exchange is not cached", async () => {
    let fail = true;
    const fcm = new Fcm(serviceAccount, {
      fetch: async () =>
        fail
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({ access_token: "ok" }),
    });
    await expect(fcm.accessToken()).rejects.toThrow("invalid_grant");
    fail = false;
    expect(await fcm.accessToken()).toBe("ok");
  });
});

describe("FCM messages", () => {
  const question = (): Prompt => ({
    id: "p_1",
    sessionId: "s1",
    kind: "question",
    payload: {
      kind: "question",
      questions: [{ question: "Which DB?", options: [{ label: "SQLite" }, { label: "Postgres" }] }],
    },
    status: "open",
    resolvedBy: null,
    createdAt: 0,
    resolvedAt: null,
  });

  test("data-only, every value a string, options as a JSON array", () => {
    const msg = fcmMessage(promptAlert(question(), "web-shop"));
    expect(msg).toEqual({
      data: {
        title: "web-shop asks",
        body: "Which DB?",
        category: Category.question,
        threadId: "s1",
        promptId: "p_1",
        sessionId: "s1",
        kind: "question",
        question: "Which DB?",
        options: '["SQLite","Postgres"]',
      },
      android: { priority: "high", collapse_key: "p_1", ttl: "3600s" },
    });
    expect(Object.values(msg.data).every((v) => typeof v === "string")).toBe(true);
    expect(msg).not.toHaveProperty("notification");
  });

  test("no collapse key without a collapse id; turn ids come through", () => {
    const msg = fcmMessage({
      title: "web-shop is done",
      body: "Fixed.",
      category: Category.done,
      threadId: "s1",
      data: { sessionId: "s1", turnId: "t1" },
    });
    expect(msg.android).toEqual({ priority: "high", ttl: "3600s" });
    expect(msg.data.turnId).toBe("t1");
  });

  test("sends to the v1 endpoint with the bearer token", async () => {
    const google = fakeGoogle();
    const fcm = new Fcm(serviceAccount, { fetch: google.fetch });
    const message: FcmMessage = { data: { title: "t" }, android: { priority: "high", ttl: "3600s" } };
    expect(await fcm.send(FCM_TOKEN, message)).toEqual({ status: 200 });
    const send = google.calls[1];
    expect(send?.url).toBe("https://fcm.googleapis.com/v1/projects/relay-test/messages:send");
    expect((send?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer ya29.token1",
    );
    expect(JSON.parse(String(send?.init.body))).toEqual({ message: { token: FCM_TOKEN, ...message } });
  });

  test("rejects malformed tokens without calling Google", async () => {
    const google = fakeGoogle();
    const fcm = new Fcm(serviceAccount, { fetch: google.fetch });
    const message: FcmMessage = { data: {}, android: { priority: "high", ttl: "3600s" } };
    expect(await fcm.send("bad token!", message)).toEqual({ status: 400, reason: "INVALID_ARGUMENT" });
    expect(google.calls).toHaveLength(0);
  });

  test("reads FCM's errorCode and recognises dead tokens", async () => {
    const google = fakeGoogle(404, {
      error: {
        code: 404,
        status: "NOT_FOUND",
        details: [
          { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" },
        ],
      },
    });
    const fcm = new Fcm(serviceAccount, { fetch: google.fetch });
    const result = await fcm.send(FCM_TOKEN, { data: {}, android: { priority: "high", ttl: "3600s" } });
    expect(result).toEqual({ status: 404, reason: "UNREGISTERED" });
    expect(isDeadFcmToken(result)).toBe(true);
    expect(isDeadFcmToken({ status: 400, reason: "INVALID_ARGUMENT" })).toBe(true);
    expect(isDeadFcmToken({ status: 404 })).toBe(true);
    expect(isDeadFcmToken({ status: 429, reason: "QUOTA_EXCEEDED" })).toBe(false);
    expect(isDeadFcmToken({ status: 503, reason: "UNAVAILABLE" })).toBe(false);
  });
});

describe("routing pushes by platform", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const add = (id: string, token: string, platform: string | null) =>
      db
        .query(
          "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_platform) VALUES (?, ?, ?, 0, ?, 'sandbox', ?)",
        )
        .run(id, id, `hash-${id}`, token, platform);
    add("ios-old", HEX_TOKEN, null); // registered before push_platform existed
    add("android", FCM_TOKEN, "fcm");
    const apnsSent: string[] = [];
    const fcmSent: { token: string; message: FcmMessage }[] = [];
    let fcmStatus = { status: 200 } as { status: number; reason?: string };
    const senders = {
      apns: {
        send: async (token: string) => {
          apnsSent.push(token);
          return { status: 200 };
        },
      },
      fcm: {
        send: async (token: string, message: FcmMessage) => {
          fcmSent.push({ token, message });
          return fcmStatus;
        },
      },
    };
    const notifier = (s: typeof senders | { apns: typeof senders.apns; fcm: null }) =>
      new Notifier(db, {} as never, {} as never, {} as never, {} as never, s);
    const setFcm = (r: { status: number; reason?: string }) => {
      fcmStatus = r;
    };
    return { db, apnsSent, fcmSent, senders, notifier, setFcm };
  };
  const alert: Alert = { title: "T", body: "B", category: Category.notice, threadId: "relay", data: {} };

  test("each device goes through its own service", async () => {
    const { apnsSent, fcmSent, senders, notifier } = setup();
    expect(await notifier(senders).pushAll(alert)).toBe(2);
    expect(apnsSent).toEqual([HEX_TOKEN]);
    expect(fcmSent.map((s) => s.token)).toEqual([FCM_TOKEN]);
    // No push key on this device: the content-free alert, not the alert's own text.
    expect(fcmSent[0]?.message.data).toMatchObject({
      title: "Relay",
      body: "New activity on your Mac",
      category: "NOTICE",
    });
  });

  test("FCM devices are skipped when FCM is not configured", async () => {
    const { apnsSent, senders, notifier } = setup();
    const n = notifier({ apns: senders.apns, fcm: null });
    expect(n.supports("fcm")).toBe(false);
    expect(n.supports("apns")).toBe(true);
    expect(await n.pushAll(alert)).toBe(1);
    expect(apnsSent).toHaveLength(1);
  });

  test("a dead FCM token is forgotten; a transient error is not", async () => {
    const { db, senders, notifier, setFcm } = setup();
    const token = () =>
      (db.query("SELECT apns_token FROM devices WHERE id = 'android'").get() as { apns_token: string | null })
        .apns_token;
    setFcm({ status: 503, reason: "UNAVAILABLE" });
    await notifier(senders).pushAll(alert);
    expect(token()).toBe(FCM_TOKEN);
    setFcm({ status: 404, reason: "UNREGISTERED" });
    await notifier(senders).pushAll(alert);
    expect(token()).toBeNull();
  });
});

describe("device.registerPush params", () => {
  const schema = RpcSchemas["device.registerPush"];

  test("old iOS clients (token + environment) still validate as APNs", () => {
    expect(schema.parse({ token: HEX_TOKEN, environment: "sandbox" })).toEqual({
      platform: "apns",
      token: HEX_TOKEN,
      environment: "sandbox",
    });
    expect(schema.safeParse({ token: HEX_TOKEN }).success).toBe(false);
    expect(schema.safeParse({ token: FCM_TOKEN, environment: "sandbox" }).success).toBe(false);
  });

  test("Android sends an FCM token; environment is optional", () => {
    expect(schema.parse({ platform: "fcm", token: FCM_TOKEN })).toEqual({
      platform: "fcm",
      token: FCM_TOKEN,
      environment: "production",
    });
    expect(schema.safeParse({ platform: "fcm", token: "short" }).success).toBe(false);
    expect(schema.safeParse({ platform: "fcm", token: `${FCM_TOKEN}/x` }).success).toBe(false);
    expect(schema.safeParse({ platform: "gcm", token: FCM_TOKEN }).success).toBe(false);
  });
});

describe("FCM config file", () => {
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-fcm-"));
    mkdirSync(join(dir, "fcm"));
    return dir;
  };
  const write = (dir: string, content: string, mode: number) => {
    const path = join(dir, "fcm", "service-account.json");
    writeFileSync(path, content);
    chmodSync(path, mode);
  };

  test("missing means off, without a problem", () => {
    expect(checkFcmConfig(home()).state).toBe("missing");
    expect(loadFcmConfig(home())).toEqual({ config: null });
  });

  test("a file other users can read is refused", () => {
    const dir = home();
    write(dir, JSON.stringify(serviceAccount), 0o644);
    expect(checkFcmConfig(dir)).toMatchObject({ state: "bad_mode", mode: 0o644 });
    expect(loadFcmConfig(dir).config).toBeNull();
  });

  test("bad JSON and bad fields are reported without key material", () => {
    const dir = home();
    write(dir, "{nope", 0o600);
    expect(checkFcmConfig(dir).state).toBe("bad_json");
    write(
      dir,
      JSON.stringify({ ...serviceAccount, private_key: "-----BEGIN PRIVATE KEY-----\nsecretjunk" }),
      0o600,
    );
    const check = checkFcmConfig(dir);
    expect(check.state).toBe("invalid");
    expect(JSON.stringify(check)).not.toContain("secretjunk");
    write(dir, JSON.stringify({ ...serviceAccount, client_email: undefined }), 0o600);
    expect(checkFcmConfig(dir)).toMatchObject({ state: "invalid", problem: "bad or missing client_email" });
  });

  test("a good file loads", () => {
    const dir = home();
    write(dir, JSON.stringify(serviceAccount), 0o600);
    expect(loadFcmConfig(dir).config?.project_id).toBe("relay-test");
  });
});

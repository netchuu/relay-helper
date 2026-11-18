import { describe, expect, test } from "bun:test";
import { type Prompt, RpcSchemas } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { type FcmMessage, isDeadFcmToken } from "../src/daemon/fcm.ts";
import { type Alert, Category, fcmMessage, Notifier, promptAlert } from "../src/daemon/notifier.ts";

const FCM_TOKEN = "dGVzdC10b2tlbg:APA91b-abc_DEF123456789";
const HEX_TOKEN = "ab".repeat(32);

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

  test("recognises dead tokens", () => {
    expect(isDeadFcmToken({ status: 404, reason: "UNREGISTERED" })).toBe(true);
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

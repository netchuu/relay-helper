import { describe, expect, test } from "bun:test";
import { createDecipheriv, createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePushRequest, resetFcmCache, sendToFcm } from "../../cloud/src/push.ts";
import { openDb } from "../src/daemon/db.ts";
import { loadOrCreateIdentity } from "../src/daemon/e2e.ts";
import { Category, Notifier, sealedApnsPayload, sealedFcmMessage } from "../src/daemon/notifier.ts";
import { RelayApns, RelayFcm, sealForPhone } from "../src/daemon/relayPush.ts";

const key = Buffer.alloc(32, 9).toString("base64");

function openSealed(keyB64: string, blob: string): unknown {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
}

describe("push through the relay", () => {
  test("sealed payloads hide the text and decrypt with the phone's key only", () => {
    const alert = {
      title: "api wants to run Bash",
      body: "rm -rf build",
      category: Category.permission,
      threadId: "s1",
      data: { promptId: "p1", sessionId: "s1" },
    };
    const payload = sealedApnsPayload(alert, key) as { aps: Record<string, unknown>; relay: { enc: string } };
    const visible = JSON.stringify(payload.aps);
    expect(visible).not.toContain("rm -rf");
    expect(payload.aps.category).toBe(Category.permission);
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(openSealed(key, payload.relay.enc)).toEqual({
      title: alert.title,
      body: alert.body,
      data: alert.data,
    });
    expect(() => openSealed(Buffer.alloc(32, 1).toString("base64"), payload.relay.enc)).toThrow();
    // A fresh nonce every time.
    expect(sealForPhone(key, { a: 1 })).not.toBe(sealForPhone(key, { a: 1 }));
  });

  test("the Mac signs the body hash with its relay identity, as the Worker verifies it", async () => {
    const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "relay-id-")), "identity.json"));
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
      return Response.json({ status: 200 });
    }) as unknown as typeof fetch;
    const sender = new RelayApns("wss://relay.example.workers.dev", identity, fakeFetch);
    const result = await sender.send("ab".repeat(32), "production", { aps: {} }, { collapseId: "c1" });
    expect(result.status).toBe(200);
    const s = seen as unknown as { url: string; headers: Record<string, string>; body: string };
    expect(s.url).toBe("https://relay.example.workers.dev/v1/push");
    expect(JSON.parse(s.body)).toMatchObject({
      token: "ab".repeat(32),
      environment: "production",
      collapseId: "c1",
    });
    const hash = createHash("sha256").update(s.body).digest("base64url");
    const message = `relay-push-v1:${identity.macId}:${s.headers["x-relay-ts"]}:${hash}`;
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: s.headers["x-relay-pub"] ?? "" },
      format: "jwk",
    });
    expect(
      verify(null, Buffer.from(message), pub, Buffer.from(s.headers["x-relay-sig"] ?? "", "base64url")),
    ).toBe(true);
    expect(s.headers["x-relay-mac"]).toBe(identity.macId);
    // A bad token never leaves the Mac.
    expect((await sender.send("not-a-token", "sandbox", {})).status).toBe(400);
  });
});

describe("Android push through the relay", () => {
  const fcmToken = "fcm-token:APA91b_abcdefghijklmnop";
  const alert = {
    title: "api wants to run Bash",
    body: "rm -rf build",
    category: Category.permission,
    threadId: "s1",
    collapseId: "p1",
    data: { promptId: "p1", sessionId: "s1", kind: "permission" },
  };

  test("sealed FCM messages carry only the category, the thread and the blob", () => {
    const message = sealedFcmMessage(alert, key);
    expect(Object.keys(message.data).sort()).toEqual(["category", "enc", "threadId", "v"]);
    expect(JSON.stringify(message)).not.toContain("rm -rf");
    expect(openSealed(key, message.data.enc ?? "")).toEqual({
      title: alert.title,
      body: alert.body,
      data: alert.data,
    });
    expect(message.android.collapse_key).toBe("p1");
  });

  test("the Mac posts FCM pushes to the relay as platform fcm, signed like APNs", async () => {
    const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "relay-id-")), "identity.json"));
    let body = "";
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ status: 200 });
    }) as unknown as typeof fetch;
    const sender = new RelayFcm("wss://relay.example.workers.dev", identity, fakeFetch);
    expect((await sender.send(fcmToken, sealedFcmMessage(alert, key))).status).toBe(200);
    const sent = JSON.parse(body);
    expect(sent).toMatchObject({ platform: "fcm", token: fcmToken, collapseId: "p1" });
    expect(Object.keys(sent.payload.data).sort()).toEqual(["category", "enc", "threadId", "v"]);
    // The Worker accepts exactly what the Mac sends.
    expect(typeof parsePushRequest(body)).toBe("object");
    expect((await sender.send("bad token!", sealedFcmMessage(alert, key))).status).toBe(400);
  });

  test("the Worker validates FCM requests", () => {
    const ok = (o: object) => parsePushRequest(JSON.stringify(o));
    expect(ok({ platform: "fcm", token: fcmToken, payload: { data: { v: "1" } } })).toMatchObject({
      platform: "fcm",
    });
    expect(ok({ platform: "fcm", token: "short", payload: { data: {} } })).toBe("invalid token");
    expect(ok({ platform: "fcm", token: fcmToken, payload: { data: { n: 1 } } })).toBe("invalid payload");
    expect(ok({ platform: "fcm", token: fcmToken, payload: { data: { x: "y".repeat(5000) } } })).toBe(
      "payload too large",
    );
    expect(ok({ platform: "web", token: fcmToken, payload: {} })).toBe("invalid platform");
    // iOS requests without a platform still parse as APNs.
    expect(ok({ token: "ab".repeat(32), environment: "sandbox", payload: { aps: {} } })).toMatchObject({
      token: "ab".repeat(32),
    });
  });

  test("the Worker mints a Google token from the service account and sends a data-only message", async () => {
    resetFcmCache();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env = {
      FCM_SERVICE_ACCOUNT: JSON.stringify({
        project_id: "relay-test",
        client_email: "push@relay-test.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
    };
    const calls: { url: string; init: RequestInit }[] = [];
    let sendStatus = 200;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("oauth2")) return Response.json({ access_token: "ya29.test" });
      if (sendStatus === 200) return Response.json({ name: "projects/relay-test/messages/1" });
      return Response.json(
        { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
        { status: sendStatus },
      );
    }) as unknown as typeof fetch;
    const req = {
      platform: "fcm" as const,
      token: fcmToken,
      environment: "production" as const,
      payload: { data: { v: "1", enc: "x" } },
      collapseId: "p1",
    };

    expect(await sendToFcm(env, req, fakeFetch)).toEqual({ status: 200 });
    const assertion = new URLSearchParams(String(calls[0]?.init.body)).get("assertion") ?? "";
    const [h, c, sig] = assertion.split(".");
    expect(verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig ?? "", "base64url"))).toBe(
      true,
    );
    expect(JSON.parse(Buffer.from(c ?? "", "base64url").toString())).toMatchObject({
      iss: "push@relay-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
    expect(calls[1]?.url).toBe("https://fcm.googleapis.com/v1/projects/relay-test/messages:send");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      message: {
        token: fcmToken,
        data: { v: "1", enc: "x" },
        android: { priority: "high", ttl: "3600s", collapse_key: "p1" },
      },
    });

    // The access token is cached; a dead token comes back with FCM's error code.
    sendStatus = 404;
    expect(await sendToFcm(env, req, fakeFetch)).toEqual({ status: 404, reason: "UNREGISTERED" });
    expect(calls.filter((x) => x.url.includes("oauth2")).length).toBe(1);
    await expect(sendToFcm({}, req, fakeFetch)).rejects.toThrow("FCM is not configured");
    // A malformed secret: the error doesn't quote it (JSON.parse's message would).
    const bad = sendToFcm({ FCM_SERVICE_ACCOUNT: '{"private_key": "MIIEvQSECRETPART' }, req, fakeFetch);
    await expect(bad).rejects.toThrow("FCM service account is not valid JSON");
    await bad.catch((e: Error) => expect(e.message).not.toContain("SECRET"));
  });
});

describe("Android pushes the Notifier sends through the relay", () => {
  const androidToken = "fcm-token:APA91b_abcdefghijklmnop";
  const alert = {
    title: "secret-project asks",
    body: "Deploy to prod-db-7?",
    category: Category.permission,
    threadId: "s1",
    collapseId: "p1",
    data: { promptId: "p1", sessionId: "s1", kind: "question" },
  };

  const setup = (relayAnswers: (n: number) => number) => {
    const db = openDb(":memory:");
    const add = (id: string, token: string, pushKey: string | null) =>
      db
        .query(
          "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_platform, push_key) VALUES (?, ?, ?, 0, ?, 'production', 'fcm', ?)",
        )
        .run(id, id, `h-${id}`, token, pushKey);
    const posted: { platform: string; data: Record<string, string> }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body));
      posted.push({ platform: sent.platform, data: sent.payload.data });
      return Response.json({ status: relayAnswers(posted.length) });
    }) as unknown as typeof fetch;
    const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "relay-id-")), "identity.json"));
    const fcm = new RelayFcm("wss://relay.example.workers.dev", identity, fakeFetch);
    const notifier = new Notifier(db, {} as never, {} as never, {} as never, {} as never, { fcm });
    return { add, posted, notifier };
  };

  test("a phone without a push key gets the content-free alert", async () => {
    const { add, posted, notifier } = setup(() => 200);
    add("android-old", androidToken, null);
    expect(await notifier.pushAll(alert)).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.platform).toBe("fcm");
    expect(posted[0]?.data).toEqual({
      title: "Relay",
      body: "New activity on your Mac",
      category: Category.notice,
      threadId: "relay",
    });
  });

  for (const refused of [400, 413]) {
    test(`a sealed push the relay refuses with ${refused} is sent again without content`, async () => {
      const { add, posted, notifier } = setup((n) => (n === 1 ? refused : 200));
      add("android", androidToken, key);
      expect(await notifier.pushAll(alert)).toBe(1);
      expect(posted).toHaveLength(2);
      expect(Object.keys(posted[0]?.data ?? {})).toContain("enc");
      expect(posted[1]?.platform).toBe("fcm");
      expect(posted[1]?.data).toEqual({
        title: "Relay",
        body: "New activity on your Mac",
        category: Category.notice,
        threadId: "relay",
      });
      expect(JSON.stringify(posted[1])).not.toContain("prod-db-7");
    });
  }
});

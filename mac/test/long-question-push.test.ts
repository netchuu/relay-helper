import { describe, expect, test } from "bun:test";
import { parsePushRequest } from "../../cloud/src/push.ts";
import type { Prompt } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import {
  alertFor,
  MAX_SEALED_BYTES,
  Notifier,
  promptAlert,
  sealedApnsPayload,
  sealedFcmMessage,
} from "../src/daemon/notifier.ts";
import { TEST_PUSH_KEY as KEY, openSealed } from "./support/sealed.ts";

const question = (text: string, options = ["Yes", "No"], id = "s1"): Prompt => ({
  id: "p_1",
  sessionId: id,
  kind: "question",
  payload: {
    kind: "question",
    questions: [{ question: text, options: options.map((label) => ({ label })) }],
  },
  status: "open",
  resolvedBy: null,
  createdAt: 0,
  resolvedAt: null,
});

const FCM_TOKEN = "fcm-token:APA91b_abcdefghijklmnop";

/** What the Worker says to a sealed push of this alert, on both routes. */
function relayAccepts(alert: ReturnType<typeof promptAlert>) {
  const apns = parsePushRequest(
    JSON.stringify({
      token: "ab".repeat(32),
      environment: "production",
      payload: sealedApnsPayload(alert, KEY),
    }),
  );
  const fcm = parsePushRequest(
    JSON.stringify({ platform: "fcm", token: FCM_TOKEN, payload: sealedFcmMessage(alert, KEY) }),
  );
  return { apns, fcm };
}

describe("a long question still gets its notification", () => {
  for (const [label, text] of [
    ["ASCII", "Which approach? ".repeat(190)],
    ["Cyrillic", "Какой подход выбрать? ".repeat(70)],
    ["emoji", "🤔 ".repeat(1500)],
  ] as const) {
    test(`${label}: the relay accepts it on both routes`, () => {
      const alert = promptAlert(question(text), "web-shop");
      const { apns, fcm } = relayAccepts(alert);
      expect(typeof apns).toBe("object");
      expect(typeof fcm).toBe("object");
      const shown = openSealed((sealedApnsPayload(alert, KEY) as { relay: { enc: string } }).relay.enc).data;
      expect(typeof shown.question).toBe("string");
      expect(text.startsWith(String(shown.question).replace(/…$/, ""))).toBe(true);
      expect(shown.options).toEqual(["Yes", "No"]);
    });
  }

  test("whatever the name, question and options, the sealed text stays in budget", () => {
    const long = "ж".repeat(5000);
    const alert = promptAlert(question(long, [long, long, long, long], "s".repeat(128)), "й".repeat(3000));
    const { apns, fcm } = relayAccepts(alert);
    expect(typeof apns).toBe("object");
    expect(typeof fcm).toBe("object");
    const opened = openSealed((sealedApnsPayload(alert, KEY) as { relay: { enc: string } }).relay.enc);
    expect(Buffer.byteLength(JSON.stringify(opened), "utf8")).toBeLessThanOrEqual(MAX_SEALED_BYTES);
    // Whole characters only: no lone surrogate or replacement character.
    expect(JSON.stringify(opened)).not.toContain("�");
  });

  test("a cut never splits an emoji", () => {
    const alert = promptAlert(question("😀".repeat(2000)), "web-shop");
    const q = String(
      openSealed((sealedApnsPayload(alert, KEY) as { relay: { enc: string } }).relay.enc).data.question,
    );
    expect(q.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(q)).toBe(false);
  });

  test("a short question is sealed exactly as before", () => {
    const alert = promptAlert(question("Which DB?"), "web-shop");
    const opened = openSealed((sealedApnsPayload(alert, KEY) as { relay: { enc: string } }).relay.enc);
    expect(opened).toEqual({
      title: "web-shop asks",
      body: "Which DB?",
      data: {
        promptId: "p_1",
        sessionId: "s1",
        kind: "question",
        question: "Which DB?",
        options: ["Yes", "No"],
      },
    });
  });
});

describe("a push the relay still refuses", () => {
  test("is sent again as the generic alert, on both platforms", async () => {
    const db = openDb(":memory:");
    const devices: [string, string, string][] = [
      ["ios", "a".repeat(64), "apns"],
      ["android", FCM_TOKEN, "fcm"],
    ];
    for (const [id, token, platform] of devices)
      db.query(
        "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_platform, push_key) VALUES (?, ?, ?, 0, ?, 'production', ?, ?)",
      ).run(id, id, `h-${id}`, token, platform, KEY);
    const apnsSent: object[] = [];
    const fcmSent: object[] = [];
    const senders = {
      apns: {
        send: async (_t: string, _e: string, payload: object) => {
          apnsSent.push(payload);
          return apnsSent.length === 1 ? { status: 400, reason: "payload too large" } : { status: 200 };
        },
      },
      fcm: {
        send: async (_t: string, message: object) => {
          fcmSent.push(message);
          return fcmSent.length === 1 ? { status: 400, reason: "payload too large" } : { status: 200 };
        },
      },
    };
    const notifier = new Notifier(db, {} as never, {} as never, {} as never, {} as never, senders);
    const alert = alertFor(
      { seq: 1, ts: 0, type: "prompt.opened", prompt: question("Which DB?") },
      () => "secret-project",
    );
    if (!alert) throw new Error("no alert");
    expect(await notifier.pushAll(alert)).toBe(2);
    expect(apnsSent).toHaveLength(2);
    expect(fcmSent).toHaveLength(2);
    const retry = JSON.stringify([apnsSent[1], fcmSent[1]]);
    expect(retry).toContain("New activity on your Mac");
    for (const secret of ["secret-project", "Which DB?", "p_1"]) expect(retry).not.toContain(secret);
  });
});

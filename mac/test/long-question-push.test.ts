import { describe, expect, test } from "bun:test";
import { parsePushRequest } from "../../cloud/src/push.ts";
import type { Prompt } from "../../protocol/index.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
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

describe("a long question can be answered from its notification", () => {
  const open = (text: string) => {
    const db = openDb(":memory:");
    const broker = new Broker(db, new EventLog(db));
    const opened = broker.open({
      session_id: "s1",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: text, multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
        ],
      },
    } as never);
    return { broker, prompt: opened.prompt, reply: opened.reply };
  };
  const long = `Which database? ${"Details follow. ".repeat(200)}`;

  const pushed = (prompt: Prompt) =>
    openSealed((sealedApnsPayload(promptAlert(prompt, "relay"), KEY) as { relay: { enc: string } }).relay.enc)
      .data.question as string;

  for (const [label, value] of [
    ["a button", "Postgres"],
    ["typed Other text", "Use DuckDB instead"],
  ] as const) {
    test(`${label} under the pushed (cut) question is accepted and reaches Claude under the full one`, async () => {
      const { broker, prompt, reply } = open(long);
      const shown = pushed(prompt);
      expect(shown.length).toBeLessThan(long.length);
      const r = broker.answer(prompt.id, { kind: "question", answers: { [shown]: value } }, "device:a");
      expect(r.ok).toBe(true);
      const out = JSON.stringify(await reply);
      expect(out).toContain(JSON.stringify(long).slice(1, 60));
      expect(out).toContain(value);
    });
  }

  test("the full question as the key still works, and an unrelated key still fails", () => {
    const { broker, prompt, reply } = open(long);
    reply.catch(() => {});
    const bad = broker.answer(
      prompt.id,
      { kind: "question", answers: { "Something else": "x" } },
      "device:a",
    );
    expect(bad.ok).toBe(false);
    const ok = broker.answer(prompt.id, { kind: "question", answers: { [long]: "Postgres" } }, "device:a");
    expect(ok.ok).toBe(true);
  });
});

describe("a re-sent notification answer", () => {
  test("answered twice under the cut key, the second is ok; a different answer still conflicts", async () => {
    const db = openDb(":memory:");
    const broker = new Broker(db, new EventLog(db));
    const long = `Which database? ${"Details follow. ".repeat(200)}`;
    const opened = broker.open({
      session_id: "s1",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: long, multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
        ],
      },
    } as never);
    const shown = openSealed(
      (sealedApnsPayload(promptAlert(opened.prompt, "relay"), KEY) as { relay: { enc: string } }).relay.enc,
    ).data.question as string;
    const answer = (value: string) => ({ kind: "question" as const, answers: { [shown]: value } });
    expect(broker.answer(opened.prompt.id, answer("Postgres"), "device:a").ok).toBe(true);
    await opened.reply;
    expect(broker.answer(opened.prompt.id, answer("Postgres"), "device:a").ok).toBe(true);
    const other = broker.answer(opened.prompt.id, answer("SQLite"), "device:a");
    expect(other.ok).toBe(false);
    // The same answer under the full question is the same answer.
    const full = { kind: "question" as const, answers: { [long]: "Postgres" } };
    expect(broker.answer(opened.prompt.id, full, "device:a").ok).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type { Prompt, RelayEvent } from "../../protocol/index.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { alertFor, apnsPayload, Category, Notifier } from "../src/daemon/notifier.ts";
import { isDeadToken } from "../src/daemon/push.ts";
import { openSealed, TEST_PUSH_KEY as PUSH_KEY } from "./support/sealed.ts";
import { waitFor } from "./support/wait.ts";

const prompt = (payload: Prompt["payload"]): Prompt => ({
  id: "p_1",
  sessionId: "s1",
  kind: payload.kind,
  payload,
  status: "open",
  resolvedBy: null,
  createdAt: 0,
  resolvedAt: null,
});
const opened = (p: Prompt): RelayEvent => ({ seq: 1, ts: 0, type: "prompt.opened", prompt: p });
const name = () => "web-shop";
describe("notification content", () => {
  test("a simple question carries its options for the button extension", () => {
    const alert = alertFor(
      opened(
        prompt({
          kind: "question",
          questions: [{ question: "Which DB?", options: [{ label: "SQLite" }, { label: "Postgres" }] }],
        }),
      ),
      name,
    );
    expect(alert?.title).toBe("web-shop asks");
    expect(alert?.category).toBe(Category.question);
    expect(alert?.mutable).toBe(true);
    expect(alert?.data).toMatchObject({
      promptId: "p_1",
      question: "Which DB?",
      options: ["SQLite", "Postgres"],
    });
    const payload = apnsPayload(alert!) as { aps: Record<string, unknown> };
    expect(payload.aps["mutable-content"]).toBe(1);
    expect(payload.aps["thread-id"]).toBe("s1");
  });

  test("multi-select or several questions fall back to a text answer", () => {
    const alert = alertFor(
      opened(
        prompt({
          kind: "question",
          questions: [
            { question: "Pick any", options: [{ label: "A" }], multiSelect: true },
            { question: "And?", options: [{ label: "B" }] },
          ],
        }),
      ),
      name,
    );
    expect(alert?.body).toBe("Pick any (+1 more)");
    expect(alert?.mutable).toBe(false);
    expect(alert?.data.options).toBeUndefined();
  });

  test("permissions pick the category with Always Allow only when it is offered", () => {
    const perm = (canAlwaysAllow: boolean) =>
      alertFor(
        opened(
          prompt({ kind: "permission", toolName: "Bash", summary: "npm test", detail: "{}", canAlwaysAllow }),
        ),
        name,
      );
    expect(perm(true)?.category).toBe(Category.permissionAlways);
    expect(perm(false)?.category).toBe(Category.permission);
    expect(perm(false)?.title).toBe("web-shop wants to run Bash");
  });

  test("plans count their steps; finished turns use the first line", () => {
    const plan = alertFor(
      opened(prompt({ kind: "plan", plan: "## Add checkout\n1. a\n2. b\n- c", planFilePath: null })),
      name,
    );
    expect(plan?.body).toBe("Add checkout · 3 steps");
    const done = alertFor(
      {
        seq: 2,
        ts: 0,
        type: "turn.done",
        turn: {
          id: "t",
          sessionId: "s1",
          prompt: null,
          summary: "**Fixed** the bug.\n\nMore text",
          fullLength: 30,
          truncated: false,
          stats: { durationMs: null, toolCalls: 0, filesEdited: [] },
          failed: false,
          startedAt: null,
          endedAt: 0,
        },
      },
      name,
    );
    expect(done).toMatchObject({
      title: "web-shop is done",
      body: "Fixed the bug.",
      category: Category.done,
    });
  });

  test("info notices and other events are not pushed", () => {
    expect(
      alertFor({ seq: 1, ts: 0, type: "session.notice", sessionId: "s", level: "info", text: "x" }, name),
    ).toBeNull();
    expect(alertFor({ seq: 1, ts: 0, type: "session.removed", sessionId: "s" }, name)).toBeNull();
  });
});

test("dead APNs tokens are recognised", () => {
  expect(isDeadToken({ status: 410, reason: "Unregistered" })).toBe(true);
  expect(isDeadToken({ status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(isDeadToken({ status: 429, reason: "TooManyRequests" })).toBe(false);
});

describe("phones without a push key", () => {
  test("get only a content-free alert: no title, body, question or options, on either platform", async () => {
    const db = openDb(":memory:");
    const add = (id: string, token: string, platform: string, key: string | null) =>
      db
        .query(
          "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_platform, push_key) VALUES (?, ?, ?, 0, ?, 'production', ?, ?)",
        )
        .run(id, id, `h-${id}`, token, platform, key);
    add("ios-old", "a".repeat(64), "apns", null);
    add("ios-new", "b".repeat(64), "apns", PUSH_KEY);
    add("android-old", "fcm-token:APA91b_abcdefghijklmnop", "fcm", null);
    const apnsSent: { token: string; payload: object; collapseId?: string }[] = [];
    const fcmSent: object[] = [];
    const senders = {
      apns: {
        send: async (token: string, _e: string, payload: object, opts: { collapseId?: string }) => {
          apnsSent.push({ token, payload, collapseId: opts.collapseId });
          return { status: 200 };
        },
      },
      fcm: {
        send: async (_t: string, message: object) => {
          fcmSent.push(message);
          return { status: 200 };
        },
      },
    };
    const notifier = new Notifier(db, {} as never, {} as never, {} as never, {} as never, senders);
    const alert = alertFor(
      opened(
        prompt({
          kind: "question",
          questions: [
            { question: "Deploy to prod-db-7?", options: [{ label: "Yes, wipe it" }, { label: "No" }] },
          ],
        }),
      ),
      () => "secret-project",
    );
    if (!alert) throw new Error("no alert for a question");
    expect(await notifier.pushAll(alert)).toBe(3);

    const old = apnsSent.find((s) => s.token === "a".repeat(64));
    const plain = JSON.stringify([old, fcmSent]);
    for (const secret of ["secret-project", "prod-db-7", "wipe it", "p_1", "s1"])
      expect(plain).not.toContain(secret);
    expect(old?.payload).toEqual({
      aps: {
        alert: { title: "Relay", body: "New activity on your Mac" },
        sound: "default",
        category: Category.notice,
        "thread-id": "relay",
      },
      relay: {},
    });
    expect(old?.collapseId).toBe("relay-activity");
    expect((fcmSent[0] as { data: Record<string, string> }).data).toEqual({
      title: "Relay",
      body: "New activity on your Mac",
      category: Category.notice,
      threadId: "relay",
    });

    // A phone with a key still gets the whole question, sealed.
    const sealed = apnsSent.find((s) => s.token === "b".repeat(64));
    expect(JSON.stringify(sealed)).not.toContain("prod-db-7");
    const enc = (sealed?.payload as { relay?: { enc?: string } } | undefined)?.relay?.enc ?? "";
    expect(openSealed(enc)).toMatchObject({
      title: "secret-project asks",
      data: { question: "Deploy to prod-db-7?", options: ["Yes, wipe it", "No"] },
    });
    expect(sealed?.collapseId).toBe("p_1");
  });
});

describe("waiting reminders", () => {
  const setup = () => {
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_key) VALUES ('ios', 'iPhone', 'h', 0, ?, 'sandbox', ?)",
    ).run("a".repeat(64), PUSH_KEY);
    const events = new EventLog(db);
    const broker = new Broker(db, events);
    let present = true;
    const presence = { get: () => ({ mode: "auto", present, idleSeconds: 0, locked: false }) };
    const registry = { get: (id: string) => ({ name: id === "s1" ? "aalam-3d" : "mashrapova-48" }) };
    const sent: { title: string; collapseId?: string }[] = [];
    const apns = {
      send: async (_t: string, _e: string, payload: object, opts: { collapseId?: string }) => {
        const { title } = openSealed((payload as { relay: { enc: string } }).relay.enc);
        sent.push({ title, collapseId: opts.collapseId });
        return { status: 200 };
      },
    };
    const notifier = new Notifier(db, events, presence as never, registry as never, broker, {
      apns,
    } as never);
    notifier.start();
    const setPresent = async (p: boolean) => {
      present = p;
      events.emit({ type: "presence.changed", presence: presence.get() } as never);
      await Bun.sleep(20);
    };
    const ask = (sessionId: string, command: string) =>
      broker.open({ session_id: sessionId, tool_name: "Bash", tool_input: { command } }).prompt;
    return { broker, sent, setPresent, ask };
  };

  test("stepping away again doesn't repeat the same prompts", async () => {
    const { sent, setPresent, ask } = setup();
    ask("s1", "ls");
    ask("s2", "pwd");
    await setPresent(false);
    expect(sent).toEqual([{ title: "2 things are waiting for you", collapseId: "relay-waiting" }]);
    // Back at the Mac and away again, many times, with the same two still open: no more pushes.
    for (let i = 0; i < 3; i++) {
      await setPresent(true);
      await setPresent(false);
    }
    expect(sent).toHaveLength(1);
    // A new prompt while you were at the Mac: one new reminder covering all three.
    await setPresent(true);
    ask("s1", "whoami");
    await setPresent(false);
    expect(sent.map((s) => s.title)).toEqual([
      "2 things are waiting for you",
      "3 things are waiting for you",
    ]);
  });

  test("prompts already pushed while away aren't reminded; closed ones are forgotten", async () => {
    const { broker, sent, setPresent, ask } = setup();
    await setPresent(false);
    const p = ask("s1", "ls");
    await waitFor(() => sent.length >= 1, 30_000, "the push for the prompt");
    expect(sent.map((s) => s.title)).toEqual(["aalam-3d wants to run Bash"]);
    await setPresent(true);
    await setPresent(false);
    expect(sent).toHaveLength(1);
    broker.close(p.id, "mac");
    await setPresent(true);
    await setPresent(false);
    expect(sent).toHaveLength(1);
  });
});

describe("a push that reached no phone", () => {
  const setup = (first: { status: number; reason?: string }) => {
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_key) VALUES ('ios', 'iPhone', 'h', 0, ?, 'sandbox', ?)",
    ).run("a".repeat(64), PUSH_KEY);
    const events = new EventLog(db);
    const broker = new Broker(db, events);
    let present = true;
    const presence = { get: () => ({ mode: "auto", present, idleSeconds: 0, locked: false }) };
    const registry = { get: () => ({ name: "aalam-3d" }) };
    const calls: number[] = [];
    const apns = {
      send: async () => {
        const result = calls.length === 0 ? first : { status: 200 };
        calls.push(result.status);
        return result;
      },
    };
    const notifier = new Notifier(db, events, presence as never, registry as never, broker, {
      apns,
    } as never);
    notifier.start();
    const setPresent = async (p: boolean) => {
      present = p;
      events.emit({ type: "presence.changed", presence: presence.get() } as never);
      await Bun.sleep(20);
    };
    const ask = (command: string) =>
      broker.open({ session_id: "s1", tool_name: "Bash", tool_input: { command } }).prompt;
    return { calls, setPresent, ask };
  };

  for (const failure of [
    { status: 0, reason: "timed out" },
    { status: 429, reason: "too many pushes to this device" },
    { status: 503, reason: "push failed" },
  ]) {
    test(`a prompt whose push failed with ${failure.status} is pushed when you step away again`, async () => {
      const { calls, setPresent, ask } = setup(failure);
      await setPresent(false);
      ask("ls");
      await waitFor(() => calls.length >= 1, 30_000, "the first push");
      await setPresent(true);
      await setPresent(false);
      expect(calls).toEqual([failure.status, 200]);
      // That one reached the phone: stepping away again repeats nothing.
      await setPresent(true);
      await setPresent(false);
      expect(calls).toHaveLength(2);
    });
  }

  test("a reminder that failed is sent again the next time you step away", async () => {
    const { calls, setPresent, ask } = setup({ status: 0, reason: "timed out" });
    ask("ls");
    await setPresent(false);
    expect(calls).toEqual([0]);
    await setPresent(true);
    await setPresent(false);
    expect(calls).toEqual([0, 200]);
    await setPresent(true);
    await setPresent(false);
    expect(calls).toHaveLength(2);
  });
});

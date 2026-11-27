import { afterEach, expect, test } from "bun:test";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { atMacOfSession, DialogWatcher } from "../src/daemon/dialogWatch.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { resetLiveSteps } from "../src/daemon/steps.ts";
import { relayHooks } from "../src/install.ts";

let dialogs: DialogWatcher | undefined;
afterEach(() => {
  dialogs?.clear("s1");
  resetLiveSteps();
});

function setup(present = false) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  dialogs = new DialogWatcher({ registry, events });
  const presence = { noteLocalActivity() {}, get: () => ({ present }) } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, dialogs });
  const ask = (fields: Record<string, unknown>, signal = new AbortController().signal) =>
    hooks.handle(
      {
        payload: {
          hook_event_name: "Elicitation",
          session_id: "s1",
          cwd: "/work",
          mcp_server_name: "deploy-server",
          mode: "form",
          ...fields,
        },
        env: {},
      },
      signal,
    );
  return { broker, ask };
}

const enumForm = {
  message: "Which environment?",
  requested_schema: {
    type: "object",
    properties: { env: { type: "string", enum: ["staging", "production"] } },
  },
};

test("the Elicitation hook is installed as blocking", () => {
  const group = relayHooks("/bin/relay-hook").Elicitation?.[0]?.hooks[0];
  expect(group?.timeout).toBe(86_400);
  expect(group?.async).toBeUndefined();
});

test("an enum form opens as a question and the pick is accepted", async () => {
  const t = setup();
  const reply = t.ask(enumForm);
  const open = t.broker.listOpen("s1");
  expect(open).toHaveLength(1);
  const payload = open[0]?.payload;
  if (payload?.kind !== "question") throw new Error("not a question");
  expect(payload.questions[0]?.header).toBe("deploy-server");
  expect(payload.questions[0]?.question).toBe("Which environment?");
  expect(payload.questions[0]?.options?.map((o) => o.label)).toEqual(["staging", "production", "Decline"]);
  const res = t.broker.answer(
    open[0]?.id as string,
    { kind: "question", answers: { "Which environment?": "production" } },
    "device:a",
  );
  expect(res).toEqual({ ok: true });
  expect(JSON.parse((await reply).stdout)).toEqual({
    hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { env: "production" } },
  });
});

test("a boolean form answers with a boolean", async () => {
  const t = setup();
  const reply = t.ask({
    message: "Overwrite the file?",
    requested_schema: { type: "object", properties: { overwrite: { type: "boolean" } } },
  });
  t.broker.answer(
    t.broker.listOpen("s1")[0]?.id as string,
    { kind: "question", answers: { "Overwrite the file?": "No" } },
    "device:a",
  );
  expect(JSON.parse((await reply).stdout).hookSpecificOutput.content).toEqual({ overwrite: false });
});

test("Decline, and the phone's Stop, answer decline", async () => {
  const t = setup();
  const first = t.ask(enumForm);
  t.broker.answer(
    t.broker.listOpen("s1")[0]?.id as string,
    { kind: "question", answers: { "Which environment?": "Decline" } },
    "device:a",
  );
  expect(JSON.parse((await first).stdout).hookSpecificOutput).toEqual({
    hookEventName: "Elicitation",
    action: "decline",
  });
  const second = t.ask(enumForm);
  t.broker.stop("s1", "device:a");
  expect(JSON.parse((await second).stdout).hookSpecificOutput.action).toBe("decline");
});

test("an answer the form doesn't offer is refused", () => {
  const t = setup();
  void t.ask(enumForm);
  const res = t.broker.answer(
    t.broker.listOpen("s1")[0]?.id as string,
    { kind: "question", answers: { "Which environment?": "mars" } },
    "device:a",
  );
  expect(res.ok).toBe(false);
});

test("a killed hook closes the question and prints nothing", async () => {
  const t = setup();
  const abort = new AbortController();
  const reply = t.ask(enumForm, abort.signal);
  abort.abort();
  expect((await reply).stdout).toBe("");
  expect(t.broker.listOpen("s1")).toHaveLength(0);
});

test("at the Mac, an enum form prints nothing so the terminal shows its dialog", async () => {
  const t = setup(true);
  expect((await t.ask(enumForm)).stdout).toBe("");
  expect(t.broker.listOpen("s1")).toHaveLength(0);
});

test("other forms and URL mode print nothing and wait at the Mac", async () => {
  const t = setup();
  const two = await t.ask({
    message: "Sign in",
    requested_schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
  });
  expect(two.stdout).toBe("");
  expect(t.broker.listOpen("s1")).toHaveLength(0);
  expect(atMacOfSession("s1")?.kind).toBe("elicitation_dialog");

  const url = await t.ask({ mode: "url", message: "Please authenticate", url: "https://a.example/login" });
  expect(url.stdout).toBe("");
  expect(atMacOfSession("s1")?.kind).toBe("elicitation_url_dialog");
});

test("a free text field is left to the terminal", async () => {
  const t = setup();
  const res = await t.ask({
    message: "Name?",
    requested_schema: { type: "object", properties: { name: { type: "string" } } },
  });
  expect(res.stdout).toBe("");
  expect(t.broker.listOpen("s1")).toHaveLength(0);
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DialogResult,
  HelloParams,
  Prompt,
  RelayEvent,
  RpcSchemas,
  SendResult,
  Session,
  SessionCommands,
  Turn,
} from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

const load = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../protocol/fixtures", name), "utf8"));

describe("command turns", () => {
  const f = load("command-turns.json");

  test("a command turn keeps its name and arguments", () => {
    expect(Turn.parse(f.context).command).toEqual({ name: "context" });
    expect(Turn.parse(f.color).command).toEqual({ name: "color", args: "blue" });
  });

  test("a command with no name is refused", () => {
    expect(Turn.safeParse({ ...f.context, command: { args: "x" } }).success).toBe(false);
  });

  test("the turn without a command is an ordinary turn", () => {
    expect(Turn.parse(f.withoutCommand).command).toBeUndefined();
  });

  test("the started event carries the sendId and the events parse in order", () => {
    expect(RelayEvent.parse(f.contextStarted)).toMatchObject({
      type: "turn.started",
      sendId: expect.any(String),
    });
    const [done, ended] = f.exitThenEnded.map((e: unknown) => RelayEvent.parse(e));
    expect(done.type).toBe("turn.done");
    expect(ended).toMatchObject({ type: "session.upsert", session: { status: "ended", endReason: "exit" } });
  });
});

describe("session endings", () => {
  const f = load("session-ends.json");

  test("every reason parses, an unknown one too", () => {
    for (const k of ["exit", "clear", "resume", "logout", "closed", "untrusted", "stopped", "other"])
      expect(Session.parse(f[k]).endReason).toBe(k);
    expect(Session.parse(f.unknownReason).endReason).toBe("quota");
    expect(Session.parse(f.noReason).endReason).toBeUndefined();
  });

  test("a cleared session and its successor point at each other", () => {
    expect(Session.parse(f.clear).replacedBy).toBe(Session.parse(f.clearedInto).id);
    expect(Session.parse(f.clearedInto).replaces).toBe(Session.parse(f.clear).id);
  });
});

describe("dialogs", () => {
  const f = load("dialogs.json");

  test("a dialog question names its kind and title; a plain question has none", () => {
    expect(Prompt.parse(f.trust).dialog).toEqual({ kind: "trust", title: "Trust this folder?" });
    expect(Prompt.parse(f.unknownKind).dialog?.kind).toBe("newKind");
    expect(Prompt.parse({ ...f.trust, dialog: undefined }).dialog).toBeUndefined();
    expect(Prompt.safeParse({ ...f.trust, dialog: { kind: "trust" } }).success).toBe(false);
  });

  test("a session waiting at the computer carries the dialog", () => {
    expect(Session.parse(f.sessionAtMac).atMac).toEqual({
      id: "d_7f3a",
      kind: "other",
      title: "Choose a theme",
      canClose: true,
    });
    expect(Session.parse(f.noDialog).atMac).toBeUndefined();
    expect(Session.safeParse({ ...f.sessionAtMac, atMac: { id: "d" } }).success).toBe(false);
  });

  test("session.dialog takes close only", () => {
    expect(RpcSchemas["session.dialog"].parse(f.closeParams).action).toBe("close");
    expect(RpcSchemas["session.dialog"].safeParse({ ...f.closeParams, action: "open" }).success).toBe(false);
    expect(RpcSchemas["session.dialog"].safeParse({ sessionId: "s" }).success).toBe(false);
    expect(DialogResult.parse(f.closeResult)).toEqual({ ok: true });
  });

  test("hello says whether the phone knows dialogs", () => {
    expect(HelloParams.parse(f.hello).dialogs).toBe(true);
    expect(HelloParams.parse(f.helloOlder).dialogs).toBeUndefined();
  });

  test("an unknown session and a closed dialog get plain errors", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const rpc = createRpc({ db, events, registry, broker: { listOpen: () => [] } } as unknown as RpcDeps);
    registry.touch("s1", { cwd: "/tmp/x", name: "x" });
    const gone = await rpc(
      "session.dialog",
      { sessionId: "nope", dialogId: "d", action: "close" },
      "device:a",
    );
    expect(gone).toEqual({ error: { code: "not_found", message: "session not found" } });
    const closed = await rpc(
      "session.dialog",
      { sessionId: "s1", dialogId: "d", action: "close" },
      "device:a",
    );
    expect(closed).toEqual({
      error: { code: "conflict", message: "That question is no longer open on your computer." },
    });
  });
});

describe("sends and the command list", () => {
  const sends = load("sends.json");
  const commands = load("commands.json");

  test("the dialog reason and the outcome events parse", () => {
    expect(SendResult.parse(sends.resultQueuedDialog).reason).toBe("dialog");
    expect(RelayEvent.parse(sends.waitingDialogEvent)).toMatchObject({ reason: "dialog" });
    const [blocked, lost] = sends.outcomeEvents.map((e: unknown) => RelayEvent.parse(e));
    expect(blocked).toMatchObject({ type: "reply.outcome", outcome: "blocked" });
    expect(lost).toMatchObject({ outcome: "lost" });
    expect(RelayEvent.safeParse({ ...sends.outcomeEvents[0], outcome: "gone" }).success).toBe(false);
  });

  test("withMenus is optional and adds opens and phone", () => {
    expect(RpcSchemas["session.commands"].parse({ sessionId: "s" })).toEqual({ sessionId: "s" });
    expect(RpcSchemas["session.commands"].parse(commands.paramsWithMenus).withMenus).toBe(true);
    const list = SessionCommands.parse(commands.resultWithMenus).commands;
    expect(list.every((c) => c.opens)).toBe(true);
    expect(list.find((c) => c.name === "model")).toMatchObject({ opens: "menu", phone: "model" });
    expect(list.find((c) => c.name === "exit")?.opens).toBe("ends");
    expect(list.find((c) => c.name === "clear")?.opens).toBe("replaces");
    for (const c of SessionCommands.parse(commands.result).commands) expect(c.opens).toBeUndefined();
  });
});

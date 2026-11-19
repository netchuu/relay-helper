import { describe, expect, test } from "bun:test";
import { Prompt, RELAY_FRAME_BYTES, RpcSchemas, SyncResult } from "../../protocol/index.ts";
import { createPairingCode, resetPairingAttempts } from "../src/daemon/auth.ts";
import { Broker } from "../src/daemon/broker.ts";
import { ClientSession } from "../src/daemon/clientSession.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

// A big snapshot or history must still reach the phone: long texts in prompts are cut and marked.

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = { get: () => ({ mode: "auto", present: true, locked: false, idleSeconds: 0 }) };
  const rpc = createRpc({ db, events, registry, broker, presence, config: {} } as unknown as RpcDeps);
  return { db, events, broker, rpc };
}

/** Paired sessions by test: pairing is limited to 10 a minute for the whole process, so each test pairs once. */
const paired = new WeakMap<object, { session: ClientSession; sent: string[]; next: number }>();

/** Sends one call through a paired ClientSession and returns the frame that went out. */
async function call(s: ReturnType<typeof setup>, method: string, params: unknown) {
  let p = paired.get(s);
  if (!p) {
    const sent: string[] = [];
    const session = new ClientSession(
      (t) => sent.push(t),
      { rpc: s.rpc, events: s.events, db: s.db },
      () => {},
    );
    resetPairingAttempts(); // the limit is shared by the whole test process
    const { code } = createPairingCode(s.db);
    await session.handle(JSON.stringify({ id: 1, method: "pair", params: { code, deviceName: "P" } }));
    p = { session, sent, next: 2 };
    paired.set(s, p);
  }
  const id = p.next++;
  p.sent.length = 0;
  await p.session.handle(JSON.stringify({ id, method, params }));
  const frame = p.sent.find((t) => (JSON.parse(t) as { id?: number }).id === id) ?? "";
  expect(Buffer.byteLength(frame)).toBeLessThan(RELAY_FRAME_BYTES);
  return JSON.parse(frame) as { result?: unknown; error?: { message: string } };
}

const write = (n: number, chars: number, ch = "a") => ({
  session_id: `s${n}`,
  tool_name: "Write",
  tool_input: { file_path: `/tmp/f${n}`, content: ch.repeat(chars) },
});

describe("a big snapshot or history", () => {
  test("sync with 13 open Write prompts of 30 KB returns a snapshot with cut details", async () => {
    const s = setup();
    for (let i = 0; i < 13; i++) s.broker.open(write(i, 30_000));
    const out = await call(s, "sync", { sinceSeq: 0 });
    expect(out.error).toBeUndefined();
    const snap = SyncResult.parse(out.result).snapshot;
    expect(snap?.prompts).toHaveLength(13);
    for (const p of snap?.prompts ?? []) {
      expect(p.truncated).toBe(true);
      expect(p.payload.kind === "permission" && p.payload.detail).toContain("more characters)");
    }
  });

  test("Cyrillic text, which is bigger on the wire, fits too", async () => {
    const s = setup();
    for (let i = 0; i < 7; i++) s.broker.open(write(i, 60_000, "ж"));
    const out = await call(s, "sync", { sinceSeq: 0 });
    expect(out.error).toBeUndefined();
    expect(SyncResult.parse(out.result).snapshot?.prompts).toHaveLength(7);
  });

  test("sync with one 300 KB plan returns a snapshot with the plan cut", async () => {
    const s = setup();
    s.broker.open({ session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan: "p".repeat(300_000) } });
    const out = await call(s, "sync", { sinceSeq: 0 });
    expect(out.error).toBeUndefined();
    const [p] = SyncResult.parse(out.result).snapshot?.prompts ?? [];
    expect(p?.truncated).toBe(true);
    expect(p?.payload.kind === "plan" && p.payload.plan.startsWith("ppp")).toBe(true);
  });

  test("sync with one 300 KB Bash command returns a snapshot with the summary cut", async () => {
    const s = setup();
    s.broker.open({ session_id: "s1", tool_name: "Bash", tool_input: { command: "echo ".repeat(60_000) } });
    const out = await call(s, "sync", { sinceSeq: 0 });
    expect(out.error).toBeUndefined();
    const [p] = SyncResult.parse(out.result).snapshot?.prompts ?? [];
    expect(p?.truncated).toBe(true);
  });

  test("prompts.open and prompts.recent with 50 prompts of 5 KB return results", async () => {
    const s = setup();
    for (let i = 0; i < 50; i++) {
      // A long command and its long detail: about 250 KB all told.
      const { prompt } = s.broker.open({
        session_id: `s${i}`,
        tool_name: "Bash",
        tool_input: { command: "x".repeat(2_500) },
      });
      void prompt;
    }
    for (const method of ["prompts.open"] as const) {
      const out = await call(s, method, RpcSchemas[method].parse({}));
      expect(out.error).toBeUndefined();
      expect((out.result as unknown[]).length).toBe(50);
    }
    for (const p of s.broker.listOpen()) s.broker.answer(p.id, { kind: "permission", action: "allow" }, "p");
    const out = await call(s, "prompts.recent", RpcSchemas["prompts.recent"].parse({ limit: 50 }));
    expect(out.error).toBeUndefined();
    const list = (out.result as unknown[]).map((p) => Prompt.parse(p));
    expect(list).toHaveLength(50);
  });

  test("the direct path returns a 300 KB plan whole, with no truncated", async () => {
    const s = setup();
    s.broker.open({ session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan: "p".repeat(300_000) } });
    const sync = await s.rpc("sync", { sinceSeq: 0 }, "direct");
    const [p] = SyncResult.parse((sync as { result: unknown }).result).snapshot?.prompts ?? [];
    expect(p?.payload.kind === "plan" && p.payload.plan.length).toBe(300_000);
    expect("truncated" in (p ?? {})).toBe(false);
    for (const method of ["prompts.open", "prompts.recent"] as const) {
      const out = await s.rpc(method, method === "prompts.recent" ? { limit: 5 } : {}, "direct");
      const list = (out as { result: Prompt[] }).result;
      for (const q of list) expect("truncated" in q).toBe(false);
    }
    const open = await s.rpc("prompts.open", {}, "direct");
    expect(JSON.stringify((open as { result: unknown }).result).length).toBeGreaterThan(300_000);
  });

  test("a question from an over-budget reply can be answered under the text shown", async () => {
    const s = setup();
    for (let i = 0; i < 120; i++) s.broker.open(write(i, 3_000));
    const question = "q".repeat(1_231);
    const label = "L".repeat(900);
    s.broker.open({
      session_id: "sq",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question, options: [{ label, description: "d".repeat(2_000) }, { label: "B" }] }],
      },
    });
    const out = await call(s, "prompts.open", {});
    const list = (out.result as Prompt[]).map((p) => Prompt.parse(p));
    expect(list.some((p) => p.truncated)).toBe(true);
    const asked = list.find((p) => p.payload.kind === "question");
    if (asked?.payload.kind !== "question") throw new Error("question dropped");
    const [q] = asked.payload.questions;
    expect(q?.question).toBe(question);
    expect(q?.options[0]?.label).toBe(label);
    const res = s.broker.answer(
      asked.id,
      { kind: "question", answers: { [q?.question ?? ""]: q?.options[0]?.label ?? "" } },
      "p",
    );
    expect(res).toEqual({ ok: true });
  });

  test("when open prompts are dropped, the newest stay", async () => {
    const s = setup();
    for (let i = 0; i < 600; i++) s.broker.open(write(i, 2_000));
    const newest = s.broker.listOpen().at(-1)?.id;
    for (const out of [await call(s, "prompts.open", {}), await call(s, "sync", { sinceSeq: 0 })]) {
      const prompts =
        "snapshot" in (out.result as object)
          ? (SyncResult.parse(out.result).snapshot?.prompts ?? [])
          : (out.result as Prompt[]);
      expect(prompts.length).toBeLessThan(600);
      expect(prompts.at(-1)?.id).toBe(newest);
    }
  });

  test("small prompts are sent whole, with no truncated field", async () => {
    const s = setup();
    s.broker.open(write(1, 100));
    const out = await call(s, "prompts.open", {});
    const [p] = out.result as Record<string, unknown>[];
    expect(p).toBeDefined();
    expect("truncated" in (p ?? {})).toBe(false);
  });
});

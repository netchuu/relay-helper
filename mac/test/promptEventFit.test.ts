import { expect, test } from "bun:test";
import { RELAY_FRAME_BYTES } from "../../protocol/index.ts";
import { createPairingCode, redeemPairingCode } from "../src/daemon/auth.ts";
import { Broker } from "../src/daemon/broker.ts";
import { ClientSession } from "../src/daemon/clientSession.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

type Frame = { type?: string; id?: number; event?: any; result?: any; error?: any };

async function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const presence = { get: () => ({ mode: "auto", present: true, locked: false, idleSeconds: 0 }) };
  const rpc = createRpc({ db, events, registry, broker, presence, config: {} } as unknown as RpcDeps);
  const sent: string[] = [];
  const session = new ClientSession(
    (t) => sent.push(t),
    { rpc, events, db },
    () => {},
  );
  const { code } = createPairingCode(db);
  // hello, not pair: pairing attempts are rate limited for the whole test process.
  const { token } = redeemPairingCode(db, code, "P") as { token: string };
  await session.handle(JSON.stringify({ id: 1, method: "hello", params: { token } }));
  let next = 2;
  const call = async (method: string, params: unknown) => {
    const id = next++;
    await session.handle(JSON.stringify({ id, method, params }));
    return sent.map((t) => JSON.parse(t) as Frame).find((f) => f.id === id) as Frame;
  };
  const eventFrames = () => sent.map((t) => JSON.parse(t) as Frame).filter((f) => f.type === "event");
  return { broker, events, rpc, sent, call, eventFrames };
}

const cases = [
  ["300 KB plan", { tool_name: "ExitPlanMode", tool_input: { plan: "p".repeat(300_000) } }, true],
  ["300 KB Bash command", { tool_name: "Bash", tool_input: { command: "echo ".repeat(60_000) } }, true],
  [
    "130,000 Cyrillic characters plan",
    { tool_name: "ExitPlanMode", tool_input: { plan: "ж".repeat(130_000) } },
    true,
  ],
] as const;

for (const [name, input] of cases) {
  test(`a ${name} opened while the phone is connected reaches it live and by sync, cut`, async () => {
    const s = await setup();
    s.broker.open({ session_id: "s0", tool_name: "Bash", tool_input: { command: "ls" } });
    const first = await s.call("sync", { sinceSeq: 0 });
    const since = first.result.latestSeq as number;
    s.sent.length = 0;

    const { prompt } = s.broker.open({ session_id: "s1", ...input });
    const live = s.eventFrames().filter((f) => f.event?.type === "prompt.opened");
    expect(live.length).toBe(1);
    expect(live[0]?.event.prompt.truncated).toBe(true);
    for (const t of s.sent) expect(Buffer.byteLength(t)).toBeLessThan(RELAY_FRAME_BYTES);

    const out = await s.call("sync", { sinceSeq: since });
    const synced = out.result.events.filter(
      (e: any) => e.type === "prompt.opened" && e.prompt.id === prompt.id,
    );
    expect(synced.length).toBe(1);
    expect(synced[0].prompt.truncated).toBe(true);
    expect(out.result.latestSeq).toBeGreaterThan(since);
    for (const t of s.sent) expect(Buffer.byteLength(t)).toBeLessThan(RELAY_FRAME_BYTES);

    // The direct connection still gets the prompt whole.
    const direct = await s.rpc("prompts.open", {}, "device:x", { overRelay: false });
    const whole = (direct as any).result.find((p: any) => p.id === prompt.id);
    expect(whole.truncated).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(whole))).toBeGreaterThan(250_000);
    expect(s.events.sinceForSync(since).find((e: any) => e.type === "prompt.opened")).toMatchObject({
      prompt: { id: prompt.id },
    });
  });
}

test("a big prompt opened while the phone is offline comes back in the catch-up sync", async () => {
  const s = await setup();
  s.broker.open({ session_id: "s0", tool_name: "Bash", tool_input: { command: "ls" } });
  const first = await s.call("sync", { sinceSeq: 0 });
  const since = first.result.latestSeq as number;
  s.broker.open({ session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan: "ж".repeat(130_000) } });
  const out = await s.call("sync", { sinceSeq: since });
  expect(out.result.events.filter((e: any) => e.type === "prompt.opened").length).toBe(1);
});

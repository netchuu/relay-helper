import { expect, test } from "bun:test";
import { startAppServer } from "../src/daemon/api.ts";
import { createPairingCode, redeemPairingCode } from "../src/daemon/auth.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { waitFor } from "./support/wait.ts";

// Method names every JavaScript object inherits are unknown methods, not crashes; a throw while handling one
// message on the direct connection answers that call and leaves the helper running.

const INHERITED = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];

test("inherited object names answer bad_request unknown method", async () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const rpc = createRpc({ db, events, registry, broker } as unknown as RpcDeps);
  for (const name of INHERITED) {
    const out = await rpc(name, {}, "device:d1");
    expect(out).toEqual({ error: { code: "bad_request", message: `unknown method ${name}` } });
  }
});

test("a handler that throws answers that call and the connection keeps working", async () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const port = 20000 + (process.pid % 20000) + 1;
  const server = startAppServer({
    port,
    db,
    events,
    rpc: async (method) => {
      if (method === "boom") throw new Error("secret detail");
      return { result: { ok: true } };
    },
  });
  try {
    const { code } = createPairingCode(db);
    const paired = redeemPairingCode(db, code, "Test iPhone");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: `Bearer ${paired?.token}` },
    } as never);
    const replies: { id: number | null; error?: { code: string; message: string }; result?: unknown }[] = [];
    ws.onmessage = (m) => replies.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ id: 1, method: "boom", params: {} }));
    ws.send(JSON.stringify({ id: 2, method: "fine", params: {} }));
    await waitFor(
      () => replies.some((r) => r.id === 1) && replies.some((r) => r.id === 2),
      30_000,
      "both replies",
      () => JSON.stringify(replies),
    );
    const boom = replies.find((r) => r.id === 1);
    expect(boom?.error).toEqual({ code: "internal", message: "internal error" });
    expect(replies.find((r) => r.id === 2)?.result).toEqual({ ok: true });
    ws.close();
  } finally {
    server.stop(true);
  }
});

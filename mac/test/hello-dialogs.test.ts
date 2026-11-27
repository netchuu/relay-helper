import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPairingCode, redeemPairingCode } from "../src/daemon/auth.ts";
import { ClientSession } from "../src/daemon/clientSession.ts";
import { openDb } from "../src/daemon/db.ts";
import { open, seal } from "../src/daemon/e2e.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

async function hello(params: (token: string) => Record<string, unknown>) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const rpc = createRpc({
    db,
    events,
    registry: new Registry(db, events),
    broker: { hasOpen: () => false, listOpen: () => [], listRecent: () => [] },
    config: {},
    presence: { get: () => ({ mode: "away" }) },
  } as unknown as RpcDeps);
  const session = new ClientSession(
    () => {},
    { rpc, events, db },
    () => {},
  );
  const token = redeemPairingCode(db, createPairingCode(db).code, "P")?.token ?? "";
  await session.handle(JSON.stringify({ id: 2, method: "hello", params: params(token) }));
  return session;
}

describe("hello and dialogs", () => {
  test("a phone that says dialogs: true is remembered as knowing them", async () => {
    expect((await hello((token) => ({ token, dialogs: true }))).dialogs).toBe(true);
  });

  test("an older phone, or a non-boolean value, is not", async () => {
    expect((await hello((token) => ({ token }))).dialogs).toBe(false);
    expect((await hello((token) => ({ token, dialogs: "yes" }))).dialogs).toBe(false);
  });

  test("the fixture's phone frame opens to a hello that announces dialogs", () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "../../protocol/fixtures/e2e.json"), "utf8"),
    ) as { phoneToMacKey: string; phoneFrameDialogs: { counter: number; text: string; frame: string } };
    const key = new Uint8Array(Buffer.from(fixture.phoneToMacKey, "base64url"));
    const frame = new Uint8Array(Buffer.from(fixture.phoneFrameDialogs.frame, "base64url"));
    const { counter, text } = fixture.phoneFrameDialogs;
    expect(new TextDecoder().decode(open(key, BigInt(counter), frame))).toBe(text);
    expect(seal(key, BigInt(counter), new TextEncoder().encode(text))).toEqual(frame);
    expect(JSON.parse(text).params.dialogs).toBe(true);
  });
});

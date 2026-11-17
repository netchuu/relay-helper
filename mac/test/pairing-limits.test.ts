import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startAppServer } from "../src/daemon/api.ts";
import {
  createPairingCode,
  pairingAttemptAllowed,
  redeemPairingCode,
  resetPairingAttempts,
} from "../src/daemon/auth.ts";
import { ClientSession } from "../src/daemon/clientSession.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";

const REFUSED = "invalid or expired pairing code";
const TOO_MANY = "too many attempts, wait a minute";

beforeEach(resetPairingAttempts);
afterEach(resetPairingAttempts);

function relayPair(db: ReturnType<typeof openDb>, events: EventLog, code: string) {
  const sent: string[] = [];
  const session = new ClientSession(
    (t) => sent.push(t),
    { rpc: async () => ({ result: null }), events, db },
    () => {},
  );
  const pair = async () => {
    await session.handle(JSON.stringify({ id: 1, method: "pair", params: { code, deviceName: "Phone" } }));
    return JSON.parse(sent.at(-1) ?? "{}") as { error?: { code: string; message: string } };
  };
  return { session, pair };
}

describe("pairing code expiry", () => {
  test("a code lives five minutes", () => {
    const db = openDb(":memory:");
    const { expiresAt } = createPairingCode(db);
    expect(expiresAt).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  test("an expired unused code pairs nothing, directly and over the relay", async () => {
    const db = openDb(":memory:");
    const { code } = createPairingCode(db);
    db.query("UPDATE pairing_codes SET expires_at = ?").run(Date.now() - 55 * 60_000);
    expect(redeemPairingCode(db, code, "late")).toBeNull();

    const { session, pair } = relayPair(db, new EventLog(db), code);
    expect((await pair()).error).toEqual({ code: "unauthorized", message: REFUSED });
    expect(session.isAuthenticated).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM devices").get()).toEqual({ n: 0 });
  });
});

describe("pairing guess limit", () => {
  test("the 11th guess in a minute is refused, and allowed again a minute later", () => {
    const t0 = Date.now();
    const answers = Array.from({ length: 12 }, (_, i) => pairingAttemptAllowed(t0 + i));
    expect(answers).toEqual([...Array(10).fill(true), false, false]);
    expect(pairingAttemptAllowed(t0 + 60_011)).toBe(true);
  });

  test("new relay streams do not reset it, even for the right code", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const { code } = createPairingCode(db);
    const replies: string[] = [];
    for (let i = 0; i < 10; i++) {
      replies.push((await relayPair(db, events, "WRONGXXX").pair()).error?.message ?? "");
    }
    expect(replies).toEqual(Array(10).fill(REFUSED));

    const right = relayPair(db, events, code);
    expect((await right.pair()).error).toEqual({ code: "unavailable", message: TOO_MANY });
    expect(right.session.isAuthenticated).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM devices").get()).toEqual({ n: 0 });
  });

  test("POST /pair answers 429 for the 11th attempt", async () => {
    const db = openDb(":memory:");
    const server = startAppServer({
      port: 0,
      db,
      events: new EventLog(db),
      rpc: async () => ({ result: null }),
    });
    try {
      const post = (code: string) =>
        fetch(`http://127.0.0.1:${server.port}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, deviceName: "Phone" }),
        });
      for (let i = 0; i < 10; i++) expect((await post("WRONGXXX")).status).toBe(401);
      const { code } = createPairingCode(db);
      const res = await post(code);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: TOO_MANY });
    } finally {
      server.stop(true);
    }
  });
});

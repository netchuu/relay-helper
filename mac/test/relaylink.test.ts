import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { DB } from "../src/daemon/db.ts";
import { type Identity, macIdFor, rawPublic } from "../src/daemon/e2e.ts";
import type { EventLog } from "../src/daemon/events.ts";
import { RelayLink } from "../src/daemon/relayLink.ts";

function identity(): Identity {
  const auth = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  const authPublic = rawPublic(auth.publicKey);
  return {
    macId: macIdFor(authPublic),
    authPrivate: auth.privateKey,
    authPublic,
    boxPrivate: box.privateKey,
    boxPublic: rawPublic(box.publicKey),
  } as Identity;
}

const deps = { rpc: async () => ({ result: null }), events: {} as EventLog, db: {} as DB } as never;
let link: RelayLink | null = null;
let server: { stop(force?: boolean): void } | null = null;

afterEach(() => {
  link?.stop();
  server?.stop(true);
});

test("a connection attempt that never opens is given up and retried", async () => {
  // Accepts the TCP connection, then never answers the WebSocket upgrade.
  let attempts = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        attempts++;
      },
      data() {},
    },
  });
  server = listener;
  link = new RelayLink(`ws://127.0.0.1:${listener.port}`, identity(), deps, { connectTimeoutMs: 300 });
  link.start();
  const end = Date.now() + 6000;
  while (attempts < 2 && Date.now() < end) await Bun.sleep(50);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(link.connected).toBe(false);
}, 10_000);

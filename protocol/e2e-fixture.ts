/**
 * Writes protocol/fixtures/e2e.json: a fixed end-to-end handshake and frames produced by the Mac's
 * implementation (mac/src/daemon/e2e.ts). The iOS tests (CryptoKit) must derive the same keys and
 * produce/accept the same bytes. Run: bun protocol/e2e-fixture.ts
 */
import { createPublicKey, diffieHellman } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64url, deriveKeys, rawPublic, seal, x25519Private } from "../mac/src/daemon/e2e.ts";

const fixed = (byte: number) => new Uint8Array(32).fill(byte);
const phoneEph = x25519Private(fixed(0x11));
const macStatic = x25519Private(fixed(0x22));
const macEph = x25519Private(fixed(0x33));
const pub = (k: ReturnType<typeof x25519Private>) => rawPublic(createPublicKey(k));

const dhStatic = new Uint8Array(
  diffieHellman({ privateKey: macStatic, publicKey: createPublicKey(phoneEph) }),
);
const dhEph = new Uint8Array(diffieHellman({ privateKey: macEph, publicKey: createPublicKey(phoneEph) }));
const keys = deriveKeys(dhStatic, dhEph, pub(macStatic));

const text = (s: string) => new TextEncoder().encode(s);
const fixture = {
  phoneEphemeralPrivate: b64url(fixed(0x11)),
  macStaticPublic: b64url(pub(macStatic)),
  macEphemeralPublic: b64url(pub(macEph)),
  phoneToMacKey: b64url(keys.phoneToMac),
  macToPhoneKey: b64url(keys.macToPhone),
  // Mac → phone, counters 0 and 1.
  macFrames: [
    {
      counter: 0,
      text: '{"type":"rpc","id":1,"result":{"ok":true}}',
      frame: b64url(seal(keys.macToPhone, 0n, text('{"type":"rpc","id":1,"result":{"ok":true}}'))),
    },
    { counter: 1, text: "héllo · 📱", frame: b64url(seal(keys.macToPhone, 1n, text("héllo · 📱"))) },
  ],
  // Phone → Mac, counter 0: what the phone must produce byte for byte.
  phoneFrame: {
    counter: 0,
    text: '{"id":1,"method":"hello","params":{"token":"t"}}',
    frame: b64url(seal(keys.phoneToMac, 0n, text('{"id":1,"method":"hello","params":{"token":"t"}}'))),
  },
};
writeFileSync(join(import.meta.dir, "fixtures", "e2e.json"), `${JSON.stringify(fixture, null, 2)}\n`);
console.log("wrote protocol/fixtures/e2e.json");

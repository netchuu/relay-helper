/** Writes protocol/fixtures/e2e.json: a fixed handshake and frames the iOS tests (CryptoKit) must reproduce; `bun protocol/e2e-fixture.ts`. */
import { createPublicKey, diffieHellman } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64url, deriveKeys, rawPublic, seal, sealPieces, x25519Private } from "../mac/src/daemon/e2e.ts";

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
// Longer than one piece, with a character that a piece boundary splits in the middle.
const pieceText = "piece one → 📱 and the rest";
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
  // One message in piece frames (counters 2 to 4, 12 bytes of text each), after the two frames above.
  pieces: {
    firstCounter: 2,
    text: pieceText,
    frames: sealPieces(keys.macToPhone, 2n, text(pieceText), 12).map((f) => b64url(f)),
  },
  // Phone → Mac, counter 0: what the phone must produce byte for byte.
  phoneFrame: {
    counter: 0,
    text: '{"id":1,"method":"hello","params":{"token":"t"}}',
    frame: b64url(seal(keys.phoneToMac, 0n, text('{"id":1,"method":"hello","params":{"token":"t"}}'))),
  },
  // A phone that knows dialogs says so in `hello`, counter 1.
  phoneFrameDialogs: {
    counter: 1,
    text: '{"id":2,"method":"hello","params":{"token":"t","dialogs":true}}',
    frame: b64url(
      seal(keys.phoneToMac, 1n, text('{"id":2,"method":"hello","params":{"token":"t","dialogs":true}}')),
    ),
  },
};
writeFileSync(join(import.meta.dir, "fixtures", "e2e.json"), `${JSON.stringify(fixture, null, 2)}\n`);
console.log("wrote protocol/fixtures/e2e.json");

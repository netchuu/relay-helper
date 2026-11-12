/**
 * End-to-end encryption between the phone and this Mac over the Cloudflare relay (docs/RELAY.md).
 * X25519 key agreement anchored in the Mac's static key from the pairing QR, HKDF-SHA256, and
 * AES-256-GCM frames with per-direction counters (a counter nonce is never reused: each
 * direction has its own key, fresh per connection). The relay only ever sees ciphertext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const HANDSHAKE_PHONE = 0x01;
export const HANDSHAKE_MAC = 0x02;
export const DATA = 0x03;
const INFO = Buffer.from("relay-e2e-v1");
const TAG = 16;

export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

// ---------------------------------------------------------------------------------------------------
// Keys

export function rawPublic(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" }) as { x: string };
  return fromB64url(jwk.x);
}

export function x25519Public(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new E2EError("bad public key");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64url(raw) }, format: "jwk" });
}

export function x25519Private(rawPriv: Uint8Array): KeyObject {
  // JWK needs x as well; derive it from the private key.
  const tmp = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: b64url(rawPriv), x: b64url(new Uint8Array(32)) },
    format: "jwk",
  });
  const pub = rawPublic(createPublicKey(tmp));
  return createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: b64url(rawPriv), x: b64url(pub) },
    format: "jwk",
  });
}

function rawPrivate(key: KeyObject): Uint8Array {
  return fromB64url((key.export({ format: "jwk" }) as { d: string }).d);
}

export interface Identity {
  macId: string;
  authPublic: Uint8Array;
  authPrivate: KeyObject;
  boxPublic: Uint8Array;
  boxPrivate: KeyObject;
}

/** The room id is derived from the Ed25519 key, so only this Mac can serve its room. */
export function macIdFor(authPublic: Uint8Array): string {
  return b64url(createHash("sha256").update(authPublic).digest()).slice(0, 22);
}

/** ~/.relay/identity.json (mode 600). Created once; losing it means re-pairing phones. */
export function loadOrCreateIdentity(path: string): Identity {
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      auth: { d: string; x: string };
      box: { d: string; x: string };
    };
    const authPrivate = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", ...j.auth }, format: "jwk" });
    const boxPrivate = createPrivateKey({ key: { kty: "OKP", crv: "X25519", ...j.box }, format: "jwk" });
    const authPublic = fromB64url(j.auth.x);
    return {
      macId: macIdFor(authPublic),
      authPublic,
      authPrivate,
      boxPublic: fromB64url(j.box.x),
      boxPrivate,
    };
  }
  const auth = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  const jwk = (k: KeyObject) => {
    const { d, x } = k.export({ format: "jwk" }) as { d: string; x: string };
    return { d, x };
  };
  writeFileSync(path, JSON.stringify({ v: 1, auth: jwk(auth.privateKey), box: jwk(box.privateKey) }), {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return loadOrCreateIdentity(path);
}

/** Query parameters that prove to the Worker this Mac owns its room. */
export function connectProof(id: Identity, now = Date.now()): { pub: string; ts: string; sig: string } {
  const sig = sign(null, Buffer.from(`relay-mac-v1:${id.macId}:${now}`), id.authPrivate);
  return { pub: b64url(id.authPublic), ts: String(now), sig: b64url(sig) };
}

// ---------------------------------------------------------------------------------------------------
// Channel

export class E2EError extends Error {}

export interface SessionKeys {
  phoneToMac: Uint8Array;
  macToPhone: Uint8Array;
}

/** HKDF over both DH results; salt is the Mac's static public key (binds the keys to the paired Mac). */
export function deriveKeys(
  dhStatic: Uint8Array,
  dhEphemeral: Uint8Array,
  macStaticPublic: Uint8Array,
): SessionKeys {
  const ikm = Buffer.concat([dhStatic, dhEphemeral]);
  const okm = new Uint8Array(hkdfSync("sha256", ikm, macStaticPublic, INFO, 64));
  return { phoneToMac: okm.slice(0, 32), macToPhone: okm.slice(32, 64) };
}

function nonce(counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(counter, 4);
  return n;
}

export function seal(key: Uint8Array, counter: bigint, plaintext: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-256-gcm", key, nonce(counter), { authTagLength: TAG });
  const body = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return Buffer.concat([Buffer.from([DATA]), body]);
}

export function open(key: Uint8Array, counter: bigint, frame: Uint8Array): Uint8Array {
  if (frame[0] !== DATA || frame.length < 1 + TAG) throw new E2EError("not a data frame");
  const body = frame.subarray(1, frame.length - TAG);
  const tag = frame.subarray(frame.length - TAG);
  const d = createDecipheriv("aes-256-gcm", key, nonce(counter), { authTagLength: TAG });
  d.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  } catch {
    throw new E2EError("frame failed authentication");
  }
}

/**
 * The Mac's end of one phone connection. Feed it every payload from the relay; it answers the
 * handshake and decrypts data frames in order. Any error means the stream must be closed.
 */
export class MacChannel {
  private keys: SessionKeys | null = null;
  private recvCounter = 0n;
  private sendCounter = 0n;

  constructor(private readonly identity: Identity) {}

  get established(): boolean {
    return this.keys !== null;
  }

  /** Returns the handshake reply to send (if any) and the decrypted messages. */
  receive(frame: Uint8Array): { reply?: Uint8Array; messages: string[] } {
    if (!this.keys) {
      if (frame[0] !== HANDSHAKE_PHONE || frame.length !== 33) throw new E2EError("expected handshake");
      const phonePub = x25519Public(frame.subarray(1));
      const eph = generateKeyPairSync("x25519");
      const dhStatic = new Uint8Array(
        diffieHellman({ privateKey: this.identity.boxPrivate, publicKey: phonePub }),
      );
      const dhEph = new Uint8Array(diffieHellman({ privateKey: eph.privateKey, publicKey: phonePub }));
      this.keys = deriveKeys(dhStatic, dhEph, this.identity.boxPublic);
      return { reply: Buffer.concat([Buffer.from([HANDSHAKE_MAC]), rawPublic(eph.publicKey)]), messages: [] };
    }
    const plain = open(this.keys.phoneToMac, this.recvCounter, frame);
    this.recvCounter++;
    return { messages: [new TextDecoder("utf-8", { fatal: true }).decode(plain)] };
  }

  seal(text: string): Uint8Array {
    if (!this.keys) throw new E2EError("handshake not finished");
    const frame = seal(this.keys.macToPhone, this.sendCounter, new TextEncoder().encode(text));
    this.sendCounter++;
    return frame;
  }
}

/** The phone's end, in TypeScript: used by tests and the relay smoke test. The app uses CryptoKit. */
export class PhoneChannel {
  private readonly eph = generateKeyPairSync("x25519");
  private keys: SessionKeys | null = null;
  private recvCounter = 0n;
  private sendCounter = 0n;

  constructor(private readonly macStaticPublic: Uint8Array) {}

  hello(): Uint8Array {
    return Buffer.concat([Buffer.from([HANDSHAKE_PHONE]), rawPublic(this.eph.publicKey)]);
  }

  receiveHandshake(frame: Uint8Array): void {
    if (frame[0] !== HANDSHAKE_MAC || frame.length !== 33) throw new E2EError("expected mac handshake");
    const macEph = x25519Public(frame.subarray(1));
    const dhStatic = new Uint8Array(
      diffieHellman({ privateKey: this.eph.privateKey, publicKey: x25519Public(this.macStaticPublic) }),
    );
    const dhEph = new Uint8Array(diffieHellman({ privateKey: this.eph.privateKey, publicKey: macEph }));
    this.keys = deriveKeys(dhStatic, dhEph, this.macStaticPublic);
  }

  seal(text: string): Uint8Array {
    if (!this.keys) throw new E2EError("handshake not finished");
    return seal(this.keys.phoneToMac, this.sendCounter++, new TextEncoder().encode(text));
  }

  open(frame: Uint8Array): string {
    if (!this.keys) throw new E2EError("handshake not finished");
    return new TextDecoder().decode(open(this.keys.macToPhone, this.recvCounter++, frame));
  }
}

export { rawPrivate };

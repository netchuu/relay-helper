/** End-to-end encryption phone to Mac over the relay: X25519 + HKDF-SHA256, AES-256-GCM frames. */
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
/** A piece frame: type, the frame's counter (8 bytes, big endian), then the sealed piece. */
export const PIECE = 0x04;
/** Plaintext bytes in one piece; a sealed piece plus the stream id stays well under the relay's frame limit. */
export const PIECE_BYTES = 128 * 1024;
/** The most a reassembled message may take; a longer one ends the channel. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MORE = 1;
const CONTINUES = 2;
const INFO = Buffer.from("relay-e2e-v1");
const TAG = 16;

export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

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
 * One message as piece frames with counters `first`, `first + 1`, ...: the first byte of each piece's plaintext
 * says whether more follows and whether it continues a message, so a lost piece can't be mistaken for a whole one.
 */
export function sealPieces(
  key: Uint8Array,
  first: bigint,
  plaintext: Uint8Array,
  pieceBytes = PIECE_BYTES,
): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let at = 0;
  do {
    const end = Math.min(plaintext.length, at + pieceBytes);
    const flags = (end < plaintext.length ? MORE : 0) | (at > 0 ? CONTINUES : 0);
    const counter = first + BigInt(frames.length);
    const head = Buffer.alloc(9);
    head[0] = PIECE;
    head.writeBigUInt64BE(counter, 1);
    const body = Buffer.concat([Buffer.from([flags]), plaintext.subarray(at, end)]);
    const c = createCipheriv("aes-256-gcm", key, nonce(counter), { authTagLength: TAG });
    frames.push(Buffer.concat([head, c.update(body), c.final(), c.getAuthTag()]));
    at = end;
  } while (at < plaintext.length);
  return frames;
}

/** Opens a piece frame. Returns its counter and its flags and data. */
function openPiece(
  key: Uint8Array,
  frame: Uint8Array,
): { counter: bigint; more: boolean; continues: boolean; data: Uint8Array } {
  if (frame[0] !== PIECE || frame.length < 9 + TAG + 1) throw new E2EError("not a piece frame");
  const counter = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).readBigUInt64BE(1);
  const d = createDecipheriv("aes-256-gcm", key, nonce(counter), { authTagLength: TAG });
  d.setAuthTag(frame.subarray(frame.length - TAG));
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(frame.subarray(9, frame.length - TAG)), d.final()]);
  } catch {
    throw new E2EError("frame failed authentication");
  }
  const flags = plain[0] ?? 0;
  return {
    counter,
    more: (flags & MORE) !== 0,
    continues: (flags & CONTINUES) !== 0,
    data: new Uint8Array(plain.subarray(1)),
  };
}

/**
 * Reassembles messages from piece frames. A counter below the expected one is a replay and an error; a jump
 * means frames were lost, so the message in progress is dropped (as are the pieces that continue it).
 */
export class PieceReader {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private skipping = false;
  /** Frames that never arrived, since the last `takeLost`. */
  private lost = 0;

  constructor(private readonly key: Uint8Array) {}

  /** The message once its last piece is in; null while more follows or when it was dropped. */
  read(frame: Uint8Array, expected: bigint): { text: string | null; next: bigint } {
    const piece = openPiece(this.key, frame);
    if (piece.counter < expected) throw new E2EError("frame out of order");
    if (piece.counter > expected) {
      this.lost += Number(piece.counter - expected);
      this.reset();
      this.skipping = true;
    }
    const next = piece.counter + 1n;
    if (!piece.continues) {
      if (this.pending.length > 0) this.lost++;
      this.reset();
      this.skipping = false;
    } else if (this.skipping || this.pending.length === 0) {
      this.skipping = true;
      return { text: null, next };
    }
    this.pending.push(piece.data);
    this.pendingBytes += piece.data.length;
    if (this.pendingBytes > MAX_MESSAGE_BYTES) throw new E2EError("message too large");
    if (piece.more) return { text: null, next };
    const whole = Buffer.concat(this.pending);
    this.reset();
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(whole), next };
  }

  takeLost(): number {
    const n = this.lost;
    this.lost = 0;
    return n;
  }

  private reset(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/** The Mac's end of one phone connection; any error means the stream must be closed. */
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

  /** The frames for one message: with `pieces`, as many piece frames as it needs; without, the one old frame. */
  sealMessage(text: string, pieces: boolean, pieceBytes = PIECE_BYTES): Uint8Array[] {
    if (!pieces) return [this.seal(text)];
    if (!this.keys) throw new E2EError("handshake not finished");
    const frames = sealPieces(
      this.keys.macToPhone,
      this.sendCounter,
      new TextEncoder().encode(text),
      pieceBytes,
    );
    this.sendCounter += BigInt(frames.length);
    return frames;
  }
}

/** The phone's end, in TypeScript: used by tests and the relay smoke test. The app uses CryptoKit. */
export class PhoneChannel {
  private readonly eph = generateKeyPairSync("x25519");
  private reader: PieceReader | null = null;
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

  /** A message from either frame kind: null while a piece is waiting for the rest. */
  openMessage(frame: Uint8Array): string | null {
    if (!this.keys) throw new E2EError("handshake not finished");
    if (frame[0] === DATA) return this.open(frame);
    this.reader ??= new PieceReader(this.keys.macToPhone);
    const { text, next } = this.reader.read(frame, this.recvCounter);
    this.recvCounter = next;
    return text;
  }

  /** Frames that never arrived, so the phone should sync again. */
  takeLost(): number {
    return this.reader?.takeLost() ?? 0;
  }
}

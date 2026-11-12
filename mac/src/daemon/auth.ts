import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { audit } from "./db.ts";
import { newId } from "./hooks.ts";

const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_ATTEMPTS_PER_MINUTE = 10;
const pairingAttempts: number[] = [];

/** One limit for every pairing path (HTTPS and relay): 10 guesses a minute against an 8-char code. */
export function pairingAttemptAllowed(now = Date.now()): boolean {
  while (pairingAttempts.length && (pairingAttempts[0] ?? 0) < now - 60_000) pairingAttempts.shift();
  if (pairingAttempts.length >= PAIRING_ATTEMPTS_PER_MINUTE) return false;
  pairingAttempts.push(now);
  return true;
}
// No 0/O/1/I/L: the code may be typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface Device {
  id: string;
  name: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One-time pairing code shown by `relay pair` (QR + text). Only its hash is stored. */
export function createPairingCode(db: DB): { code: string; expiresAt: number } {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  // A new code replaces any earlier one: only the code on screen works.
  db.query("DELETE FROM pairing_codes").run();
  db.query("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)").run(sha256(code), expiresAt);
  return { code, expiresAt };
}

/** Exchanges a valid, unused pairing code for a long-lived device token (returned once, stored hashed). */
export function redeemPairingCode(
  db: DB,
  code: string,
  deviceName: string,
): { device: Device; token: string; pushKey: string } | null {
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, "");
  const row = db
    .query("SELECT code_hash FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(sha256(normalized), Date.now()) as { code_hash: string } | null;
  if (!row) return null;
  db.query("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?").run(Date.now(), row.code_hash);
  const token = randomBytes(32).toString("base64url");
  const device: Device = { id: newId("d"), name: deviceName.slice(0, 80) || "iPhone" };
  db.query("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
    device.id,
    device.name,
    sha256(token),
    Date.now(),
  );
  audit(db, `device:${device.id}`, "device.paired", { name: device.name });
  return { device, token, pushKey: ensurePushKey(db, device.id) };
}

export function authenticate(db: DB, header: string | null): Device | null {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const hash = sha256(token);
  const row = db
    .query("SELECT id, name, token_hash FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
    .get(hash) as { id: string; name: string; token_hash: string } | null;
  if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;
  db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), row.id);
  return { id: row.id, name: row.name };
}

/** The key that encrypts this phone's notification text (created on first use). */
export function ensurePushKey(db: DB, deviceId: string): string {
  const row = db.query("SELECT push_key FROM devices WHERE id = ?").get(deviceId) as {
    push_key: string | null;
  } | null;
  if (row?.push_key) return row.push_key;
  const key = randomBytes(32).toString("base64");
  db.query("UPDATE devices SET push_key = ? WHERE id = ?").run(key, deviceId);
  return key;
}

export function listDevices(
  db: DB,
): { id: string; name: string; createdAt: number; lastSeenAt: number | null; revoked: boolean }[] {
  const rows = db
    .query("SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at")
    .all() as {
    id: string;
    name: string;
    created_at: number;
    last_seen_at: number | null;
    revoked_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revoked: r.revoked_at !== null,
  }));
}

/** True while the device is paired; open WebSockets check this so a revocation takes effect at once. */
export function isDeviceActive(db: DB, id: string): boolean {
  return db.query("SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) !== null;
}

type RevokedListener = (deviceId: string) => void;
const revokedListeners = new Set<RevokedListener>();

/** Called with each device id as it is revoked, so open connections can be dropped at once. */
export function onDeviceRevoked(listener: RevokedListener): () => void {
  revokedListeners.add(listener);
  return () => revokedListeners.delete(listener);
}

/**
 * Revokes a device and clears its push token. The CLI may name a device; the phone's own Unpair
 * (actor `device:<id>`) matches its id only.
 */
export function revokeDevice(db: DB, idOrName: string, actor = "cli"): boolean {
  const byName = actor === "cli";
  const ids = (
    db
      .query(`SELECT id FROM devices WHERE (id = ?${byName ? " OR name = ?" : ""}) AND revoked_at IS NULL`)
      .all(...(byName ? [idOrName, idOrName] : [idOrName])) as { id: string }[]
  ).map((r) => r.id);
  for (const id of ids) {
    db.query("UPDATE devices SET revoked_at = ?, apns_token = NULL WHERE id = ?").run(Date.now(), id);
    audit(db, actor, "device.revoked", { id });
    for (const listener of revokedListeners) listener(id);
  }
  return ids.length > 0;
}

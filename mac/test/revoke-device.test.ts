import { expect, test } from "bun:test";
import {
  ambiguousDeviceIds,
  createPairingCode,
  listDevices,
  redeemPairingCode,
  revokeDevice,
} from "../src/daemon/auth.ts";
import { openDb } from "../src/daemon/db.ts";

async function pair(db: ReturnType<typeof openDb>, name: string) {
  const d = await redeemPairingCode(db, createPairingCode(db).code, name);
  if (!d) throw new Error("pairing failed");
  return d.device.id;
}

test("a name shared by two active devices revokes none and lists both ids", async () => {
  const db = openDb(":memory:");
  const a = await pair(db, "iPhone");
  const b = await pair(db, "iPhone");
  expect(revokeDevice(db, "iPhone")).toBe(false);
  expect(listDevices(db).filter((d) => d.revoked)).toEqual([]);
  expect(ambiguousDeviceIds(db, "iPhone").sort()).toEqual([a, b].sort());
});

test("a name matching one active device, and an id, still revoke", async () => {
  const db = openDb(":memory:");
  const a = await pair(db, "iPhone");
  const b = await pair(db, "iPhone");
  expect(revokeDevice(db, a)).toBe(true);
  expect(revokeDevice(db, "iPhone")).toBe(true);
  expect(listDevices(db).every((d) => d.revoked)).toBe(true);
  expect(b).toBeTruthy();
});

test("an id that is also another device's name is not ambiguous", async () => {
  const db = openDb(":memory:");
  const a = await pair(db, "Phone");
  expect(ambiguousDeviceIds(db, a)).toEqual([]);
});

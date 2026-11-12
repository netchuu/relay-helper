import { createDecipheriv } from "node:crypto";

/** A phone's push key for tests: the helper seals notification text with it (relayPush.ts → sealForPhone). */
export const TEST_PUSH_KEY = Buffer.alloc(32, 5).toString("base64");

/** Opens a sealed `relay.enc` as the phone's Notification Service Extension does. */
export function openSealed(
  blob: string,
  key = TEST_PUSH_KEY,
): { title: string; body: string; data: Record<string, unknown> } {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
}

/** The title a phone with TEST_PUSH_KEY shows for an APNs payload from the notifier. */
export const sealedTitle = (payload: object): string =>
  openSealed((payload as { relay: { enc: string } }).relay.enc).title;

/**
 * Writes protocol/fixtures/push.json: one encrypted notification (key, the sealed blob, and what it
 * decrypts to), so the iOS tests prove the Notification Service Extension reads the Mac's format.
 * Run: bun protocol/push-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealForPhone } from "../mac/src/daemon/relayPush.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const plaintext = {
  title: "checkout-redesign asks",
  body: "Which payment provider should the new checkout use?",
  data: {
    promptId: "p_fixture",
    sessionId: "s_fixture",
    kind: "question",
    question: "Which payment provider should the new checkout use?",
    options: ["Stripe", "Adyen"],
  },
};
const fixture = { key, enc: sealForPhone(key, plaintext), plaintext };
writeFileSync(join(import.meta.dir, "fixtures", "push.json"), `${JSON.stringify(fixture, null, 2)}\n`);
console.log("wrote protocol/fixtures/push.json");

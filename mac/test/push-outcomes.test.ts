import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/daemon/db.ts";
import { Notifier } from "../src/daemon/notifier.ts";
import {
  type PushOutcome,
  PushOutcomes,
  readPushOutcomes,
  summarizePushes,
} from "../src/daemon/pushOutcomes.ts";

const NOW = 1_000_000_000;
const ago = (ms: number) => `${Math.round(ms / 60_000)} min`;
const line = (o: PushOutcome[]) => summarizePushes(o, NOW, ago);
const at = (min: number, rest: Partial<PushOutcome> = {}): PushOutcome => ({
  at: NOW - min * 60_000,
  tried: 1,
  accepted: 1,
  ...rest,
});

test("nothing sent yet", () => {
  expect(line([])).toEqual({ ok: true, text: "Push: none sent yet" });
});

test("last push accepted", () => {
  expect(line([at(3)])).toEqual({ ok: true, text: "Push: last sent 3 min ago, accepted by 1 of 1 phone" });
  expect(line([at(3, { tried: 2 })]).text).toBe("Push: last sent 3 min ago, accepted by 1 of 2 phones");
});

test("last push refused is a note, three in a row a problem", () => {
  const refused = (min: number) => at(min, { accepted: 0, status: 429, reason: "too many" });
  expect(line([at(30), refused(12)])).toEqual({
    ok: true,
    text: "Push: last refused 12 min ago (429 too many)",
  });
  expect(line([at(30), refused(20), refused(15), refused(12)])).toEqual({
    ok: false,
    text: "Push: last refused 12 min ago (429 too many). The last 3 all failed",
  });
  expect(line([refused(20), at(15), refused(12)]).ok).toBe(true);
});

test("outcomes survive a restart and hold no token or text", () => {
  const file = join(mkdtempSync(join(tmpdir(), "relay-outcomes-")), "push-outcomes.json");
  new PushOutcomes(file).record({ at: 5, tried: 2, accepted: 1, status: 410, reason: "Unregistered" });
  new PushOutcomes(file).record({ at: 6, tried: 0, accepted: 0 });
  new PushOutcomes(file).record({ at: 7, tried: 1, accepted: 1 });
  expect(readPushOutcomes(file).map((o) => o.at)).toEqual([5, 7]);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))[0]).sort()).toEqual([
    "accepted",
    "at",
    "reason",
    "status",
    "tried",
  ]);
  for (let i = 0; i < 20; i++) new PushOutcomes(file).record({ at: 100 + i, tried: 1, accepted: 1 });
  expect(readPushOutcomes(file)).toHaveLength(10);
});

test("a damaged file reads as empty", () => {
  expect(readPushOutcomes(join(tmpdir(), "relay-no-such-outcomes.json"))).toEqual([]);
});

test("the notifier notes a refusal with its status and reason, not the token", async () => {
  const db = openDb(":memory:");
  db.query(
    "INSERT INTO devices (id, name, token_hash, created_at, apns_token, apns_env, push_platform) VALUES ('d', 'd', 'h', 0, ?, 'production', 'apns')",
  ).run("c".repeat(64));
  const file = join(mkdtempSync(join(tmpdir(), "relay-outcomes-")), "push-outcomes.json");
  const apns = { send: async () => ({ status: 429, reason: "too many" }) };
  const notifier = new Notifier(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { apns } as never,
    new PushOutcomes(file),
  );
  await notifier.pushAll({ title: "t", body: "secret text", collapseId: "c" } as never);
  const [o] = readPushOutcomes(file);
  expect(o).toMatchObject({ tried: 1, accepted: 0, status: 429, reason: "too many" });
  expect(readFileSync(file, "utf8")).not.toMatch(/secret text|cccc/);
});

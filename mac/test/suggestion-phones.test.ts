import { expect, test } from "bun:test";
import { Phones } from "../src/daemon/phones.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";
import { SuggestionWatcher, suggestionOf } from "../src/daemon/suggestion.ts";

// With no phone connected only the first looks after a Stop are read; one that connects gets the suggestion at once.
const session = { id: "p1", status: "idle", canReceive: true } as SessionRecord;

function setup(phones: Phones) {
  let reads = 0;
  const registry = { get: () => session, list: () => [session], publish() {} };
  const watcher = new SuggestionWatcher({
    registry,
    phoneConnected: () => phones.connected,
    sleep: async () => {
      await Bun.sleep(1);
    },
    read: async () => {
      reads++;
      return "run the tests";
    },
  });
  phones.onFirst(() => watcher.lookNow());
  return { watcher, reads: () => reads };
}

const settle = () => Bun.sleep(80);

test("a turn that ends with no phone connected takes the first looks and publishes nothing", async () => {
  const t = setup(new Phones());
  t.watcher.turnEnded("p1");
  await settle();
  expect(t.reads()).toBe(5);
  expect(suggestionOf("p1")).toBeUndefined();
  await settle();
  expect(t.reads()).toBe(5);
});

test("a phone that connects gets the suggestion of an idle session", async () => {
  const phones = new Phones();
  const t = setup(phones);
  t.watcher.turnEnded("p1");
  await settle();
  const leave = phones.join();
  await settle();
  expect(t.reads()).toBeGreaterThan(0);
  expect(suggestionOf("p1")).toBe("run the tests");
  leave();
  t.watcher.clear("p1");
});

test("reads stop when the last phone leaves, and the suggestion goes with them", async () => {
  const phones = new Phones();
  const leave = phones.join();
  const t = setup(phones);
  t.watcher.turnEnded("p1");
  await settle();
  expect(suggestionOf("p1")).toBe("run the tests");
  leave();
  await settle();
  const after = t.reads();
  await settle();
  expect(t.reads()).toBe(after);
  expect(suggestionOf("p1")).toBeUndefined();
});

test("a second phone joining does not restart the looks, and leaving twice counts once", () => {
  const phones = new Phones();
  let firsts = 0;
  phones.onFirst(() => firsts++);
  const a = phones.join();
  const b = phones.join();
  expect(firsts).toBe(1);
  a();
  a();
  expect(phones.connected).toBe(true);
  b();
  expect(phones.connected).toBe(false);
});

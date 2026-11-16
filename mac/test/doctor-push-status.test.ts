import { expect, test } from "bun:test";
import type { ApnsConfig } from "../src/daemon/push.ts";
import { iosPushStatus } from "../src/daemon/push.ts";

const key = { bundleId: "com.example.app" } as ApnsConfig;

test("push goes through the relay when a relay URL is set, key or not", () => {
  expect(iosPushStatus("https://relay.example", null)).toEqual({ state: "relay" });
  expect(iosPushStatus("https://relay.example", key)).toEqual({ state: "relay" });
});

test("without a relay URL the local key decides", () => {
  expect(iosPushStatus(undefined, key)).toEqual({ state: "local", bundleId: "com.example.app" });
});

test("push is off with neither a relay URL nor a key", () => {
  expect(iosPushStatus(undefined, null)).toEqual({ state: "off" });
});

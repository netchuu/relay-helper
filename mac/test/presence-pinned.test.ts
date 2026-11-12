import { describe, expect, test } from "bun:test";
import { pinnedIdleSeconds } from "../src/platform/darwin.ts";

/** A test helper can pin the Mac's idle time, so typing at the Mac during an end-to-end run doesn't hold its messages. */
describe("a test helper's pinned idle time", () => {
  const home = "/Users/someone";
  test("is used by a helper with its own RELAY_HOME", () => {
    expect(
      pinnedIdleSeconds({ RELAY_HOME: "/tmp/relay-real-x/relay", RELAY_TEST_IDLE_SECONDS: "3600" }, home),
    ).toBe(3600);
  });
  test("is ignored by the helper at ~/.relay", () => {
    expect(
      pinnedIdleSeconds({ RELAY_HOME: `${home}/.relay`, RELAY_TEST_IDLE_SECONDS: "3600" }, home),
    ).toBeNull();
    expect(pinnedIdleSeconds({ RELAY_TEST_IDLE_SECONDS: "3600" }, home)).toBeNull();
  });
  test("is off when unset or not a number", () => {
    expect(pinnedIdleSeconds({ RELAY_HOME: "/tmp/x" }, home)).toBeNull();
    expect(pinnedIdleSeconds({ RELAY_HOME: "/tmp/x", RELAY_TEST_IDLE_SECONDS: "soon" }, home)).toBeNull();
  });
});

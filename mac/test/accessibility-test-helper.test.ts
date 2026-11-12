import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isTestHelper } from "../src/config.ts";
import { askForAccessibility } from "../src/integrations/claudeDesktop.ts";

// A test helper (any helper with its own RELAY_HOME: a test daemon, a UI-test server) must not ask macOS for
// Accessibility, which the helper does 3 s after it starts. Only the real helper, at ~/.relay, may ask.
describe("test helpers never ask for Accessibility", () => {
  const home = "/Users/someone";

  test("the default home is the real helper", () => {
    expect(isTestHelper({}, home)).toBe(false);
    expect(isTestHelper({ RELAY_HOME: join(home, ".relay") }, home)).toBe(false);
    expect(isTestHelper({ RELAY_HOME: `${home}/.relay/` }, home)).toBe(false);
  });

  test("any other RELAY_HOME is a test helper", () => {
    expect(isTestHelper({ RELAY_HOME: "/tmp/relay-test" }, home)).toBe(true);
    expect(isTestHelper({ RELAY_HOME: "/tmp/relay-ui-test" }, home)).toBe(true);
    // A test helper may also run with a fake HOME; RELAY_HOME isn't under it.
    expect(isTestHelper({ RELAY_HOME: "/tmp/relay-test" }, "/tmp/relay-test/home")).toBe(true);
  });

  test("askForAccessibility skips in a test helper, even when forced", () => {
    const before = process.env.RELAY_HOME;
    process.env.RELAY_HOME = "/tmp/relay-accessibility-test";
    try {
      expect(isTestHelper()).toBe(true);
      expect(askForAccessibility()).toBe("skipped");
      expect(askForAccessibility({ force: true })).toBe("skipped");
    } finally {
      if (before === undefined) delete process.env.RELAY_HOME;
      else process.env.RELAY_HOME = before;
    }
  });
});

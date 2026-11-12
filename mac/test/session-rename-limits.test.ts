// What a phone may name a session: 60 visible characters of any kind, no line breaks of any kind, and a name of
// only invisible characters clears it.
import { describe, expect, test } from "bun:test";
import type { Session } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps, type RpcOutcome } from "../src/daemon/rpc.ts";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const rpc = createRpc({ db, events, registry } as unknown as RpcDeps);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", name: "claude-name" });
  const rename = (name: unknown) => rpc("session.rename", { sessionId: "s1", name }, "device:phone-a");
  return { registry, rename };
}
const code = (o: RpcOutcome) => ("error" in o ? o.error.code : "ok");
const nameOf = (o: RpcOutcome) => ("result" in o ? (o.result as Session).name : null);

describe("session-rename: what counts as a name", () => {
  test("60 visible characters are accepted whatever they are made of", async () => {
    const { rename } = setup();
    for (const sixty of [
      "🚀".repeat(60), // 60 emoji, 120 UTF-16 units
      "é".repeat(60), // 60 "é" typed with a combining accent, 120 units
      "👍🏽".repeat(60), // 60 emoji with a skin tone, 240 units
    ]) {
      expect(code(await rename(sixty))).toBe("ok");
      expect(nameOf(await rename(sixty))).toBe(sixty);
    }
  });

  test("Unicode line breaks inside the name are refused like \\n", async () => {
    const { rename, registry } = setup();
    for (const sep of [" ", " ", "\u0085", "\v", "\f"]) {
      expect(code(await rename(`Cart${sep}bug`))).toBe("bad_request");
    }
    expect(registry.get("s1")?.name).toBe("claude-name");
  });

  test("a name made only of invisible characters clears instead of saving a blank name", async () => {
    const { rename } = setup();
    for (const invisible of ["​", "​​", "⁠", "﻿​"]) {
      await rename("Cart bug");
      expect(nameOf(await rename(invisible))).toBe("claude-name");
    }
  });
});

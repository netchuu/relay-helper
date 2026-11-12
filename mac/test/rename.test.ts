import { describe, expect, test } from "bun:test";
import type { RelayEvent, Session } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

// A name given from a phone lives only in Relay and wins over Claude Code's.
function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const upserts: Session[] = [];
  events.subscribe((e: RelayEvent) => {
    if (e.type === "session.upsert") upserts.push(e.session);
  });
  // session.rename only needs the database, the event log and the registry.
  const rpc = createRpc({ db, events, registry } as unknown as RpcDeps);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", name: "claude-name" });
  upserts.length = 0;
  return { db, registry, upserts, rpc };
}

describe("session rename", () => {
  test("the phone's name replaces Claude Code's, which stays as originalName", () => {
    const { registry, upserts } = setup();
    const before = registry.get("s1")?.updatedAt;
    registry.rename("s1", "  Cart bug  ");
    const s = publicSession(registry.get("s1") as NonNullable<ReturnType<Registry["get"]>>);
    expect(s.name).toBe("Cart bug");
    expect(s.originalName).toBe("claude-name");
    // Not activity: "updated 2 min ago" doesn't jump.
    expect(s.updatedAt).toBe(before as number);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.name).toBe("Cart bug");
  });

  test("a later name from Claude Code doesn't replace it, and shows as the original", () => {
    const { registry } = setup();
    registry.rename("s1", "Cart bug");
    // What a hook or the minute-by-minute reconcile does with `claude agents --json`.
    registry.touch("s1", { name: "renamed-in-claude" }, false);
    const s = registry.get("s1");
    expect(s?.name).toBe("Cart bug");
    expect(s?.originalName).toBe("renamed-in-claude");
  });

  test("null or empty clears it, and originalName goes away", () => {
    const { registry } = setup();
    for (const clear of [null, "", "   "]) {
      registry.rename("s1", "Cart bug");
      registry.rename("s1", clear);
      const s = publicSession(registry.get("s1") as NonNullable<ReturnType<Registry["get"]>>);
      expect(s.name).toBe("claude-name");
      expect("originalName" in s).toBe(false);
    }
  });

  test("a session Claude Code never named: originalName is null, so apps fall back to the folder", () => {
    const { registry } = setup();
    registry.touch("s2", { cwd: "/Users/me/Projects/api" });
    registry.rename("s2", "API work");
    expect(registry.get("s2")?.originalName).toBeNull();
    expect(registry.get("s2")?.project).toBe("api");
  });

  test("an ended session keeps its name, and so does a resumed one", () => {
    const { registry } = setup();
    registry.rename("s1", "Cart bug");
    registry.setStatus("s1", "ended");
    expect(registry.get("s1")?.name).toBe("Cart bug");
    registry.touch("s1", { name: "claude-name" });
    expect(registry.get("s1")?.name).toBe("Cart bug");
  });

  test("RPC: returns the renamed session; unknown IDs, long names and line breaks are refused", async () => {
    const { rpc } = setup();
    const ok = await rpc("session.rename", { sessionId: "s1", name: "Cart bug" }, "device:test");
    expect("result" in ok && (ok.result as Session).name).toBe("Cart bug");
    expect("result" in ok && (ok.result as Session).originalName).toBe("claude-name");

    const missing = await rpc("session.rename", { sessionId: "nope", name: "x" }, "device:test");
    expect("error" in missing && missing.error.code).toBe("not_found");
    const long = await rpc("session.rename", { sessionId: "s1", name: "x".repeat(61) }, "device:test");
    expect("error" in long && long.error.code).toBe("bad_request");
    const twoLines = await rpc("session.rename", { sessionId: "s1", name: "a\nb" }, "device:test");
    expect("error" in twoLines && twoLines.error.code).toBe("bad_request");
    // 60 characters after trimming is fine.
    const max = await rpc("session.rename", { sessionId: "s1", name: ` ${"x".repeat(60)} ` }, "device:test");
    expect("result" in max).toBe(true);
  });

  test("the rename is audited by length, never by text", async () => {
    const { rpc, db } = setup();
    await rpc("session.rename", { sessionId: "s1", name: "Secret project" }, "device:test");
    const rows = JSON.stringify(db.query("SELECT * FROM audit").all());
    expect(rows).toContain("session.rename");
    expect(rows).not.toContain("Secret project");
  });
});

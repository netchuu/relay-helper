import { beforeEach, describe, expect, test } from "bun:test";
import { PermissionModeResult, RpcSchemas, Session } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { forgetHeld, notePermissionMode } from "../src/daemon/held.ts";
import type { TypeOps } from "../src/daemon/inject.ts";
import { modeFromScreen, offeredModes, switchPermissionMode } from "../src/daemon/permissionMode.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";

// Switching the permission mode from the phone: Shift+Tab in the session's own terminal until the footer shows it.

const FOOTERS: Record<string, string> = {
  default: "  ⏸ manual mode on (shift+tab to cycle)",
  acceptEdits: "  ⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "  ⏸ plan mode on (shift+tab to cycle)",
  bypassPermissions: "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle)",
};
const screenOf = (mode: string) => ["─".repeat(60), "❯ ", "─".repeat(60), FOOTERS[mode]].join("\n");

/** A terminal whose Shift+Tab walks `cycle`; `stuck` makes it ignore the key. */
function terminal(cycle: string[], start: string, opts: { stuck?: boolean; refuse?: "not_foreground" } = {}) {
  let at = cycle.indexOf(start);
  let presses = 0;
  const ops: Pick<TypeOps, "ptyScreen" | "ptyShiftTab"> = {
    ptyScreen: async () => screenOf(cycle[at] as string),
    ptyShiftTab: async () => {
      presses++;
      if (opts.refuse) return { ok: false, reason: opts.refuse };
      if (!opts.stuck) at = (at + 1) % cycle.length;
      return { ok: true };
    },
  };
  return { ops, presses: () => presses };
}

const target = { id: "s1", ptySocket: "/tmp/p.sock", ptyToken: "t", pid: 77 };
const fast = { settleMs: 20, maxPresses: 6 };

beforeEach(() => forgetHeld("s1"));

describe("modeFromScreen", () => {
  test("reads each footer, and the old default footer", () => {
    expect(modeFromScreen(screenOf("plan"))).toBe("plan");
    expect(modeFromScreen(screenOf("acceptEdits"))).toBe("acceptEdits");
    expect(modeFromScreen(screenOf("bypassPermissions"))).toBe("bypassPermissions");
    expect(modeFromScreen(screenOf("auto"))).toBe("auto");
    expect(modeFromScreen(screenOf("default"))).toBe("default");
    expect(modeFromScreen("❯ \n  ? for shortcuts")).toBe("default");
    expect(modeFromScreen("  ⏵⏵ don't ask on (shift+tab to cycle)")).toBe("dontAsk");
  });
  test("a screen without a footer says nothing", () => {
    expect(modeFromScreen("Do you trust this folder?\n1. Yes\n2. No")).toBeNull();
  });
});

describe("switchPermissionMode", () => {
  test("presses Shift+Tab until the footer matches", async () => {
    const t = terminal(["default", "acceptEdits", "plan"], "default");
    expect(await switchPermissionMode(target, "plan", t.ops, fast)).toBe("plan");
    expect(t.presses()).toBe(2);
  });

  test("already there: no key is pressed", async () => {
    const t = terminal(["default", "acceptEdits", "plan"], "plan");
    expect(await switchPermissionMode(target, "plan", t.ops, fast)).toBe("plan");
    expect(t.presses()).toBe(0);
  });

  test("wraps round the cycle, and notes the modes it passes", async () => {
    const t = terminal(["default", "acceptEdits", "plan", "bypassPermissions"], "bypassPermissions");
    await switchPermissionMode(target, "acceptEdits", t.ops, fast);
    expect(t.presses()).toBe(2);
    expect(offeredModes("s1")).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  });

  test("a mode that never comes: gives up after a turn and says so", async () => {
    const t = terminal(["default", "acceptEdits", "plan"], "default");
    await expect(switchPermissionMode(target, "bypassPermissions", t.ops, fast)).rejects.toThrow(
      "Claude Code didn't switch to bypass permissions. Press Shift+Tab at the computer.",
    );
    expect(t.presses()).toBe(6);
  });

  test("a key that changes nothing gives up the same way", async () => {
    const t = terminal(["default", "plan"], "default", { stuck: true });
    await expect(
      switchPermissionMode(target, "plan", t.ops, { settleMs: 10, maxPresses: 3 }),
    ).rejects.toThrow("didn't switch to plan mode");
    expect(t.presses()).toBe(3);
  });

  test("a dialog that covers the footer after a press stops the switch", async () => {
    let presses = 0;
    const dialog = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, allow for the rest of the session",
      "  3. No",
    ].join("\n");
    const ops: Pick<TypeOps, "ptyScreen" | "ptyShiftTab"> = {
      ptyScreen: async () => (presses === 0 ? screenOf("default") : dialog),
      ptyShiftTab: async () => {
        presses++;
        return { ok: true };
      },
    };
    await expect(switchPermissionMode(target, "plan", ops, fast)).rejects.toThrow("showing a question");
    expect(presses).toBe(1);
  });

  test("a dialog that comes up while the footer hasn't changed is not pressed into", async () => {
    let presses = 0;
    let reads = 0;
    const ops: Pick<TypeOps, "ptyScreen" | "ptyShiftTab"> = {
      ptyScreen: async () => (++reads > 2 ? "Do you want to proceed?\n❯ 1. Yes" : screenOf("default")),
      ptyShiftTab: async () => {
        presses++;
        return { ok: true };
      },
    };
    await expect(switchPermissionMode(target, "plan", ops, { settleMs: 10, maxPresses: 6 })).rejects.toThrow(
      "showing a question",
    );
    expect(presses).toBe(1);
  });

  test("Claude Code not in front: refused with a sentence", async () => {
    const t = terminal(["default", "plan"], "default", { refuse: "not_foreground" });
    await expect(switchPermissionMode(target, "plan", t.ops, fast)).rejects.toThrow(
      "Claude Code isn't in front at the computer.",
    );
  });

  test("a screen that can't be read, or a session without a pty, is refused", async () => {
    const unreadable: Pick<TypeOps, "ptyScreen" | "ptyShiftTab"> = {
      ptyScreen: async () => "Do you trust this folder?",
      ptyShiftTab: async () => ({ ok: true }),
    };
    await expect(switchPermissionMode(target, "plan", unreadable, fast)).rejects.toThrow("can't be read");
    const t = terminal(["default", "plan"], "default");
    await expect(switchPermissionMode({ ...target, ptySocket: null }, "plan", t.ops, fast)).rejects.toThrow(
      "can't be changed from the phone",
    );
  });
});

function helper(env: Record<string, unknown>, cycle: string[]) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  registry.touch("s1", { cwd: "/Users/me/Projects/web-shop", env: env as never });
  const t = terminal(cycle, "default");
  const rpc = createRpc({
    db,
    events,
    registry,
    broker: { hasOpen: () => false },
    config: { preferTyping: true },
    typeOps: t.ops as TypeOps,
  } as unknown as RpcDeps);
  return { rpc, registry, t };
}

describe("session.permissionMode", () => {
  const env = { pty: "/tmp/p.sock", ptyToken: "t", claudePid: 77 };

  test("the session lists the modes only where Shift+Tab can reach it", () => {
    const wrapped = helper(env, ["default"]).registry;
    const plain = helper({ termProgram: "iTerm.app", claudePid: 77 }, ["default"]).registry;
    const withModes = Session.parse(publicSession(wrapped.get("s1") as never));
    expect(withModes.permissionModes).toEqual(["default", "acceptEdits", "plan"]);
    expect(Session.parse(publicSession(plain.get("s1") as never)).permissionModes).toBeUndefined();
  });

  test("switches, answers with the mode shown, and the session reports it", async () => {
    const h = helper(env, ["default", "acceptEdits", "plan"]);
    const res = await h.rpc("session.permissionMode", { sessionId: "s1", mode: "plan" }, "phone");
    expect(PermissionModeResult.parse((res as { result: unknown }).result).mode).toBe("plan");
    expect(publicSession(h.registry.get("s1") as never).permissionMode).toBe("plan");
  });

  test("a mode the session never showed isn't offered", async () => {
    const h = helper(env, ["default", "acceptEdits", "plan"]);
    const out = await h.rpc(
      "session.permissionMode",
      { sessionId: "s1", mode: "bypassPermissions" },
      "phone",
    );
    expect(out).toMatchObject({
      error: { code: "unavailable", message: "This session can't switch to that mode." },
    });
    expect(h.t.presses()).toBe(0);
  });

  test("bypass is offered once a hook has reported it", async () => {
    const h = helper(env, ["default", "bypassPermissions"]);
    notePermissionMode("s1", "bypassPermissions");
    const res = await h.rpc(
      "session.permissionMode",
      { sessionId: "s1", mode: "bypassPermissions" },
      "phone",
    );
    expect(PermissionModeResult.parse((res as { result: unknown }).result).mode).toBe("bypassPermissions");
  });

  test("schema accepts known modes only", () => {
    expect(() => RpcSchemas["session.permissionMode"].parse({ sessionId: "s1", mode: "yolo" })).toThrow();
  });
});

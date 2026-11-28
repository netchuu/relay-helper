import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Answer } from "../../protocol/index.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { hookOutputFor, payloadFor } from "../src/daemon/decisions.ts";
import { EventLog } from "../src/daemon/events.ts";
import { forgetHeld, notePermissionMode } from "../src/daemon/held.ts";
import { planApprovalModes } from "../src/daemon/planModes.ts";

let root: string;
const home = () => join(root, "home");
const project = () => join(root, "project");
const write = (dir: string, file: string, permissions: Record<string, unknown>) => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", file), JSON.stringify({ permissions }));
};
const modes = (args: string | null = null) =>
  planApprovalModes({ sessionId: "s1", cwd: project(), args, home: home() });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plan-modes-"));
  mkdirSync(project(), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  forgetHeld("s1");
});

describe("which approval choices a plan offers", () => {
  test("a plain session offers none", () => {
    expect(modes("claude")).toEqual([]);
    expect(modes(null)).toEqual([]);
  });

  test("bypass when the process was started with a flag that allows it", () => {
    expect(modes("claude --dangerously-skip-permissions")).toEqual(["bypassPermissions"]);
    expect(modes("claude --allow-dangerously-skip-permissions --model opus")).toEqual(["bypassPermissions"]);
    expect(modes("claude --permission-mode bypassPermissions")).toEqual(["bypassPermissions"]);
    expect(modes("claude --dangerously-skip-permissionsX")).toEqual([]);
  });

  test("bypass when the session reported it", () => {
    notePermissionMode("s1", "bypassPermissions");
    expect(modes()).toEqual(["bypassPermissions"]);
  });

  test("bypass and auto when the user's settings start in them", () => {
    write(home(), "settings.json", { defaultMode: "bypassPermissions" });
    expect(modes()).toEqual(["bypassPermissions"]);
    write(home(), "settings.json", { defaultMode: "auto" });
    expect(modes()).toEqual(["auto"]);
  });

  test("a project default of bypass doesn't count: Claude Code ignores it there", () => {
    write(project(), "settings.json", { defaultMode: "bypassPermissions" });
    write(project(), "settings.local.json", { defaultMode: "auto" });
    expect(modes()).toEqual([]);
  });

  test("auto when the session reported it", () => {
    notePermissionMode("s1", "auto");
    expect(modes()).toEqual(["auto"]);
  });

  test("disable keys in any settings file remove the choice", () => {
    write(home(), "settings.json", { defaultMode: "bypassPermissions" });
    write(project(), "settings.local.json", { disableBypassPermissionsMode: "disable" });
    expect(modes("claude --dangerously-skip-permissions")).toEqual([]);
    notePermissionMode("s1", "auto");
    write(project(), "settings.json", { disableAutoMode: "disable" });
    expect(modes()).toEqual([]);
  });

  test("disableAutoMode at the top level of a settings file removes auto too", () => {
    mkdirSync(join(home(), ".claude"), { recursive: true });
    writeFileSync(
      join(home(), ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "auto" }, disableAutoMode: "disable" }),
    );
    expect(modes()).toEqual([]);
    notePermissionMode("s1", "auto");
    expect(modes()).toEqual([]);
  });

  test("unreadable settings are ignored", () => {
    mkdirSync(join(home(), ".claude"), { recursive: true });
    writeFileSync(join(home(), ".claude", "settings.json"), "{ not json");
    expect(modes("claude")).toEqual([]);
  });
});

describe("the hook answer", () => {
  const input = { plan: "1. do it", planFilePath: "/p.md" };
  const decision = (action: "approve_bypass_permissions" | "approve_auto") =>
    JSON.parse(hookOutputFor("plan", input, null, { kind: "plan", action }) as string).hookSpecificOutput
      .decision;

  test("bypass sets the session's mode to bypassPermissions", () => {
    expect(decision("approve_bypass_permissions")).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
  });

  test("auto sets the session's mode to auto", () => {
    expect(decision("approve_auto").updatedPermissions).toEqual([
      { type: "setMode", mode: "auto", destination: "session" },
    ]);
  });

  test("the payload lists the choices only when there are some", () => {
    const base = { session_id: "s1", tool_name: "ExitPlanMode", tool_input: input };
    expect(payloadFor(base)).not.toHaveProperty("approvalModes");
    expect(payloadFor(base, ["bypassPermissions"])).toMatchObject({ approvalModes: ["bypassPermissions"] });
  });

  test("the protocol accepts the new actions", () => {
    expect(Answer.parse({ kind: "plan", action: "approve_bypass_permissions" }).kind).toBe("plan");
    expect(Answer.parse({ kind: "plan", action: "approve_auto" }).kind).toBe("plan");
  });
});

describe("answering a plan", () => {
  const ask = (approvalModes: ("bypassPermissions" | "auto")[]) => {
    const db = openDb(":memory:");
    const broker = new Broker(db, new EventLog(db));
    const input = { session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan: "x" } };
    return { broker, ...broker.open(input, approvalModes) };
  };

  test("an offered mode reaches the hook and is named in the history", async () => {
    const { broker, prompt, reply } = ask(["bypassPermissions"]);
    expect(broker.answer(prompt.id, { kind: "plan", action: "approve_bypass_permissions" }, "d")).toEqual({
      ok: true,
    });
    const out = JSON.parse((await reply).stdout as string);
    expect(out.hookSpecificOutput.decision.updatedPermissions[0].mode).toBe("bypassPermissions");
    expect(broker.get(prompt.id)?.outcome).toBe("Approved, permissions bypassed");
  });

  test("a mode the plan didn't offer is refused and the prompt stays open", () => {
    const { broker, prompt } = ask(["bypassPermissions"]);
    expect(broker.answer(prompt.id, { kind: "plan", action: "approve_auto" }, "d")).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(broker.get(prompt.id)?.status).toBe("open");
  });
});

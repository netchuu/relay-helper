import { describe, expect, test } from "bun:test";
import { TimelineReader } from "../src/daemon/timeline.ts";

const iso = (at: number) => new Date(at).toISOString();
const use = (id: string, name: string, input: object, at: number) => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, at: number, isError = false) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: iso(at),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] },
});

describe("a tool step's duration", () => {
  test("runs from the tool call to its result", () => {
    const r = new TimelineReader("/p");
    r.add(use("a", "Bash", { command: "ls" }, 10_000));
    expect(r.actions[0]?.durationMs).toBeUndefined();
    const changed = r.add(result("a", 10_420));
    expect(changed[0]).toMatchObject({ id: "a", durationMs: 420 });
  });

  test("a failed call has one too", () => {
    const r = new TimelineReader("/p");
    r.add(use("a", "Read", { file_path: "/p/x" }, 5000));
    r.add(result("a", 5900, true));
    expect(r.actions[0]).toMatchObject({ failed: true, durationMs: 900 });
  });

  test("a call without its result yet has none", () => {
    const r = new TimelineReader("/p");
    r.add(use("a", "Bash", { command: "sleep 9" }, 5000));
    expect(r.actions[0]?.durationMs).toBeUndefined();
  });

  test("a second result does not change it", () => {
    const r = new TimelineReader("/p");
    r.add(use("a", "Bash", { command: "ls" }, 1000));
    r.add(result("a", 1200));
    r.add(result("a", 9000));
    expect(r.actions[0]?.durationMs).toBe(200);
  });

  test("a result stamped before the call leaves it out", () => {
    const r = new TimelineReader("/p");
    r.add(use("a", "Bash", { command: "ls" }, 2000));
    r.add(result("a", 1000));
    expect(r.actions[0]?.durationMs).toBeUndefined();
  });
});

describe("a command sent to the background", () => {
  test("has no time: its result only says it started", () => {
    const r = new TimelineReader("/p");
    r.add(use("a", "Bash", { command: "sleep 12" }, 1000));
    const entry = {
      type: "user",
      uuid: "r-a",
      timestamp: iso(1700),
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", content: "Command running in background with ID: b1." },
        ],
      },
    };
    r.add(entry);
    expect(r.actions[0]?.durationMs).toBeUndefined();
  });
});

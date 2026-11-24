import { expect, test } from "bun:test";
import { payloadFor } from "../src/daemon/decisions.ts";

const call = (tool_input: Record<string, unknown>) =>
  payloadFor({ session_id: "s1", tool_name: "Bash", tool_input } as Parameters<typeof payloadFor>[0]);

test("a Bash call's own description reaches the phone", () => {
  const p = call({ command: "cp a.ts /tmp/c.ts", description: "Copy the control library to /tmp" });
  if (p.kind !== "permission") throw new Error("not a permission");
  expect(p.description).toBe("Copy the control library to /tmp");
  expect(p.summary).toBe("cp a.ts /tmp/c.ts");
});

test("no description, an empty one or a non-string leaves the field out", () => {
  for (const description of [undefined, "", "  \n ", 7]) {
    const p = call({ command: "ls", description });
    if (p.kind !== "permission") throw new Error("not a permission");
    expect(p.description).toBeUndefined();
  }
});

test("a description is one short line without secrets or control codes", () => {
  const p = call({
    command: "x",
    description: `Deploy\nwith \x1b[31mkey sk-ant-api03-${"a".repeat(40)} ${"y".repeat(300)}`,
  });
  if (p.kind !== "permission") throw new Error("not a permission");
  expect(p.description).not.toContain("\n");
  expect(p.description).not.toContain("\x1b");
  expect(p.description).not.toContain("sk-ant-api03");
  expect(p.description?.length).toBeLessThanOrEqual(140);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// `relay answer` against a fake daemon socket in a temp RELAY_HOME (never the real one).
const home = mkdtempSync("/tmp/rl-ans-");
const calls: { method: string; params: { promptId?: string } }[] = [];
let server: ReturnType<typeof Bun.serve>;

const permission = (id: string) => ({
  id,
  payload: { kind: "permission", tool: "Bash", summary: id },
});

beforeAll(() => {
  server = Bun.serve({
    unix: join(home, "hook.sock"),
    async fetch(req) {
      const { method, params } = (await req.json()) as (typeof calls)[number];
      calls.push({ method, params });
      if (method === "prompts.open")
        return Response.json({
          result: [permission("p_aaa111"), permission("p_aaa222"), permission("p_bbb333")],
        });
      return Response.json({ result: {} });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

async function relayAnswer(id: string) {
  calls.length = 0;
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "answer", id, "allow"], {
    env: { ...process.env, RELAY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code, answered: calls.filter((c) => c.method === "prompt.answer") };
}

test("an ambiguous prefix is refused and answers nothing", async () => {
  for (const prefix of ["p_", "p_aaa"]) {
    const r = await relayAnswer(prefix);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("use more of the id");
    expect(r.answered).toHaveLength(0);
  }
});

test("an exact id and a unique prefix still answer", async () => {
  const exact = await relayAnswer("p_aaa222");
  expect(exact.code).toBe(0);
  expect(exact.answered.map((c) => c.params.promptId)).toEqual(["p_aaa222"]);
  const unique = await relayAnswer("p_b");
  expect(unique.code).toBe(0);
  expect(unique.answered.map((c) => c.params.promptId)).toEqual(["p_bbb333"]);
});

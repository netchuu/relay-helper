// Turn steps at their limits: characters counted as people see them, tokens cut by a limit, paths with .., live
// steps of sessions that went idle or ended, and a subagent's entries in the step count.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayEvent, TurnStep } from "../../protocol/index.ts";
import { TurnStep as TurnStepSchema } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker, stepFor } from "../src/daemon/steps.ts";

const CWD = "/Users/me/Projects/my-app";
const label = (tool: string, input: Record<string, unknown>) => stepFor(tool, input, CWD, "live").label;
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("limits count characters people see, and never split one", () => {
  test("no label ends in half an emoji (a lone surrogate)", () => {
    const labels = [
      label("Grep", { pattern: "😀".repeat(31) }),
      label("Agent", { description: "🚀".repeat(51) }),
      label("Bash", { command: `echo ${"😀".repeat(40)}` }),
      label("Read", { file_path: `${CWD}/${"📁".repeat(61)}` }),
    ];
    for (const l of labels) expect(l).not.toMatch(loneSurrogate);
  });

  test("a 30-emoji pattern is at the limit and shows whole", () => {
    expect(label("Grep", { pattern: "😀".repeat(30) })).toBe(`Searching for “${"😀".repeat(30)}”`);
  });

  test("a 50-character description with combining marks shows whole", () => {
    const d = "é".repeat(50); // é as e + combining acute: 50 characters, 100 code units
    expect(label("Agent", { description: d })).toBe(`Running an agent: ${d}`);
  });

  test("a family emoji is never cut in the middle", () => {
    const fam = "👨‍👩‍👧‍👦";
    const l = label("Agent", { description: fam.repeat(60) });
    const shown = l.replace(/^Running an agent: /, "").replace(/…$/, "");
    expect(shown.replaceAll(fam, "")).toBe("");
    expect(graphemes(shown)).toBeLessThanOrEqual(50);
  });
});

test("a token cut by the 40-character limit doesn't leak its first part", () => {
  const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123";
  const l = label("Bash", { command: `curl https://${token}@github.com/me/repo.git` });
  expect(l).not.toContain("ghp_ABCDEFGHIJ");
});

test("a path that climbs out of the project with .. shows only the file name", () => {
  expect(label("Read", { file_path: `${CWD}/../../.ssh/id_rsa` })).toBe("Reading id_rsa");
});

function setup() {
  resetLiveSteps();
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const presence = { noteLocalActivity() {} } as unknown as PresenceMonitor;
  const config = { previewChars: 600 } as RelayConfig;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, steps });
  const rpc = createRpc({ db, events, registry, broker, presence, config } as unknown as RpcDeps);
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      { payload: { hook_event_name: event, session_id: "s1", cwd: CWD, ...fields }, env: {} },
      new AbortController().signal,
    );
  return { db, registry, rpc, seen, hook };
}
afterEach(() => resetLiveSteps());

test("a session the reconcile marks idle (no Stop) loses its live step everywhere", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "go" });
  await t.hook("PreToolUse", {
    tool_use_id: "a",
    tool_name: "Read",
    tool_input: { file_path: `${CWD}/a.ts` },
  });
  await t.hook("PostToolUse", {
    tool_use_id: "a",
    tool_name: "Read",
    tool_input: { file_path: `${CWD}/a.ts` },
  });
  t.registry.setStatus("s1", "idle", { keepUpdatedAt: true }); // what sweep()/reconcile() do
  const n = t.seen.length;
  await Bun.sleep(80);
  expect(t.seen.slice(n).filter((e) => e.type === "turn.step")).toEqual([]);
  const res = await t.rpc("session.live" as never, { sessionId: "s1" } as never, "device:x");
  const live = "result" in res ? (res.result as { step?: TurnStep } | null) : null;
  expect(live?.step).toBeUndefined();
  expect(
    (t.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'turn.step'").get() as { n: number }).n,
  ).toBe(0);
});

test("with a subagent's sidechain entries in the transcript, steps (+ stepsMore) still equal toolCalls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-steps-sidechain-"));
  try {
    const ts = (s: number) => new Date(1793620000000 + s * 1000).toISOString();
    const use = (id: string, name: string, input: object, s: number, extra = {}) => ({
      type: "assistant",
      timestamp: ts(s),
      ...extra,
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
    const lines = [
      { type: "user", timestamp: ts(0), message: { content: "Survey it" } },
      use("ag", "Agent", { description: "Survey" }, 1),
      use("s1", "Read", { file_path: `${CWD}/x.ts` }, 2, { isSidechain: true }),
      use("s2", "Grep", { pattern: "y" }, 3, { isSidechain: true }),
      { type: "assistant", timestamp: ts(4), message: { content: [{ type: "text", text: "Done." }] } },
    ];
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const t = setup();
    await t.hook("UserPromptSubmit", { prompt: "Survey it", transcript_path: path });
    await t.hook("Stop", { last_assistant_message: "Done.", transcript_path: path });
    const turn = (
      t.seen.findLast((e) => e.type === "turn.done") as Extract<RelayEvent, { type: "turn.done" }>
    ).turn;
    expect(turn.steps?.map((s) => s.label)).toEqual(["Ran an agent: Survey"]);
    expect((turn.steps?.length ?? 0) + (turn.stepsMore ?? 0)).toBe(turn.stats.toolCalls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the schema counts characters as people see them: an 80-emoji label is valid, 81 isn't", () => {
  expect(TurnStepSchema.safeParse({ kind: "other", label: "😀".repeat(80), at: 1 }).success).toBe(true);
  expect(TurnStepSchema.safeParse({ kind: "other", label: "👨‍👩‍👧‍👦".repeat(80), at: 1 }).success).toBe(true);
  expect(TurnStepSchema.safeParse({ kind: "other", label: "😀".repeat(81), at: 1 }).success).toBe(false);
});

test("a whole command is redacted before the cut, so a long token never shows a prefix", () => {
  const l = label("Bash", {
    command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://x.dev`,
  });
  expect(l).not.toContain("abcdefghij");
  expect(label("Grep", { pattern: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).not.toContain("sk-ant");
});

test(".. inside the project still shows the path inside it", () => {
  expect(label("Read", { file_path: `${CWD}/web/../server/src/cli.ts` })).toBe("Reading server/src/cli.ts");
  expect(label("Read", { file_path: "src/a.ts" })).toBe("Reading src/a.ts");
});

test("an ended session (SessionEnd-less, via the registry) loses its live step too", async () => {
  const t = setup();
  await t.hook("UserPromptSubmit", { prompt: "go" });
  t.registry.setStatus("s1", "ended");
  const res = await t.rpc("session.live" as never, { sessionId: "s1" } as never, "device:x");
  const live = "result" in res ? (res.result as { step?: TurnStep } | null) : null;
  expect(live?.step).toBeUndefined();
});

test("a label of many combining marks per character still fits the schema's storage guard", () => {
  // With 80 marks, 60 such characters are 4860 units, over the 4000-unit guard.
  for (const marks of [30, 80]) {
    const z = `e${"\u0301".repeat(marks)}`;
    const cases: [string, Record<string, unknown>][] = [
      ["Agent", { description: z.repeat(60) }],
      ["Bash", { command: `echo ${z.repeat(60)}` }],
      ["Read", { file_path: `/p/${z.repeat(80)}` }],
      [`mcp__${z.repeat(100)}__x`, {}],
      ["Grep", { pattern: z.repeat(40) }],
    ];
    for (const tense of ["live", "done"] as const)
      for (const [tool, input] of cases) {
        const s = stepFor(tool, input, "/p", tense);
        expect(TurnStepSchema.safeParse({ ...s, at: 1 }).success).toBe(true);
        expect(s.label.length).toBeLessThanOrEqual(4000);
        expect(s.label).not.toMatch(loneSurrogate);
        // Cut between characters: every accented "e" kept still has all its marks.
        const accented = [...new Intl.Segmenter().segment(s.label)].filter((g) => g.segment.length > 1);
        expect(accented.every((g) => g.segment === z)).toBe(true);
      }
  }
});

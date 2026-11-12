import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RelayEvent, RelayEvent as RelayEventSchema } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type HookEnvelope, HookHandler, notePhoneTyped } from "../src/daemon/hooks.ts";
import { type KeyOps, PHONE_PREFIX, STOP_MESSAGE } from "../src/daemon/inject.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import { type HookEnv, publicSession, Registry } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { resetLiveSteps, StepTracker } from "../src/daemon/steps.ts";
import { TurnStopper } from "../src/daemon/stop.ts";

/**
 * Questions answered at the Mac, and messages Claude Code adds itself:
 *  1. A message Claude Code adds itself (<task-notification>, <system-reminder>, <command-…>, <local-command…>)
 *     starts a turn with an empty prompt: no prompt text, no title, nothing of it in any event, not presence.
 *  2. An AskUserQuestion answered in the terminal closes as resolvedBy "mac" with what was picked as `outcome`,
 *     like a phone answer; anything else settled at the Mac still says "Answered on the Mac".
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLiveSteps();
});

let sessionCounter = 0;
/** notePhoneTyped is module state shared by every HookHandler: each test gets its own session IDs. */
const sid = (name = "s") => `mac-answers-${name}-${++sessionCounter}`;

function setup(opts: { dbPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-mac-answers-"));
  dirs.push(dir);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const db = openDb(opts.dbPath ?? ":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker: Broker = new Broker(db, events, (id) => {
    const s = registry.get(id);
    if (!s || s.status === "ended") return;
    if (broker.hasOpen(id)) {
      if (s.status !== "waiting") registry.setStatus(id, "waiting");
    } else if (s.status === "waiting") registry.setStatus(id, "working");
  });
  const seen: RelayEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const keyOps: KeyOps = {
    pty: async () => ({ ok: false, reason: "bad_request" }),
    tmux: async () => {},
    routes: () => [],
    app: async () => false,
    ttyOf: async () => null,
  } as unknown as KeyOps;
  const inboxSent: string[] = [];
  const config = { previewChars: 600, preferTyping: true } as RelayConfig;
  const steps = new StepTracker(events, { throttleMs: 0, thinkingDelayMs: 30 });
  const stopper = new TurnStopper({
    db,
    events,
    registry,
    broker,
    config,
    keys: keyOps,
    steps,
    inbox: async (_p: string, _t: string | null, text: string) => {
      inboxSent.push(text);
    },
    timing: { graceMs: 5, markerMs: 400, inboxMs: 300, pollMs: 20, repeatMs: 2000 },
    transcriptPath: () => transcript,
  });
  let localActivity = 0;
  const presence = {
    noteLocalActivity: () => {
      localActivity++;
    },
    get: () => ({ mode: "auto", present: true, idleSeconds: 0, locked: false }),
  } as unknown as PresenceMonitor;
  const hooks = new HookHandler({ db, events, registry, broker, presence, config, stopper, steps });
  const rpc = createRpc({
    db,
    events,
    registry,
    broker,
    presence,
    config,
    stopper,
    steps,
  } as unknown as RpcDeps);
  const call = async <T>(method: string, params: object): Promise<T> => {
    const out = (await rpc(method, params, "device:d1")) as { result?: T; error?: { message: string } };
    if (out.error) throw new Error(out.error.message);
    return out.result as T;
  };
  const hook = (event: string, sessionId: string, fields: Record<string, unknown> = {}, env: HookEnv = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: sessionId, cwd: dir, ...fields },
        env,
      } as HookEnvelope,
      new AbortController().signal,
    );
  /** A PermissionRequest hook that waits like the real one; resolves with what it would print. */
  const ask = (sessionId: string, toolName: string, toolInput: Record<string, unknown>) => {
    const ctl = new AbortController();
    const reply = hooks.handle(
      {
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: sessionId,
          cwd: dir,
          tool_name: toolName,
          tool_input: toolInput,
        },
        env: {},
      } as HookEnvelope,
      ctl.signal,
    );
    const prompt = broker.listOpen(sessionId).at(-1);
    if (!prompt) throw new Error("no prompt opened");
    return { prompt, reply, abort: () => ctl.abort() };
  };
  const recent = (promptId: string) => broker.listRecent(100).find((p) => p.id === promptId);
  const closedEvents = (promptId: string) =>
    seen.filter(
      (e): e is Extract<RelayEvent, { type: "prompt.closed" }> =>
        e.type === "prompt.closed" && e.promptId === promptId,
    );
  const startedPrompts = (sessionId: string) =>
    seen
      .filter((e) => e.type === "turn.started" && e.sessionId === sessionId)
      .map((e) => (e as { prompt: string }).prompt);
  return {
    db,
    events,
    registry,
    broker,
    stopper,
    rpc,
    call,
    hook,
    ask,
    recent,
    closedEvents,
    startedPrompts,
    seen,
    inboxSent,
    localActivity: () => localActivity,
  };
}

const INBOX: HookEnv = {
  socket: "/tmp/cc-socks/1.sock",
  token: "tok",
  claudePid: 4242,
  termProgram: "vscode",
};

const NOTIFICATION =
  '<task-notification>\n<task-id>b7e1c0</task-id>\n<tool-use-id>toolu_01ABC</tool-use-id>\n<status>completed</status>\n<summary>Background command "bun test" completed</summary>\n</task-notification>';

/** One question, as Claude Code's AskUserQuestion sends it. */
const QUESTION = {
  questions: [
    {
      question: "Which steps view?",
      header: "Steps",
      multiSelect: false,
      options: [{ label: "Live line" }, { label: "Timeline" }],
    },
  ],
};
const TWO_QUESTIONS = {
  questions: [
    {
      question: "Which steps view?",
      header: "Steps",
      options: [{ label: "Live line" }, { label: "Timeline" }],
    },
    {
      question: "Which controls?",
      header: "Controls",
      multiSelect: true,
      options: [{ label: "Stop button" }, { label: "Pause" }, { label: "Retry" }],
    },
  ],
};

/** PostToolUse of an AskUserQuestion answered in the terminal, in the shape Claude Code sends. */
const answeredAtMac = (answers: unknown, extra: Record<string, unknown> = {}) => ({
  tool_name: "AskUserQuestion",
  tool_input: { ...QUESTION, answers },
  tool_response: { questions: QUESTION.questions, answers },
  ...extra,
});

// ---------------------------------------------------------------------------------------------------
// 1. Messages Claude Code adds itself
// ---------------------------------------------------------------------------------------------------

describe("a message Claude Code adds itself: every kind", () => {
  const SYSTEM = {
    "a background task's notification": NOTIFICATION,
    "a system reminder": "<system-reminder>\nThe user hasn't heard from you in a while.\n</system-reminder>",
    "a system reminder with attributes": '<system-reminder id="r1">Today is Wednesday.</system-reminder>',
    "a slash command's echo":
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
    "a slash command's arguments first":
      "<command-args>--force</command-args><command-name>/x</command-name>",
    "a local command's output": "<local-command-stdout>Compacted.</local-command-stdout>",
    "a local command's caveat": "<local-command-caveat>Caveat: the messages below…</local-command-caveat>",
    "after blank lines and tabs": "\n\n\t  <task-notification><status>killed</status></task-notification>",
    "with Windows line endings":
      "\r\n<task-notification>\r\n<status>failed</status>\r\n</task-notification>\r\n",
    "after the IDE's opened-file block": `<ide_opened_file>The user opened /repo/a.ts in the IDE.</ide_opened_file>\n${NOTIFICATION}`,
    "after two IDE blocks": `<ide_opened_file>a.ts</ide_opened_file>\n<ide_selection>let x = 1</ide_selection>\n\n${NOTIFICATION}`,
  } as const;

  for (const [name, prompt] of Object.entries(SYSTEM)) {
    test(`${name}: empty prompt, no title, no presence, nothing of it anywhere`, async () => {
      const s = setup();
      const id = sid();
      await s.hook("SessionStart", id);
      await s.hook("UserPromptSubmit", id, { prompt });
      expect(s.startedPrompts(id)).toEqual([""]);
      expect((await s.call<{ prompt: string } | null>("session.live", { sessionId: id }))?.prompt).toBe("");
      expect(s.registry.get(id)?.title ?? null).toBeNull();
      expect(s.registry.get(id)?.status).toBe("working");
      expect(s.localActivity()).toBe(0);
      const all = JSON.stringify(s.seen);
      for (const word of [
        "task-notification",
        "system-reminder",
        "command-",
        "b7e1c0",
        "Compacted",
        "--force",
      ])
        expect(all).not.toContain(word);
    });
  }
});

describe("a typed prompt that only looks like one", () => {
  const TYPED = {
    "mentions the tag in the middle": "what does <task-notification> mean in the transcript?",
    "starts with text, the tag on the next line": "look at this:\n<task-notification>x</task-notification>",
    "a quoted tag": "> <system-reminder>",
    "a tag-like word without the dash": "<commandline> parsing is broken",
    "a backticked tag": "`<task-notification>` blocks show up as bubbles",
    "IDE context, then the tag in a sentence":
      "<ide_selection>x</ide_selection>\nwhy is <system-reminder> here?",
  } as const;
  for (const [name, prompt] of Object.entries(TYPED)) {
    test(`${name}: shown, titled and counted as presence`, async () => {
      const s = setup();
      const id = sid();
      await s.hook("UserPromptSubmit", id, { prompt });
      const shown = s.startedPrompts(id)[0] ?? "";
      expect(shown).not.toBe("");
      expect(shown).toContain(prompt.includes("<ide_") ? "why is <system-reminder> here?" : prompt.trim());
      expect(s.registry.get(id)?.title ?? "").not.toBe("");
      expect(s.localActivity()).toBe(1);
    });
  }
});

describe("a message Claude Code adds itself: state around it", () => {
  test("the title stays the one from the first typed prompt", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: "Run the checks" });
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION });
    expect(s.registry.get(id)?.title).toBe("Run the checks");
  });

  test("a notification first, then a typed prompt: the typed prompt gives the title", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION });
    await s.hook("UserPromptSubmit", id, { prompt: "Now fix the failing test" });
    expect(s.registry.get(id)?.title).toBe("Now fix the failing test");
    const session = s.registry.get(id);
    if (!session) throw new Error("no session");
    const pub = publicSession(session);
    expect(JSON.stringify(pub)).not.toContain("task-notification");
    expect(s.startedPrompts(id)).toEqual(["", "Now fix the failing test"]);
    expect(s.localActivity()).toBe(1);
  });

  test("two notifications in a row: one empty turn (the second is taken in mid-turn), still no presence", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION });
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION.replace("completed", "killed") });
    // A notice while a turn runs (no Stop yet) belongs to that turn (midturn-notice.test.ts).
    expect(s.startedPrompts(id)).toEqual([""]);
    expect(s.localActivity()).toBe(0);
  });

  test("its turn ends normally: the finished turn has no prompt text and every event is valid", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: "Run the checks" });
    await s.hook("Stop", id, { last_assistant_message: "Started them.", background_tasks: [] });
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION });
    await s.hook("Stop", id, { last_assistant_message: "The checks passed.", background_tasks: [] });
    const turns = await s.call<{ prompt: string | null; summary: string }[]>("session.turns", {
      sessionId: id,
      limit: 20,
    });
    expect(turns.map((t) => t.summary)).toEqual(["The checks passed.", "Started them."]);
    expect(turns[0]?.prompt ?? "").toBe("");
    expect(turns[1]?.prompt).toBe("Run the checks");
    // An older app decodes every event as before: turn.started keeps a string prompt (empty), nothing new.
    for (const e of s.seen) expect(() => RelayEventSchema.parse(e)).not.toThrow();
    expect(JSON.stringify(s.seen)).not.toContain("task-notification");
  }, 5000);

  test("a secret inside a notification never leaves the Mac", async () => {
    const s = setup();
    const id = sid();
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await s.hook("UserPromptSubmit", id, {
      prompt: `<task-notification><summary>printed ${secret}</summary></task-notification>`,
    });
    expect(JSON.stringify(s.seen)).not.toContain("sk-ant");
    const row = s.db.query("SELECT prompt FROM turns WHERE session_id = ?").get(id) as { prompt: string };
    expect(row.prompt).toBe("");
  });

  test("an open question is still settled by it, as 'Answered on the Mac', and its hook is released", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: "Plan the release" });
    const q = s.ask(id, "AskUserQuestion", QUESTION);
    expect(s.registry.get(id)?.status).toBe("waiting");
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION });
    expect(await q.reply).toEqual({ stdout: "" });
    expect(s.recent(q.prompt.id)).toMatchObject({ resolvedBy: "mac", outcome: "Answered on the Mac" });
    expect(s.broker.hasOpen(id)).toBe(false);
    expect(s.registry.get(id)?.status).toBe("working");
  });

  test("an open permission is still settled by it too", async () => {
    const s = setup();
    const id = sid();
    const p = s.ask(id, "Bash", { command: "rm -rf build" });
    await s.hook("UserPromptSubmit", id, { prompt: "<system-reminder>x</system-reminder>" });
    expect(await p.reply).toEqual({ stdout: "" });
    expect(s.recent(p.prompt.id)?.resolvedBy).toBe("mac");
  });

  test("a phone-typed message still pending: the notification doesn't use it up, the phone's text is still the phone's", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: "Rewrite the checkout" });
    expect(s.localActivity()).toBe(1);
    notePhoneTyped(id, "and add tests for the cart");
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION });
    expect(s.localActivity()).toBe(1);
    await s.hook("UserPromptSubmit", id, { prompt: "and add tests for the cart" });
    expect(s.localActivity()).toBe(1);
    // The notification arrives while "Rewrite the checkout" runs, so it's part of that turn (midturn-notice.test.ts).
    expect(s.startedPrompts(id)).toEqual(["Rewrite the checkout", "and add tests for the cart"]);
  });

  test("the phone's inbox Stop still pending: a notification before the stop message doesn't spend it", async () => {
    const s = setup();
    const id = sid();
    await s.hook("SessionStart", id, {}, INBOX);
    await s.hook("UserPromptSubmit", id, { prompt: "Rewrite the checkout" }, INBOX);
    const before = s.localActivity();
    const stop = s.rpc("session.interrupt", { sessionId: id }, "device:d1");
    await Bun.sleep(20);
    expect(s.inboxSent).toEqual([STOP_MESSAGE]);
    await s.hook("UserPromptSubmit", id, { prompt: NOTIFICATION }, INBOX);
    await s.hook(
      "UserPromptSubmit",
      id,
      { prompt: `Another Claude session sent a message:\n${STOP_MESSAGE}` },
      INBOX,
    );
    const out = (await stop) as { result?: { via: string } };
    expect(out.result?.via).toBe("inbox");
    // Neither the notification nor the helper's own stop message is you at the Mac.
    expect(s.localActivity()).toBe(before);
  });

  test("a phone message through the inbox (peer header) is not mistaken for one", async () => {
    const s = setup();
    const id = sid();
    await s.hook(
      "UserPromptSubmit",
      id,
      { prompt: `Another Claude session sent a message:\n${PHONE_PREFIX}\nyes do it` },
      INBOX,
    );
    expect(s.startedPrompts(id)[0]).toContain("yes do it");
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. A question answered in the terminal
// ---------------------------------------------------------------------------------------------------

describe("a question answered at the Mac: what was picked", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["one option", { "Which steps view?": "Live line" }, "Live line"],
    [
      "two questions, in order",
      { "Which steps view?": "Timeline", "Which controls?": "Stop button" },
      "Timeline · Stop button",
    ],
    [
      "multi-select kept as Claude Code joined it",
      { "Which steps view?": "Live line", "Which controls?": "Stop button, Retry" },
      "Live line · Stop button, Retry",
    ],
    [
      "free text (Other)",
      { "Which steps view?": "Neither, show a progress bar" },
      "Neither, show a progress bar",
    ],
    ["Cyrillic", { "Which steps view?": "Живая строка" }, "Живая строка"],
    ["right-to-left", { "Which steps view?": "خط مباشر" }, "خط مباشر"],
    ["emoji and combining marks", { "Which steps view?": "👍🏽 café" }, "👍🏽 café"],
    [
      "an empty answer next to a real one is left out",
      { a: "", "Which steps view?": "Live line" },
      "Live line",
    ],
    ["text that looks like markup", { q: "<script>alert(1)</script>" }, "<script>alert(1)</script>"],
  ];
  for (const [name, answers, outcome] of cases) {
    test(`${name}: "${outcome}"`, async () => {
      const s = setup();
      const id = sid();
      const q = s.ask(id, "AskUserQuestion", TWO_QUESTIONS);
      await s.hook("PostToolUse", id, answeredAtMac(answers));
      expect(await q.reply).toEqual({ stdout: "" });
      expect(s.recent(q.prompt.id)).toMatchObject({ resolvedBy: "mac", outcome });
      expect(s.closedEvents(q.prompt.id)).toEqual([expect.objectContaining({ resolvedBy: "mac", outcome })]);
      expect(s.registry.get(id)?.status).toBe("working");
    });
  }

  test("same words as the phone's answer for the same picks", async () => {
    const s = setup();
    const answers = { "Which steps view?": "Timeline", "Which controls?": "Stop button, Retry" };
    const atMac = s.ask(sid(), "AskUserQuestion", TWO_QUESTIONS);
    await s.hook("PostToolUse", atMac.prompt.sessionId, answeredAtMac(answers));
    const onPhone = s.ask(sid(), "AskUserQuestion", TWO_QUESTIONS);
    await s.call("prompt.answer", { promptId: onPhone.prompt.id, answer: { kind: "question", answers } });
    expect(s.recent(atMac.prompt.id)?.outcome).toBe(s.recent(onPhone.prompt.id)?.outcome as string);
    expect(s.recent(onPhone.prompt.id)?.resolvedBy).toBe("phone");
  });

  test("exactly 80 characters is kept whole; 81 is clipped to 80 with an ellipsis, like the phone's", async () => {
    const s = setup();
    const eighty = "a".repeat(80);
    const q1 = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q1.prompt.sessionId, answeredAtMac({ q: eighty }));
    expect(s.recent(q1.prompt.id)?.outcome).toBe(eighty);
    const q2 = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q2.prompt.sessionId, answeredAtMac({ q: `${eighty}b` }));
    const clipped = s.recent(q2.prompt.id)?.outcome ?? "";
    expect(clipped).toHaveLength(80);
    expect(clipped.endsWith("…")).toBe(true);
    const q3 = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.call("prompt.answer", {
      promptId: q3.prompt.id,
      answer: { kind: "question", answers: { "Which steps view?": `${eighty}b` } },
    });
    expect(s.recent(q3.prompt.id)?.outcome).toBe(clipped);
  });

  test("a very long typed answer with line breaks is clipped, the hook still released", async () => {
    const s = setup();
    const q = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q.prompt.sessionId, answeredAtMac({ q: `${"word ".repeat(2000)}\nend` }));
    expect(await q.reply).toEqual({ stdout: "" });
    expect((s.recent(q.prompt.id)?.outcome ?? "").length).toBeLessThanOrEqual(80);
  });

  test("the picks survive a helper restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mac-answers-db-"));
    dirs.push(dir);
    const dbPath = join(dir, "relay.db");
    const s = setup({ dbPath });
    const q = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q.prompt.sessionId, answeredAtMac({ q: "Timeline" }));
    s.db.close();
    const db = openDb(dbPath);
    const after = new Broker(db, new EventLog(db)).listRecent(10).find((p) => p.id === q.prompt.id);
    expect(after).toMatchObject({ resolvedBy: "mac", outcome: "Timeline" });
    db.close();
  });

  test("the question's raw input is still dropped once it's settled", async () => {
    const s = setup();
    const q = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q.prompt.sessionId, answeredAtMac({ q: "Timeline" }));
    const row = s.db.query("SELECT tool_input FROM prompts WHERE id = ?").get(q.prompt.id) as {
      tool_input: string;
    };
    expect(row.tool_input).toBe("{}");
  });

  test("the prompt.closed event an older app decodes has only the fields it knows", async () => {
    const s = setup();
    const q = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q.prompt.sessionId, answeredAtMac({ q: "Timeline" }));
    const [closed] = s.closedEvents(q.prompt.id);
    expect(() => RelayEventSchema.parse(closed)).not.toThrow();
    expect(Object.keys(closed ?? {}).sort()).toEqual([
      "outcome",
      "promptId",
      "resolvedBy",
      "seq",
      "ts",
      "type",
    ]);
  });
});

describe("a question answered at the Mac: where the picks come from", () => {
  const outcomeFor = async (post: Record<string, unknown>) => {
    const s = setup();
    const q = s.ask(sid(), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", q.prompt.sessionId, { tool_name: "AskUserQuestion", ...post });
    expect(await q.reply).toEqual({ stdout: "" });
    return s.recent(q.prompt.id);
  };

  test("the result's answers win over the input's", async () => {
    const r = await outcomeFor({
      tool_input: { ...QUESTION, answers: { q: "From input" } },
      tool_response: { answers: { q: "From result" } },
    });
    expect(r?.outcome).toBe("From result");
  });

  test("the result has empty answers: the input's are used", async () => {
    for (const answers of [{}, { q: "" }, { q: "   " }, { q: 3 }]) {
      const r = await outcomeFor({
        tool_input: { ...QUESTION, answers: { q: "From input" } },
        tool_response: { answers },
      });
      expect(r?.outcome).toBe("From input");
    }
  });

  test("the result is text, null or missing: the input's are used", async () => {
    for (const tool_response of ["User has answered your questions: …", null, undefined, 42, ["x"]]) {
      const r = await outcomeFor({
        tool_input: { ...QUESTION, answers: { q: "From input" } },
        tool_response,
      });
      expect(r?.outcome).toBe("From input");
    }
  });

  test("no usable answers anywhere: 'Answered on the Mac', still resolved by the Mac", async () => {
    for (const answers of [
      undefined,
      null,
      "Live line",
      ["Live line"],
      7,
      {},
      { q: null },
      { q: { label: "x" } },
    ]) {
      const r = await outcomeFor({ tool_input: { ...QUESTION, answers }, tool_response: { answers } });
      expect(r).toMatchObject({ resolvedBy: "mac", outcome: "Answered on the Mac" });
    }
  });

  test("no tool_input at all", async () => {
    const r = await outcomeFor({ tool_response: { answers: { q: "Timeline" } } });
    expect(r?.outcome).toBe("Timeline");
  });

  test("the terminal dialog dismissed (the hook aborted): 'Answered on the Mac'", async () => {
    const s = setup();
    const q = s.ask(sid(), "AskUserQuestion", QUESTION);
    q.abort();
    await q.reply;
    expect(s.recent(q.prompt.id)).toMatchObject({ resolvedBy: "mac", outcome: "Answered on the Mac" });
  });
});

describe("other prompts and other sources", () => {
  test("a plan approved at the Mac still says 'Answered on the Mac', even with answers in its result", async () => {
    const s = setup();
    const id = sid();
    const p = s.ask(id, "ExitPlanMode", { plan: "1. Do it" });
    await s.hook("PostToolUse", id, {
      tool_name: "ExitPlanMode",
      tool_input: { plan: "1. Do it" },
      tool_response: { answers: { q: "Approve" }, plan: "1. Do it" },
    });
    expect(await p.reply).toEqual({ stdout: "" });
    expect(s.recent(p.prompt.id)).toMatchObject({ resolvedBy: "mac", outcome: "Answered on the Mac" });
  });

  test("a permission allowed at the Mac still says 'Answered on the Mac', even with answers in its input", async () => {
    const s = setup();
    const id = sid();
    const input = { command: "ls", answers: { q: "Yes" } };
    const p = s.ask(id, "Bash", input);
    await s.hook("PostToolUse", id, {
      tool_name: "Bash",
      tool_input: input,
      tool_response: { stdout: "a\nb", answers: { q: "Yes" } },
    });
    expect(s.recent(p.prompt.id)).toMatchObject({ resolvedBy: "mac", outcome: "Answered on the Mac" });
  });

  test("answered from the phone first: a late PostToolUse with other picks changes nothing", async () => {
    const s = setup();
    const id = sid();
    const q = s.ask(id, "AskUserQuestion", QUESTION);
    await s.call("prompt.answer", {
      promptId: q.prompt.id,
      answer: { kind: "question", answers: { "Which steps view?": "Live line" } },
    });
    await s.hook("PostToolUse", id, answeredAtMac({ "Which steps view?": "Timeline" }));
    expect(s.recent(q.prompt.id)).toMatchObject({ resolvedBy: "phone", outcome: "Live line" });
    expect(s.closedEvents(q.prompt.id)).toHaveLength(1);
  });

  test("answered at the Mac first: the phone's late answer is a conflict and the picks stay", async () => {
    const s = setup();
    const id = sid();
    const q = s.ask(id, "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", id, answeredAtMac({ "Which steps view?": "Timeline" }));
    const late = (await s.rpc(
      "prompt.answer",
      { promptId: q.prompt.id, answer: { kind: "question", answers: { "Which steps view?": "Live line" } } },
      "device:d1",
    )) as { error?: { code: string } };
    expect(late.error?.code).toBe("conflict");
    expect(s.recent(q.prompt.id)).toMatchObject({ resolvedBy: "mac", outcome: "Timeline" });
  });

  test("the same PostToolUse twice: one prompt.closed", async () => {
    const s = setup();
    const id = sid();
    const q = s.ask(id, "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", id, answeredAtMac({ q: "Timeline" }));
    await s.hook("PostToolUse", id, answeredAtMac({ q: "Live line" }));
    expect(s.closedEvents(q.prompt.id)).toHaveLength(1);
    expect(s.recent(q.prompt.id)?.outcome).toBe("Timeline");
  });

  test("another session's PostToolUse doesn't close this session's question", async () => {
    const s = setup();
    const q = s.ask(sid("a"), "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", sid("b"), answeredAtMac({ q: "Timeline" }));
    expect(s.broker.hasOpen(q.prompt.sessionId)).toBe(true);
    expect(s.closedEvents(q.prompt.id)).toHaveLength(0);
  });

  test("a question answered at the Mac isn't presence at the Mac by itself (no change to presence)", async () => {
    const s = setup();
    const id = sid();
    const q = s.ask(id, "AskUserQuestion", QUESTION);
    await s.hook("PostToolUse", id, answeredAtMac({ q: "Timeline" }));
    await q.reply;
    expect(s.localActivity()).toBe(0);
  });

  test("the phone's Stop on a question still says 'Stopped'", async () => {
    const s = setup();
    const id = sid();
    await s.hook("UserPromptSubmit", id, { prompt: "Plan it" });
    const q = s.ask(id, "AskUserQuestion", QUESTION);
    await s.rpc("session.interrupt", { sessionId: id }, "device:d1");
    expect(s.recent(q.prompt.id)).toMatchObject({ resolvedBy: "phone", outcome: "Stopped" });
  });
});

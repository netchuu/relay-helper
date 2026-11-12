import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Prompt, RelayEvent, Session } from "../../protocol/index.ts";

/**
 * Questions answered at the Mac and messages Claude Code adds itself, over the real daemon and the real hook client:
 * a question answered in the terminal keeps its picks, and a system reminder through UserPromptSubmit leaves nothing
 * behind. Like integration.test.ts, the home lives under a short /tmp path for the Unix socket limit, and `claude` is
 * /usr/bin/false.
 */
const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const HOME = join(ROOT, `relay-ma-${process.pid}`);
const PORT = 20000 + ((process.pid + 4241) % 20000);
const REPO = resolve(import.meta.dir, "../..");
const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}
const SOCK = join(HOME, "hook.sock");
let daemon: ReturnType<typeof Bun.spawn> | null = null;

async function runHook(payload: object) {
  const proc = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    env,
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

async function admin<T>(method: string, params: object = {}): Promise<T> {
  const res = await fetch("http://relay/admin/rpc", {
    method: "POST",
    unix: SOCK,
    body: JSON.stringify({ method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting");
}

const base = (event: string, sessionId: string) => ({
  session_id: sessionId,
  hook_event_name: event,
  cwd: REPO,
  transcript_path: "/nonexistent.jsonl",
});

const QUESTIONS = [
  { question: "Which steps view?", header: "Steps", multiSelect: false, options: [{ label: "Live line" }] },
  { question: "Which controls?", header: "Controls", multiSelect: true, options: [{ label: "Stop" }] },
];

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: PORT, claudeBin: "/usr/bin/false", preferTyping: false }),
  );
  daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(() => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok));
});

afterAll(async () => {
  daemon?.kill();
  await daemon?.exited;
  rmSync(HOME, { recursive: true, force: true });
});

describe("answered at the Mac, over the real hook client", () => {
  test("the waiting hook prints nothing, the history and the event keep the picks", async () => {
    const id = "ma-sess-1";
    await runHook({ ...base("UserPromptSubmit", id), prompt: "Plan the live view" });
    const { latestSeq } = await admin<{ latestSeq: number }>("sync", { sinceSeq: 0 });
    const waiting = runHook({
      ...base("PermissionRequest", id),
      tool_name: "AskUserQuestion",
      tool_input: { questions: QUESTIONS },
    });
    const prompt = await waitFor(async () =>
      (await admin<Prompt[]>("prompts.open")).find((p) => p.sessionId === id),
    );
    const answers = { "Which steps view?": "Live line", "Which controls?": "Stop, Pause" };
    await runHook({
      ...base("PostToolUse", id),
      tool_name: "AskUserQuestion",
      tool_input: { questions: QUESTIONS, answers },
      tool_response: { questions: QUESTIONS, answers },
      tool_use_id: "toolu_q1",
    });
    expect(await waiting).toEqual({ stdout: "", code: 0 });
    const recent = await admin<Prompt[]>("prompts.recent", { limit: 10 });
    expect(recent.find((p) => p.id === prompt.id)).toMatchObject({
      resolvedBy: "mac",
      outcome: "Live line · Stop, Pause",
    });
    const sync = await admin<{ events: RelayEvent[] }>("sync", { sinceSeq: latestSeq });
    expect(sync.events.filter((e) => e.type === "prompt.closed")).toEqual([
      expect.objectContaining({ promptId: prompt.id, resolvedBy: "mac", outcome: "Live line · Stop, Pause" }),
    ]);
    const session = (await admin<Session[]>("sessions.list")).find((s) => s.id === id);
    expect(session?.status).toBe("working");
  }, 20000);

  test("a system reminder after the IDE's context: an empty live prompt, no title, nothing in the events", async () => {
    const id = "ma-sess-2";
    const { latestSeq } = await admin<{ latestSeq: number }>("sync", { sinceSeq: 0 });
    await runHook({
      ...base("UserPromptSubmit", id),
      prompt:
        "<ide_opened_file>a.ts</ide_opened_file>\n<system-reminder>\nToday is Wednesday.\n</system-reminder>",
    });
    expect((await admin<{ prompt: string } | null>("session.live", { sessionId: id }))?.prompt).toBe("");
    const sync = await admin<{ events: RelayEvent[] }>("sync", { sinceSeq: latestSeq });
    expect(JSON.stringify(sync.events)).not.toContain("Wednesday");
    const session = (await admin<Session[]>("sessions.list")).find((s) => s.id === id);
    expect(session?.title ?? null).toBeNull();
  }, 20000);
});

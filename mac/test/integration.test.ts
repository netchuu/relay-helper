import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import type { Prompt, RelayEvent, Session } from "../../protocol/index.ts";

/**
 * End-to-end: the real daemon process and the real hook client, talking over the real sockets.
 * Unix socket paths are limited to 104 bytes on macOS, so the test home lives under a short /tmp path
 * (override with RELAY_TEST_ROOT).
 */
const ROOT = process.env.RELAY_TEST_ROOT ?? "/tmp";
const HOME = join(ROOT, `relay-it-${process.pid}`);
const PORT = 20000 + (process.pid % 20000);
const REPO = resolve(import.meta.dir, "../..");
// Never inherit the developer's own Claude Code session variables: a leaked
// CLAUDE_CODE_MESSAGING_SOCKET would deliver test messages into the real session running the tests.
const env: Record<string, string> = { RELAY_HOME: HOME, RELAY_LOG_LEVEL: "warn" };
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith("CLAUDE") && !k.startsWith("ANTHROPIC") && !(k in env)) env[k] = v;
}
const SOCK = join(HOME, "hook.sock");
let daemon: ReturnType<typeof Bun.spawn> | null = null;

async function runHook(payload: object, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    env: { ...env, ...extraEnv },
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

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting");
}

const base = (event: string, sessionId = "sess-1") => ({
  session_id: sessionId,
  hook_event_name: event,
  cwd: REPO,
  transcript_path: "/nonexistent.jsonl",
});

beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  // /usr/bin/false makes `claude agents --json` fail, so the test never imports your real sessions;
  // preferTyping: false so it can never type into a real terminal window.
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ port: PORT, claudeBin: "/usr/bin/false", preferTyping: false }),
  );
});

afterAll(() => {
  daemon?.kill();
  rmSync(HOME, { recursive: true, force: true });
});

describe("relay end to end", () => {
  test("hook client fails open when the daemon is down", async () => {
    const t0 = Date.now();
    const res = await runHook({
      ...base("PermissionRequest"),
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("daemon starts", async () => {
    daemon = Bun.spawn(["bun", join(REPO, "mac/src/cli.ts"), "daemon"], {
      env,
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitFor(() => fetch("http://relay/health", { unix: SOCK }).then((r) => r.ok));
    expect(await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok)).toBe(true);
  });

  let inbox: Server;
  const received: string[] = [];
  const inboxPath = join(HOME, "inbox.sock");

  test("SessionStart registers the session with its inbox socket", async () => {
    inbox = createServer((c) => c.on("data", (d) => received.push(d.toString())));
    await new Promise<void>((r) => inbox.listen(inboxPath, r));
    await runHook(base("SessionStart"), {
      CLAUDE_CODE_MESSAGING_SOCKET: inboxPath,
      CLAUDE_CODE_MESSAGING_TOKEN: "tok-123",
      TERM_PROGRAM: "iTerm.app",
    });
    const sessions = await admin<Session[]>("sessions.list");
    const s = sessions.find((x) => x.id === "sess-1");
    expect(s?.canReceive).toBe(true);
    expect(s?.terminal).toBe("iTerm.app");
    expect(JSON.stringify(sessions)).not.toContain("tok-123"); // tokens never leave the daemon
  });

  test("RELAY_INTERNAL processes are ignored", async () => {
    await runHook(base("SessionStart", "internal-1"), { RELAY_INTERNAL: "1" });
    const sessions = await admin<Session[]>("sessions.list");
    expect(sessions.some((s) => s.id === "internal-1")).toBe(false);
  });

  test("a question waits for the phone and gets the answer back", async () => {
    const questions = [
      { question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] },
    ];
    const hook = runHook({
      ...base("PermissionRequest"),
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    });
    const prompt = await waitFor(async () => (await admin<Prompt[]>("prompts.open"))[0]);
    expect(prompt.kind).toBe("question");
    const session = (await admin<Session[]>("sessions.list")).find((s) => s.id === "sess-1");
    expect(session?.status).toBe("waiting");

    await admin("prompt.answer", {
      promptId: prompt.id,
      answer: { kind: "question", answers: { "Which color?": "Teal" } },
    });
    const { stdout, code } = await hook;
    expect(code).toBe(0);
    const decision = JSON.parse(stdout).hookSpecificOutput.decision;
    expect(decision.updatedInput.answers).toEqual({ "Which color?": "Teal" });
    expect(await admin<Prompt[]>("prompts.open")).toEqual([]);
  });

  test("a prompt answered at the Mac releases the hook silently", async () => {
    const input = { command: "npm publish" };
    const hook = runHook({ ...base("PermissionRequest"), tool_name: "Bash", tool_input: input });
    const prompt = await waitFor(async () => (await admin<Prompt[]>("prompts.open"))[0]);
    await runHook({ ...base("PostToolUse"), tool_name: "Bash", tool_input: input, tool_use_id: "toolu_1" });
    const { stdout } = await hook;
    expect(stdout).toBe("");
    const late = await admin("prompt.answer", {
      promptId: prompt.id,
      answer: { kind: "permission", action: "deny" },
    }).catch((e: Error) => e.message);
    expect(String(late)).toContain("already closed (mac)");
  });

  test("a prompt answered No or Esc at the Mac closes when Claude Code stops the waiting hook", async () => {
    // Claude Code ends the hook process when the dialog is answered in the terminal. After No, Esc or plan
    // feedback no other hook event follows, so that is the only sign the prompt is settled.
    const sessionId = "sess-killed";
    const proc = Bun.spawn(["bun", join(REPO, "mac/src/hook/client.ts")], {
      stdin: new Blob([
        JSON.stringify({
          ...base("PermissionRequest", sessionId),
          tool_name: "Bash",
          tool_input: { command: "rm -rf build" },
        }),
      ]),
      stdout: "pipe",
      env,
    });
    const prompt = await waitFor(async () =>
      (await admin<Prompt[]>("prompts.open")).find((p) => p.sessionId === sessionId),
    );
    proc.kill();
    await proc.exited;
    await waitFor(async () => !(await admin<Prompt[]>("prompts.open")).some((p) => p.id === prompt.id));
    const session = (await admin<Session[]>("sessions.list")).find((s) => s.id === sessionId);
    expect(session?.status).not.toBe("waiting");
    // An answer from the phone after that is refused, not silently dropped.
    const late = await admin("prompt.answer", {
      promptId: prompt.id,
      answer: { kind: "permission", action: "allow" },
    }).catch((e: Error) => e.message);
    expect(String(late)).toContain("already closed (mac)");
  });

  test("turns: prompt -> Stop produces a compact, redacted summary", async () => {
    await runHook({ ...base("UserPromptSubmit"), prompt: "Fix the login bug" });
    // The prompt is visible while Claude works, before any answer exists.
    const live = await admin<{ prompt: string; turnId: string } | null>("session.live", {
      sessionId: "sess-1",
    });
    expect(live?.prompt).toBe("Fix the login bug");
    const started = await admin<{ events: { type: string; turnId?: string; prompt?: string }[] }>("sync", {
      sinceSeq: 1,
    });
    expect(started.events.some((e) => e.type === "turn.started" && e.turnId === live?.turnId)).toBe(true);
    const long = `Fixed the login bug.\n\nKey: sk-ant-api03-${"a".repeat(30)}\n\n${"details ".repeat(200)}`;
    await runHook({ ...base("Stop"), last_assistant_message: long, background_tasks: [] });
    const turns = await admin<{ summary: string; truncated: boolean; prompt: string; id: string }[]>(
      "session.turns",
      {
        sessionId: "sess-1",
      },
    );
    expect(turns[0]?.prompt).toBe("Fix the login bug");
    expect(turns[0]?.truncated).toBe(true);
    expect(turns[0]?.summary).toContain("Fixed the login bug.");
    expect(turns[0]?.summary).not.toContain("sk-ant");
    const full = await admin<{ text: string }>("turn.full", { turnId: turns[0]?.id });
    expect(full.text.length).toBeGreaterThan(1000);
    expect(full.text).toContain("[redacted:anthropic-key]");
    expect(await admin("session.live", { sessionId: "sess-1" })).toBeNull();
  });

  test("a background task's notification starts a turn without a bubble, a title or presence", async () => {
    const id = "sess-notify";
    await runHook({ ...base("UserPromptSubmit", id), prompt: "Run the checks" });
    await runHook({ ...base("Stop", id), last_assistant_message: "Started them.", background_tasks: [] });
    await runHook({
      ...base("UserPromptSubmit", id),
      prompt: "<task-notification>\n<task-id>a60f</task-id>\n<status>killed</status>\n</task-notification>",
    });
    const live = await admin<{ prompt: string } | null>("session.live", { sessionId: id });
    expect(live?.prompt).toBe("");
    const sync = await admin<{ events: { type: string; sessionId?: string; prompt?: string }[] }>("sync", {
      sinceSeq: 1,
    });
    const started = sync.events.filter((e) => e.type === "turn.started" && e.sessionId === id);
    expect(started.map((e) => e.prompt)).toEqual(["Run the checks", ""]);
    expect(JSON.stringify(sync.events)).not.toContain("task-notification");
    const session = (await admin<Session[]>("sessions.list")).find((s) => s.id === id);
    expect(session?.status).toBe("working");
    expect(session?.title ?? "").not.toContain("task-notification");
    await runHook({
      ...base("Stop", id),
      last_assistant_message: "The checks stopped.",
      background_tasks: [],
    });
    const turns = await admin<{ prompt: string | null; summary: string }[]>("session.turns", {
      sessionId: id,
    });
    expect(turns.map((t) => t.prompt ?? "").join("|")).not.toContain("task-notification");
  });

  test("free text reaches the session inbox with the auth line and provenance", async () => {
    const res = await admin<{ via: string }>("session.send", {
      sessionId: "sess-1",
      text: "Also add a test",
    });
    expect(res.via).toBe("socket");
    const data = await waitFor(async () => received.join(""));
    const [auth, msg] = data
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(auth).toEqual({ type: "auth", token: "tok-123" });
    expect(msg.type).toBe("user");
    expect(msg.message.content).toContain("from their phone");
    expect(msg.message.content).toContain("Also add a test");
    inbox.close();
  });

  test("app API: pairing, auth, WebSocket events and RPC", async () => {
    const app = `http://127.0.0.1:${PORT}`;
    expect((await fetch(`${app}/rpc`, { method: "POST", body: "{}" })).status).toBe(401);

    const { code } = (await fetch("http://relay/admin/pair", { method: "POST", unix: SOCK }).then((r) =>
      r.json(),
    )) as {
      code: string;
    };
    expect(
      (await fetch(`${app}/pair`, { method: "POST", body: JSON.stringify({ code: "WRONG123" }) })).status,
    ).toBe(401);
    const paired = (await fetch(`${app}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: `${code.slice(0, 4)}-${code.slice(4)}`, deviceName: "Test iPhone" }),
    }).then((r) => r.json())) as { token: string };
    expect(paired.token.length).toBeGreaterThan(30);
    // Codes are single-use.
    expect((await fetch(`${app}/pair`, { method: "POST", body: JSON.stringify({ code }) })).status).toBe(401);

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: { authorization: `Bearer ${paired.token}` },
    } as never);
    const messages: { type: string; event?: RelayEvent; id?: number; result?: unknown }[] = [];
    ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));

    ws.send(JSON.stringify({ id: 1, method: "sync", params: { sinceSeq: 0 } }));
    const sync = await waitFor(async () => messages.find((m) => m.type === "rpc" && m.id === 1));
    expect((sync.result as { snapshot: { sessions: Session[] } }).snapshot.sessions.length).toBeGreaterThan(
      0,
    );

    await runHook({ ...base("UserPromptSubmit", "sess-2"), prompt: "hello" });
    const upsert = await waitFor(async () =>
      messages.find((m) => m.event?.type === "session.upsert" && m.event.session.id === "sess-2"),
    );
    expect(upsert.event?.seq).toBeGreaterThan(0);

    ws.send(
      JSON.stringify({
        id: 2,
        method: "prompt.answer",
        params: { promptId: "nope", answer: { kind: "permission", action: "allow" } },
      }),
    );
    const err = (await waitFor(async () => messages.find((m) => m.type === "rpc" && m.id === 2))) as {
      error?: { code: string };
    };
    expect(err.error?.code).toBe("not_found");
    ws.close();
  });

  test("revoking a device closes its open WebSocket at once, even when idle", async () => {
    const app = `http://127.0.0.1:${PORT}`;
    const { code } = (await fetch("http://relay/admin/pair", { method: "POST", unix: SOCK }).then((r) =>
      r.json(),
    )) as { code: string };
    const paired = (await fetch(`${app}/pair`, {
      method: "POST",
      body: JSON.stringify({ code, deviceName: "Revoked iPhone" }),
    }).then((r) => r.json())) as { token: string; deviceId: string };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: { authorization: `Bearer ${paired.token}` },
    } as never);
    const replies: unknown[] = [];
    ws.onmessage = (m) => replies.push(JSON.parse(String(m.data)));
    const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
    await new Promise((r) => (ws.onopen = r));

    await fetch("http://relay/admin/devices/revoke", {
      method: "POST",
      unix: SOCK,
      body: JSON.stringify({ id: paired.deviceId }),
    });
    // No frame from the phone: an idle connection must be dropped too.
    expect(await closed).toBe(4401);
    expect(replies.some((m) => (m as { type: string }).type === "rpc")).toBe(false);
  });
});

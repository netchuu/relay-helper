// The phone's Stop for one background shell goes through Claude Code's /tasks list, one verified key at a time.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BackgroundTask, HostInfo, RpcSchemas } from "../../protocol/index.ts";
import { BackgroundTracker, backgroundOf, resetBackground } from "../src/daemon/background.ts";
import { openDb } from "../src/daemon/db.ts";
import { detectDialog } from "../src/daemon/dialogs.ts";
import { EventLog } from "../src/daemon/events.ts";
import { defaultTypeOps, stopBackgroundShell, type TypeOps } from "../src/daemon/inject.ts";
import { paneXSteps } from "../src/daemon/paneTerminals.ts";
import { Registry, type SessionRecord } from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps } from "../src/daemon/rpc.ts";
import { readTasksPanel, sameCommand } from "../src/daemon/tasksPanel.ts";
import { KEY_BYTES } from "../src/shell/ptyShell.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/screens/claude-2.1.332-tasks-${name}.txt`, import.meta.url), "utf8");
const f = JSON.parse(
  readFileSync(new URL("../../protocol/fixtures/background.json", import.meta.url), "utf8"),
);

const RULE = "─".repeat(80);
const SESSION = {
  id: "bg1",
  status: "idle",
  canReceive: true,
  updatedAt: Date.now(),
  cwd: "/tmp/x",
  kind: "interactive",
  ptySocket: "/tmp/p.sock",
  ptyToken: "tok",
  pid: 4243,
} as unknown as SessionRecord;

/** A Claude Code terminal: the prompt, and the /tasks list once `/tasks` is typed. */
function terminal(opts: { rows: string[]; draft?: string; detail?: boolean; arrowsWork?: boolean }) {
  const log: string[] = [];
  const rows = [...opts.rows];
  const st = { open: false, cursor: 0, draft: opts.draft ?? "" };
  const render = () => {
    if (!st.open) return ["⏺ Done.", "", RULE, `❯ ${st.draft}`, RULE, "  ? for shortcuts"].join("\n");
    if (opts.detail)
      return [
        RULE,
        "  Sleep in background",
        "  shell",
        "",
        "  Status:   running",
        `  Command:  ${rows[0] ?? ""}`,
        "",
        "  ← to go back · x to stop · Enter/Space to close · Esc to close",
      ].join("\n");
    return [
      RULE,
      "  Background",
      `  ${rows.length} shells`,
      "",
      ...rows.map((r, i) => `  ${i === st.cursor ? "❯" : " "} ⏺ ${r.padEnd(30)}   running`),
      "",
      `  ${st.cursor >= rows.length ? "❯" : " "}   Earlier in this session (0)`,
      "",
      "  ↑/↓ to navigate · x to stop · Enter to view · Esc to close",
    ].join("\n");
  };
  const ops: TypeOps = {
    ...defaultTypeOps,
    sleep: async () => {},
    routes: () => [],
    ptyScreen: async () => render(),
    pty: async (_s, _t, _p, text) => {
      log.push(`type ${text}`);
      if (text === "/tasks") st.open = true;
      return { ok: true };
    },
    ptyArrow: async (_s, _t, _p, key) => {
      log.push(key);
      if (opts.arrowsWork !== false) st.cursor = Math.max(0, st.cursor + (key === "down" ? 1 : -1));
      return { ok: true };
    },
    ptyX: async () => {
      log.push("x");
      rows.splice(st.cursor, 1);
      if (opts.detail) st.open = false;
      return { ok: true };
    },
    ptyEscape: async () => {
      log.push("escape");
      st.open = false;
      return { ok: true };
    },
  };
  return { ops, log, rows, st };
}

describe("the recorded /tasks screens", () => {
  test("the list gives its rows and the cursor", () => {
    const panel = readTasksPanel(fixture("list"));
    expect(panel).toEqual({
      kind: "list",
      rows: [
        { label: "sleep 702 && echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…" },
        { label: "sleep 650" },
        { label: "sleep 701" },
        { label: "sleep 700" },
        { label: "sleep 700" },
      ],
      cursor: 0,
    });
  });

  test("one task shows its detail with the command", () => {
    expect(readTasksPanel(fixture("detail"))).toEqual({ kind: "detail", command: "sleep 700" });
  });

  test("a wrapped command reads as one line", () => {
    expect(readTasksPanel(fixture("detail-wrapped"))).toEqual({
      kind: "detail",
      command: "sleep 903 && echo done",
    });
    expect(sameCommand("sleep 903 && echo done", "sleep 903 &&\necho done")).toBe(true);
  });

  test("after a stop the list has one row fewer", () => {
    const panel = readTasksPanel(fixture("list-one-stopped"));
    expect(panel?.kind === "list" && panel.rows.length).toBe(4);
  });

  test("a prompt is no panel", () => {
    expect(readTasksPanel(["⏺ Done.", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n"))).toBeNull();
  });

  test("the watcher does not announce the list as a question at the computer", () => {
    expect(detectDialog(fixture("list"))?.kind).toBe("tasks");
  });
});

describe("matching a command to a row", () => {
  test("equal, or cut with an ellipsis on either side", () => {
    expect(sameCommand("sleep 700", "sleep 700")).toBe(true);
    expect(sameCommand("sleep 700", "sleep 70")).toBe(false);
    expect(sameCommand("sleep 702 && echo aaa…", "sleep 702 && echo aaaaaaaaaa")).toBe(true);
    expect(sameCommand("sleep 702 && echo aaaaaaaaaa", "sleep 702 && echo aa…")).toBe(true);
    expect(sameCommand("sleep 702 && echo bbb…", "sleep 702 && echo aaaaaaaaaa")).toBe(false);
  });

  test("a secret in the command compares as the helper redacted it", () => {
    const secret = "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'";
    expect(sameCommand(secret, secret)).toBe(true);
  });
});

describe("stopBackgroundShell", () => {
  test("moves to the row, presses x, and closes the list", async () => {
    const t = terminal({ rows: ["sleep 701", "npm run dev", "sleep 700"] });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res).toEqual({ outcome: "stopped", message: "Stopped." });
    expect(t.log).toEqual(["type /tasks", "down", "x", "escape"]);
    expect(t.rows).toEqual(["sleep 701", "sleep 700"]);
    expect(t.st.open).toBe(false);
  });

  test("a task that has gone from the list had finished: no x, list closed", async () => {
    const t = terminal({ rows: ["sleep 701", "sleep 700"] });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res).toEqual({ outcome: "finished", message: "It had already finished." });
    expect(t.log).not.toContain("x");
    expect(t.log.at(-1)).toBe("escape");
  });

  test("two rows that look the same get no key", async () => {
    const t = terminal({ rows: ["sleep 700", "sleep 700"] });
    const res = await stopBackgroundShell(SESSION, "sleep 700", t.ops);
    expect(res.outcome).toBe("unreachable");
    expect(res.message).toBe("Two tasks look the same. Stop this one at the computer.");
    expect(t.log).toEqual(["type /tasks", "escape"]);
    expect(t.rows.length).toBe(2);
  });

  test("a cursor that does not move never gets the x", async () => {
    const t = terminal({ rows: ["sleep 701", "npm run dev"], arrowsWork: false });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res.outcome).toBe("unreachable");
    expect(t.log).not.toContain("x");
    expect(t.log.at(-1)).toBe("escape");
    expect(t.rows).toEqual(["sleep 701", "npm run dev"]);
  });

  test("a wrapped command in the detail view is the same command", async () => {
    const screen = fixture("detail-wrapped");
    const t = terminal({ rows: [] });
    const prompt = ["⏺ Done.", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n");
    t.ops.ptyScreen = async () => (t.log.includes("x") || !t.log.length ? prompt : screen);
    const res = await stopBackgroundShell(SESSION, "sleep 903 && echo done", t.ops);
    expect(t.log).toContain("x");
    expect(res.outcome).toBe("stopped");
  });

  test("a single task opens in its detail view and is stopped there", async () => {
    const t = terminal({ rows: ["npm run dev"], detail: true });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res.outcome).toBe("stopped");
    expect(t.log).toEqual(["type /tasks", "x"]);
  });

  test("a cut row that also fits another known task gets no key", async () => {
    const a = "cd /Users/someone/projects/very-long-project-name && npm run dev";
    const b = "cd /Users/someone/projects/very-long-project-name && npm run test";
    const cut = "cd /Users/someone/projects/very-long-project-name…";
    const t = terminal({ rows: [cut] });
    const res = await stopBackgroundShell(SESSION, a, t.ops, [b]);
    expect(res.outcome).toBe("unreachable");
    expect(res.message).toBe("Two tasks look the same. Stop this one at the computer.");
    expect(t.log).not.toContain("x");
    const alone = terminal({ rows: [cut] });
    expect((await stopBackgroundShell(SESSION, a, alone.ops, [])).outcome).toBe("stopped");
  });

  test("a detail view of another command gets no key", async () => {
    const t = terminal({ rows: ["sleep 700"], detail: true });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res.outcome).toBe("unreachable");
    expect(t.log).toEqual(["type /tasks", "escape"]);
  });

  test("text in the prompt is never typed over", async () => {
    const t = terminal({ rows: ["npm run dev"], draft: "fix the login bug" });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res.outcome).toBe("unreachable");
    expect(res.message).toContain("text in Claude Code's prompt");
    expect(t.log).toEqual([]);
  });

  test("a terminal Relay can't reach says so", async () => {
    const res = await stopBackgroundShell({ ...SESSION, ptySocket: null, ptyToken: null } as never, "x", {
      ...defaultTypeOps,
      routes: () => [],
    });
    expect(res).toEqual({
      outcome: "unreachable",
      message: "Relay can't reach Claude Code's terminal. Stop it at the computer.",
    });
  });

  test("an older relay shell that refuses the x key leaves the task and closes the list", async () => {
    const t = terminal({ rows: ["npm run dev", "sleep 700"] });
    t.ops.ptyX = async () => {
      t.log.push("x");
      return { ok: false, reason: "bad_request" };
    };
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res.outcome).toBe("unreachable");
    expect(t.rows.length).toBe(2);
    expect(t.log.at(-1)).toBe("escape");
  });

  test("a list that never opens gets no key and no Esc", async () => {
    const t = terminal({ rows: ["npm run dev"] });
    t.ops.pty = async () => ({ ok: true });
    const res = await stopBackgroundShell(SESSION, "npm run dev", t.ops);
    expect(res.message).toBe("Claude Code's task list didn't open. Stop it at the computer.");
    expect(t.log).toEqual([]);
  });
});

describe("session.stopBackground", () => {
  const shell = BackgroundTask.parse({
    id: "b1",
    kind: "shell",
    title: "Start the dev server",
    detail: "npm run dev",
    startedAt: 1,
  });
  const agent = BackgroundTask.parse({ id: "a1", kind: "agent", title: "Test it", startedAt: 2 });

  function setup(status: "idle" | "working", ops?: TypeOps, shells?: string[]) {
    resetBackground();
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const tracker = new BackgroundTracker(events, { throttleMs: 0 });
    const seen: unknown[] = [];
    events.subscribe((e) => e.type === "session.background" && seen.push(e.tasks.map((t) => t.id)));
    registry.touch("s1", {
      cwd: "/tmp/x",
      name: "x",
      env: { pty: "/tmp/p.sock", ptyToken: "tok", claudePid: 4243 },
    });
    registry.setStatus("s1", status);
    tracker.stopped("s1", [
      ...(shells ?? []).map((command, i) => ({
        id: `t${i}`,
        type: "shell",
        status: "running",
        command,
        description: "Run it",
      })),
      ...(shells
        ? []
        : [
            {
              id: "b1",
              type: "shell",
              status: "running",
              command: "npm run dev",
              description: "Start the dev server",
            },
            { id: "a1", type: "agent", status: "running", description: "Test it" },
          ]),
    ]);
    seen.length = 0;
    const rpc = createRpc({
      db,
      events,
      registry,
      broker: { listOpen: () => [] },
      background: tracker,
      typeOps: ops,
    } as unknown as RpcDeps);
    const stop = (taskId: string, sessionId = "s1") =>
      rpc("session.stopBackground", { sessionId, taskId }, "device:a");
    return { stop, seen };
  }

  test("the stopped task leaves the list at once", async () => {
    const t = terminal({ rows: ["npm run dev"], detail: true });
    const { stop, seen } = setup("idle", t.ops);
    expect(await stop("b1")).toEqual({ result: { outcome: "stopped", message: "Stopped." } });
    expect(backgroundOf("s1").map((x) => x.id)).toEqual(["a1"]);
    expect(seen).toEqual([["a1"]]);
  });

  test("a task the helper no longer lists had finished", async () => {
    const { stop } = setup("idle", terminal({ rows: [] }).ops);
    expect(await stop("gone")).toEqual({
      result: { outcome: "finished", message: "It had already finished." },
    });
  });

  test("an agent, and a session that is working, are left alone", async () => {
    const t = terminal({ rows: ["npm run dev"] });
    const idle = setup("idle", t.ops);
    expect(await idle.stop("a1")).toMatchObject({ result: { outcome: "unreachable" } });
    const busy = setup("working", t.ops);
    expect(await busy.stop("b1")).toMatchObject({ result: { outcome: "unreachable" } });
    expect(t.log).toEqual([]);
    expect(backgroundOf("s1").length).toBe(2);
  });

  test("an unreachable terminal keeps the task on the list", async () => {
    const t = terminal({ rows: ["npm run dev", "sleep 1"] });
    t.ops.ptyX = async () => ({ ok: false, reason: "bad_request" });
    const { stop } = setup("idle", t.ops);
    expect(await stop("b1")).toMatchObject({ result: { outcome: "unreachable" } });
    expect(backgroundOf("s1").length).toBe(2);
  });

  test("a cut row that fits another listed shell gets no key", async () => {
    const a = "cd /Users/someone/projects/very-long-project-name && npm run dev";
    const b = "cd /Users/someone/projects/very-long-project-name && npm run test";
    const t = terminal({ rows: ["cd /Users/someone/projects/very-long-project-name…"] });
    const { stop } = setup("idle", t.ops, [a, b]);
    expect(await stop("t0")).toEqual({
      result: { outcome: "unreachable", message: "Two tasks look the same. Stop this one at the computer." },
    });
    expect(t.log).not.toContain("x");
    expect(backgroundOf("s1").length).toBe(2);
  });

  test("an unknown session is not_found", async () => {
    const { stop } = setup("idle", terminal({ rows: [] }).ops);
    expect(await stop("b1", "nope")).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("the x key", () => {
  test("relay shell writes the letter alone, and a pane gets it as text", () => {
    expect(KEY_BYTES.x).toBe("x");
    const steps = paneXSteps({ kind: "wezterm", id: "3", socket: null } as never);
    expect(JSON.stringify(steps)).toContain('"x"');
  });
});

describe("the protocol", () => {
  test("fixtures: the params, each outcome, and the host flag an older helper lacks", async () => {
    expect(RpcSchemas["session.stopBackground"].parse(f.stopParams).taskId).toBe("bonwwqtte");
    expect(f.stopped.outcome).toBe("stopped");
    expect(f.finished.outcome).toBe("finished");
    expect(f.unreachable.outcome).toBe("unreachable");
    const start = JSON.parse(
      readFileSync(new URL("../../protocol/fixtures/start.json", import.meta.url), "utf8"),
    );
    expect(HostInfo.parse(start.host).canStopBackground).toBe(true);
    expect("canStopBackground" in HostInfo.parse(start.hostOlder)).toBe(false);
  });
});

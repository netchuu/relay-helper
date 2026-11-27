// The trust dialog opens as a phone question; its answer is pressed into the screen by label, never by itself.
import { expect, test } from "bun:test";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { DialogWatcher } from "../src/daemon/dialogWatch.ts";
import { EventLog } from "../src/daemon/events.ts";
import { answerScreenDialog, defaultTypeOps, type TypeOps } from "../src/daemon/inject.ts";
import { Category, promptAlert } from "../src/daemon/notifier.ts";
import { paneArrowSteps } from "../src/daemon/paneTerminals.ts";
import { promptStatusSync } from "../src/daemon/promptStatus.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";
import { answerRequest, KEY_BYTES, type RequestContext } from "../src/shell/ptyShell.ts";

const RULE = "─".repeat(80);
const trustScreen = (cursor: 0 | 1) =>
  [
    RULE,
    " Accessing workspace:",
    "",
    " /Users/me/Projects/web-shop",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    ` ${cursor === 0 ? "❯" : " "} No, exit`,
    ` ${cursor === 1 ? "❯" : " "} Yes, I trust this folder`,
  ].join("\n");
const THEME = [
  RULE,
  " Choose a theme",
  "",
  " ❯ 1. Dark mode",
  "   2. Light mode",
  "",
  " Enter to confirm",
].join("\n");
const PROMPT = ["⏺ Done.", "", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n");

const SESSION = {
  id: "tq",
  status: "waiting",
  canReceive: true,
  updatedAt: Date.now(),
  title: null,
  name: null,
  cwd: "/Users/me/Projects/web-shop",
  project: "web-shop",
  branch: null,
  kind: "interactive",
  terminal: null,
  startedAt: 0,
  lastSummary: null,
  ptySocket: "/tmp/p.sock",
  ptyToken: "tok",
  pid: 4242,
} as unknown as SessionRecord;

function setup(screens: (string | null)[], press?: (label: string) => boolean) {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const broker = new Broker(db, events);
  const pressed: string[] = [];
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events,
    broker,
    hasOpen: (id) => broker.listOpen(id).some((p) => !p.dialog),
    read: async () => screens.shift() ?? null,
    press: async (_s, _id, label) => {
      pressed.push(label);
      return press ? press(label) : true;
    },
  });
  return { w, broker, pressed, events };
}

test("the trust dialog opens as one question with its dialog, path and what each answer does", async () => {
  const { w, broker, pressed } = setup([trustScreen(0), trustScreen(0)]);
  await w.look("tq");
  await w.look("tq");
  const open = broker.listOpen("tq");
  expect(open).toHaveLength(1);
  const [p] = open;
  expect(p?.kind).toBe("question");
  expect(p?.dialog).toEqual({ kind: "trust", title: "Trust this folder?" });
  if (p?.payload.kind !== "question") throw new Error("not a question");
  const q = p.payload.questions[0];
  expect(q?.question).toBe(
    "Trust this folder?\n/Users/me/Projects/web-shop\nClaude Code will be able to read, edit, and run files here.",
  );
  expect(q?.options).toEqual([
    { label: "No, exit", description: "Claude Code doesn't start." },
    {
      label: "Yes, I trust this folder",
      description: "Claude Code starts and can read, edit, and run files here.",
    },
  ]);
  // Never answered unasked, and not also shown as waiting at the Mac.
  expect(pressed).toEqual([]);
  expect(publicSession(SESSION).atMac).toBeUndefined();
});

test("the push for a trust question has no answer buttons", async () => {
  const { w, broker } = setup([trustScreen(0)]);
  await w.look("tq");
  const alert = promptAlert(broker.listOpen("tq")[0] as never, "web-shop");
  expect(alert.category).toBe(Category.notice);
  expect(alert.mutable).toBeUndefined();
  expect(alert.data.options).toBeUndefined();
  expect(alert.data.question).toBeUndefined();
  expect(alert.body).toBe("Claude Code asks whether you trust this folder.");
});

test("an answer by label presses it; the question closes as answered on the phone", async () => {
  const { w, broker, pressed } = setup([trustScreen(0)]);
  await w.look("tq");
  const p = broker.listOpen("tq")[0];
  const question = p?.payload.kind === "question" ? (p.payload.questions[0]?.question ?? "") : "";
  const res = await w.answer(
    p?.id ?? "",
    { kind: "question", answers: { [question]: "Yes, I trust this folder" } },
    "phone",
  );
  expect(res).toEqual({ ok: true });
  expect(pressed).toEqual(["Yes, I trust this folder"]);
  expect(broker.get(p?.id ?? "")).toMatchObject({ status: "closed", resolvedBy: "phone" });
});

test("a screen that changed answers conflict, types nothing and leaves the question open", async () => {
  const { w, broker } = setup([trustScreen(0)], () => false);
  await w.look("tq");
  const p = broker.listOpen("tq")[0];
  const question = p?.payload.kind === "question" ? (p.payload.questions[0]?.question ?? "") : "";
  const res = await w.answer(p?.id ?? "", { kind: "question", answers: { [question]: "No, exit" } }, "phone");
  expect(res).toMatchObject({ ok: false, code: "conflict" });
  expect(broker.get(p?.id ?? "")?.status).toBe("open");
  const typo = await w.answer(p?.id ?? "", { kind: "question", answers: { [question]: "Sure" } }, "phone");
  expect(typo).toMatchObject({ ok: false, code: "bad_request" });
});

test("two answers at once: one presses, the other conflicts", async () => {
  let release: (v: boolean) => void = () => {};
  const { w, broker } = setup([trustScreen(0)]);
  (w as unknown as { d: { press: unknown } }).d.press = () => new Promise<boolean>((r) => (release = r));
  await w.look("tq");
  const p = broker.listOpen("tq")[0];
  const question = p?.payload.kind === "question" ? (p.payload.questions[0]?.question ?? "") : "";
  const first = w.answer(p?.id ?? "", { kind: "question", answers: { [question]: "No, exit" } }, "phone");
  const second = await w.answer(
    p?.id ?? "",
    { kind: "question", answers: { [question]: "No, exit" } },
    "phone",
  );
  expect(second).toMatchObject({ ok: false, code: "conflict" });
  release(true);
  expect(await first).toEqual({ ok: true });
});

test("answered at the Mac: the question closes once the dialog is gone from two reads", async () => {
  const { w, broker, events } = setup([trustScreen(0), PROMPT, PROMPT]);
  await w.look("tq");
  const id = broker.listOpen("tq")[0]?.id ?? "";
  await w.look("tq");
  expect(broker.get(id)?.status).toBe("open");
  await w.look("tq");
  expect(broker.get(id)).toMatchObject({ status: "closed", resolvedBy: "mac" });
  expect(events.since(0).some((e) => e.type === "prompt.closed" && e.resolvedBy === "mac")).toBe(true);
});

test("another dialog replaces the question; one that only waits at the Mac opens none", async () => {
  const { w, broker } = setup([trustScreen(0), THEME, THEME]);
  await w.look("tq");
  const id = broker.listOpen("tq")[0]?.id ?? "";
  await w.look("tq");
  await w.look("tq");
  expect(broker.get(id)?.status).toBe("closed");
  expect(broker.listOpen("tq")).toHaveLength(0);
  w.clear("tq");
});

// A terminal whose cursor follows the arrow keys; `lag` redraws late.
function terminal(start: 0 | 1, opts: { stuck?: boolean; swapAfter?: number } = {}) {
  let cursor = start;
  const keys: string[] = [];
  const ops: TypeOps = {
    ...defaultTypeOps,
    sleep: async () => {},
    ptyScreen: async () =>
      opts.swapAfter !== undefined && keys.length >= opts.swapAfter ? THEME : trustScreen(cursor),
    ptyArrow: async (_s, _t, _p, key) => {
      keys.push(key);
      if (!opts.stuck) cursor = key === "down" ? 1 : 0;
      return { ok: true };
    },
    enterPty: async () => {
      keys.push("enter");
      return { ok: true };
    },
    routes: () => [],
  };
  return { ops, keys };
}

const trustId = async () => {
  const { detectDialog } = await import("../src/daemon/dialogs.ts");
  return detectDialog(trustScreen(0))?.id ?? "";
};

test("the answer moves the cursor to the label, reads it again, then presses Enter", async () => {
  const { ops, keys } = terminal(0);
  expect(await answerScreenDialog(SESSION, await trustId(), "Yes, I trust this folder", ops)).toBe(true);
  expect(keys).toEqual(["down", "enter"]);
});

test("the cursor already on the label: Enter alone, after the same re-read", async () => {
  const { ops, keys } = terminal(1);
  expect(await answerScreenDialog(SESSION, await trustId(), "Yes, I trust this folder", ops)).toBe(true);
  expect(keys).toEqual(["enter"]);
});

test("a cursor that does not move, or another dialog on screen: no Enter", async () => {
  const stuck = terminal(0, { stuck: true });
  expect(await answerScreenDialog(SESSION, await trustId(), "Yes, I trust this folder", stuck.ops)).toBe(
    false,
  );
  expect(stuck.keys).not.toContain("enter");
  const swapped = terminal(0, { swapAfter: 1 });
  expect(await answerScreenDialog(SESSION, await trustId(), "Yes, I trust this folder", swapped.ops)).toBe(
    false,
  );
  expect(swapped.keys).not.toContain("enter");
  const other = terminal(0);
  expect(await answerScreenDialog(SESSION, "d_00000000", "No, exit", other.ops)).toBe(false);
  expect(other.keys).toEqual([]);
});

test("a route that can't press arrow keys answers nothing", async () => {
  const { ops, keys } = terminal(0);
  expect(
    await answerScreenDialog(SESSION, await trustId(), "Yes, I trust this folder", {
      ...ops,
      ptyArrow: undefined,
    }),
  ).toBe(false);
  expect(keys).toEqual([]);
});

test("arrow keys reach relay shell, tmux and the pane terminals as the bytes a terminal sends", async () => {
  expect(KEY_BYTES.up).toBe("\x1b[A");
  expect(KEY_BYTES.down).toBe("\x1b[B");
  const written: string[] = [];
  const ctx: RequestContext = {
    token: "tok",
    shellPid: 1,
    isForeground: async () => true,
    pasteOn: () => false,
    write: (d) => void written.push(d),
    sleep: async () => {},
    now: () => 0,
  };
  expect(await answerRequest(JSON.stringify({ token: "tok", pid: 7, key: "down" }), ctx)).toEqual({
    ok: true,
  });
  expect(written).toEqual(["\x1b[B"]);
  const step = paneArrowSteps({ kind: "wezterm", pane: "3" } as never, "up")[0];
  expect(step?.stdin).toBe("\x1b[A");
});

test("a trust question closes when its session ends at the Mac", async () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const broker = new Broker(db, events);
  registry.touch("tq", { cwd: "/Users/me/Projects/web-shop" });
  const w = new DialogWatcher({
    registry,
    events,
    broker,
    read: async () => trustScreen(0),
    now: () => 0,
  });
  broker.openDialog(
    "tq",
    "d1",
    { kind: "trust", title: "Trust this folder?" },
    { question: "Trust?", options: [] },
  );
  registry.setStatus("tq", "ended");
  await w.tick();
  await w.tick();
  expect(broker.listOpen("tq")).toHaveLength(0);
});

test("answering a dialog question puts the session back to what it was, not working", () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  let sync = (_id: string): void => {};
  const broker = new Broker(db, events, (id) => sync(id));
  sync = promptStatusSync(registry, broker);
  registry.touch("tq", { cwd: "/Users/me/Projects/web-shop" });
  registry.setStatus("tq", "idle");
  const p = broker.openDialog("tq", "d1", { kind: "trust", title: "T" }, { question: "Trust?", options: [] });
  expect(registry.get("tq")?.status).toBe("waiting");
  broker.close(p.id, "phone");
  expect(registry.get("tq")?.status).toBe("idle");
});

test("a permission prompt opened at idle puts the session to working when it closes", () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  let sync = (_id: string): void => {};
  const broker = new Broker(db, events, (id) => sync(id));
  sync = promptStatusSync(registry, broker);
  registry.touch("tq", { cwd: "/Users/me/Projects/web-shop" });
  registry.setStatus("tq", "idle");
  const { prompt } = broker.open({ session_id: "tq", tool_name: "Bash", tool_input: { command: "ls" } });
  expect(registry.get("tq")?.status).toBe("waiting");
  broker.close(prompt.id, "phone");
  expect(registry.get("tq")?.status).toBe("working");
});

// The phone closes a terminal menu with Esc, only after reading the screen again.
import { expect, test } from "bun:test";
import { openDb } from "../src/daemon/db.ts";
import { detectDialog } from "../src/daemon/dialogs.ts";
import { atMacOfSession, DialogWatcher } from "../src/daemon/dialogWatch.ts";
import { EventLog } from "../src/daemon/events.ts";
import { closeScreenDialog, defaultTypeOps, type TypeOps } from "../src/daemon/inject.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";

const RULE = "─".repeat(80);
const THEME = [
  RULE,
  " Choose a theme",
  "",
  " ❯ 1. Dark mode",
  "   2. Light mode",
  "",
  " Enter to confirm",
].join("\n");
const OTHER = THEME.replace("Light mode", "Auto");
const TRUST = [
  RULE,
  " Accessing workspace:",
  "",
  " /Users/me/web-shop",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
].join("\n");
const PROMPT = ["⏺ Done.", "", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n");

const SESSION = {
  id: "dc",
  status: "waiting",
  canReceive: true,
  updatedAt: Date.now(),
  cwd: "/tmp/x",
  kind: "interactive",
  ptySocket: "/tmp/p.sock",
  ptyToken: "tok",
  pid: 4243,
} as unknown as SessionRecord;

const idOf = (screen: string) => detectDialog(screen)?.id ?? "";

function terminal(screens: (string | null)[]) {
  const keys: string[] = [];
  const ops: TypeOps = {
    ...defaultTypeOps,
    sleep: async () => {},
    ptyScreen: async () => screens[0] ?? null,
    ptyEscape: async () => {
      keys.push("escape");
      return { ok: true };
    },
    routes: () => [],
  };
  return { ops, keys };
}

test("Esc is sent when the same closable dialog is still on screen", async () => {
  const { ops, keys } = terminal([THEME]);
  expect(await closeScreenDialog(SESSION, idOf(THEME), ops)).toBe("closed");
  expect(keys).toEqual(["escape"]);
});

test("a different dialog, or none, is a conflict and types nothing", async () => {
  for (const screen of [OTHER, PROMPT]) {
    const { ops, keys } = terminal([screen]);
    expect(await closeScreenDialog(SESSION, idOf(THEME), ops)).toBe("conflict");
    expect(keys).toEqual([]);
  }
});

test("a dialog that can't be closed gets no Esc", async () => {
  const { ops, keys } = terminal([TRUST]);
  expect(await closeScreenDialog(SESSION, idOf(TRUST), ops)).toBe("unavailable");
  expect(keys).toEqual([]);
});

test("an unreadable screen is unavailable", async () => {
  const { ops, keys } = terminal([null]);
  expect(await closeScreenDialog(SESSION, idOf(THEME), ops)).toBe("unavailable");
  expect(keys).toEqual([]);
});

test("after Esc the session no longer waits at the Mac", async () => {
  const db = openDb(":memory:");
  const sent: string[] = [];
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events: new EventLog(db),
    read: async () => THEME,
    closeDialog: async (_s, id) => {
      sent.push(id);
      return "closed";
    },
  });
  await w.look("dc");
  expect(atMacOfSession("dc")?.canClose).toBe(true);
  expect(await w.close("dc", idOf(THEME))).toBe("closed");
  expect(sent).toEqual([idOf(THEME)]);
  expect(atMacOfSession("dc")).toBeUndefined();
});

test("a conflict leaves the card as it was", async () => {
  const db = openDb(":memory:");
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events: new EventLog(db),
    read: async () => THEME,
    closeDialog: async () => "conflict",
  });
  await w.look("dc");
  expect(await w.close("dc", "d_00000000")).toBe("conflict");
  expect(atMacOfSession("dc")).toBeDefined();
  w.clear("dc");
});

test("two closes at once send one Esc", async () => {
  const db = openDb(":memory:");
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events: new EventLog(db),
    read: async () => THEME,
    closeDialog: async (_s, id) => {
      sent.push(id);
      await gate;
      return "closed";
    },
  });
  await w.look("dc");
  const a = w.close("dc", idOf(THEME));
  const b = w.close("dc", idOf(THEME));
  const c = w.close("dc", "d_00000000");
  release();
  expect(await Promise.all([a, b, c])).toEqual(["closed", "closed", "conflict"]);
  expect(sent).toEqual([idOf(THEME)]);
});

test("a look that read the screen before the Esc does not bring the dialog back", async () => {
  const db = openDb(":memory:");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slow = false;
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events: new EventLog(db),
    read: async () => {
      if (!slow) return THEME;
      await gate;
      return THEME;
    },
    closeDialog: async () => "closed",
  });
  await w.look("dc");
  slow = true;
  const late = w.look("dc");
  expect(await w.close("dc", idOf(THEME))).toBe("closed");
  release();
  await late;
  expect(atMacOfSession("dc")).toBeUndefined();
});

function stale(clock: { t: number }) {
  const db = openDb(":memory:");
  const keys: string[] = [];
  let redrawn = false;
  const w = new DialogWatcher({
    registry: { get: () => SESSION, list: () => [SESSION], publish() {} },
    events: new EventLog(db),
    now: () => clock.t,
    read: async () => (redrawn ? PROMPT : THEME),
    closeDialog: async (s, id) => {
      const { ops, keys: k } = terminal([THEME]);
      const r = await closeScreenDialog(s, id, ops);
      keys.push(...k);
      return r;
    },
  });
  return { w, keys, redraw: () => (redrawn = true) };
}

test("a repeat close before the redraw sends no second Esc", async () => {
  const clock = { t: 1000 };
  const { w, keys } = stale(clock);
  await w.look("dc");
  expect(await w.close("dc", idOf(THEME))).toBe("closed");
  clock.t += 100;
  expect(await w.close("dc", idOf(THEME))).toBe("closed");
  expect(keys).toEqual(["escape"]);
});

test("a look that starts before the redraw does not bring the dialog back", async () => {
  const clock = { t: 1000 };
  const { w, redraw } = stale(clock);
  await w.look("dc");
  await w.close("dc", idOf(THEME));
  clock.t += 100;
  await w.look("dc");
  expect(atMacOfSession("dc")).toBeUndefined();
  redraw();
  clock.t += 1000;
  await w.look("dc");
  expect(atMacOfSession("dc")).toBeUndefined();
});

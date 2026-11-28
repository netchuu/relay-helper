// Terminal dialogs on screen: found by shape, shown as waiting at the Mac, cleared when they go.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RelayEvent } from "../../protocol/index.ts";
import type { RelayConfig } from "../src/config.ts";
import { Broker } from "../src/daemon/broker.ts";
import { openDb } from "../src/daemon/db.ts";
import { detectDialog } from "../src/daemon/dialogs.ts";
import { atMacOfSession, DialogWatcher, HOOK_DIALOGS } from "../src/daemon/dialogWatch.ts";
import { EventLog } from "../src/daemon/events.ts";
import { HookHandler } from "../src/daemon/hooks.ts";
import type { PresenceMonitor } from "../src/daemon/presence.ts";
import type { SessionRecord } from "../src/daemon/registry.ts";
import { publicSession, Registry } from "../src/daemon/registry.ts";

const RULE = "─".repeat(80);
const TRUST = [
  RULE,
  " Accessing workspace:",
  "",
  " /Users/me/Projects/web-shop",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
].join("\n");
const THEME = [
  RULE,
  " Choose a theme",
  "",
  " ❯ 1. Dark mode",
  "   2. Light mode",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");
const PROMPT = ["⏺ Done.", "", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n");

test("the captured trust screen is a trust dialog with its options and cursor", () => {
  const d = detectDialog(TRUST);
  expect(d?.kind).toBe("trust");
  expect(d?.title).toBe("Accessing workspace:");
  expect(d?.options).toEqual(["No, exit", "Yes, I trust this folder"]);
  expect(d?.cursor).toBe(0);
  expect(d?.canClose).toBe(false);
});

test("an unknown dialog is `other`, with a title and the id of what it shows", () => {
  const d = detectDialog(THEME);
  expect(d?.kind).toBe("other");
  expect(d?.title).toBe("Choose a theme");
  expect(d?.options).toEqual(["Dark mode", "Light mode"]);
  expect(d?.canClose).toBe(true);
  expect(detectDialog(THEME.replace("Light mode", "Auto"))?.id).not.toBe(d?.id);
  expect(detectDialog(THEME)?.id).toBe(d?.id);
});

// Recorded from Claude Code 2.1.332 in a scratch folder, one screen per file.
const recorded = (name: string) =>
  detectDialog(
    readFileSync(new URL(`./fixtures/screens/claude-2.1.332-${name}.txt`, import.meta.url), "utf8"),
  );

test("the recorded /exit with background tasks is an exitTasks dialog", () => {
  const d = recorded("exit-with-tasks");
  expect(d?.kind).toBe("exitTasks");
  expect(d?.title).toBe("Background work is running");
  expect(d?.options).toEqual(["Exit and stop tasks", "Move to background and exit", "Stay"]);
  expect(d?.cursor).toBe(0);
});

test("the recorded /model picker has its title, five models and the cursor on the current one", () => {
  const d = recorded("model-picker");
  expect(d?.kind).toBe("other");
  expect(d?.title).toBe("Select model");
  expect(d?.options.length).toBe(6);
  expect(d?.options[4]).toStartWith("Haiku 5.5");
  expect(d?.cursor).toBe(4);
  expect(d?.canClose).toBe(true);
});

test("the recorded /resume picker is a dialog with its session", () => {
  const d = recorded("resume-picker");
  expect(d?.title).toBe("Resume session");
  expect(d?.options[0]).toBe("Background sleep 600 command");
});

test("the recorded /permissions and /config screens are dialogs the phone can close", () => {
  const p = recorded("permissions");
  expect(p?.kind).toBe("other");
  expect(p?.options[0]).toBe("Add a new rule…");
  expect(p?.title).toStartWith("Permissions");
  const c = recorded("config");
  expect(c?.kind).toBe("other");
  expect(c?.title).toStartWith("Settings");
  expect(c?.options[0]).toStartWith("Auto-compact");
  expect(p?.canClose && c?.canClose).toBe(true);
});

test("the recorded MCP approval is an mcpServer dialog with the cursor on Continue without", () => {
  const d = recorded("mcp-approval");
  expect(d?.kind).toBe("mcpServer");
  expect(d?.title).toBe("New MCP server found in this project: scratch");
  expect(d?.options).toEqual([
    "Use this MCP server",
    "Use this and all future MCP servers in this project",
    "Continue without using this MCP server",
  ]);
  expect(d?.cursor).toBe(2);
});

test("the recorded Yes / No confirmation has its cursor on No", () => {
  const d = recorded("add-dir-confirm");
  expect(d?.title).toBe("Adding a new directory:");
  expect(d?.options).toEqual(["No, leave it out", "Yes, add it"]);
  expect(d?.cursor).toBe(0);
});

test("the recorded rate-limit menu is a rateLimit dialog", () => {
  const d = recorded("rate-limit-menu");
  expect(d?.kind).toBe("rateLimit");
  expect(d?.title).toBe("What do you want to do?");
  expect(d?.options[0]).toBe("Stop and wait for limit to reset");
  expect(d?.options.length).toBe(3);
});

test("a prompt, a draft, output and a shell are not dialogs", () => {
  expect(detectDialog(PROMPT)).toBeNull();
  expect(detectDialog(["⏺ ok", RULE, "❯ fix it", "  and the tests", RULE].join("\n"))).toBeNull();
  expect(detectDialog("me@mac ~ % ls\nREADME.md")).toBeNull();
  expect(detectDialog("")).toBeNull();
});

test("old dialog words, echoes and drafts in the scrollback are not dialogs", () => {
  const echo = [
    "Please run /login",
    "",
    "❯ /login",
    "  ⎿ Login successful",
    "",
    RULE,
    "❯ ",
    RULE,
    "  ? for shortcuts",
  ];
  expect(detectDialog(echo.join("\n"))).toBeNull();
  const draft = [RULE, "❯ fix it", "  and the tests", RULE, "  ? for shortcuts"];
  expect(detectDialog(["  Exit and stop tasks", "", ...draft].join("\n"))).toBeNull();
  expect(detectDialog(["  Switch model?", "  ❯ 1. Yes", "    2. No", "", ...draft].join("\n"))).toBeNull();
  const real = [
    "old output",
    "  Exit and stop tasks",
    "",
    RULE,
    " Choose a theme",
    "",
    " ❯ 1. Dark",
    "   2. Light",
    "",
    " Enter to confirm",
  ];
  expect(detectDialog(real.join("\n"))?.kind).toBe("other");
});

test("screen text is redacted and cut", () => {
  const secret = ["sk", "ant", "api03", "A".repeat(40)].join("-");
  const long = [RULE, ` ${"t".repeat(300)}`, ` ${"b".repeat(900)}`, ""];
  const opts = Array.from({ length: 12 }, (_, i) => `   ${i + 1}. ${i === 0 ? secret : "o".repeat(300)}`);
  opts[0] = opts[0]?.replace("   1.", " ❯ 1.") as string;
  const d = detectDialog([...long, ...opts, "", " Esc to cancel"].join("\n"));
  expect(d?.title.length).toBe(120);
  expect(d?.body.length).toBe(600);
  expect(d?.options.length).toBe(9);
  expect(d?.options[1]?.length).toBe(120);
  expect(JSON.stringify(d)).not.toContain(secret);
});

afterEach(() =>
  new DialogWatcher({
    registry: { get: () => null, list: () => [], publish() {} },
    events: { emit: (b) => b as RelayEvent },
  }).clear("sd"),
);

function setup(screens: (string | null)[], hasOpen?: () => boolean) {
  const events: RelayEvent[] = [];
  let published = 0;
  const session = {
    id: "sd",
    status: "idle",
    canReceive: true,
    updatedAt: Date.now(),
    title: null,
    name: null,
    cwd: "/p",
    project: "p",
    branch: null,
    kind: "interactive",
    terminal: null,
    startedAt: 0,
    lastSummary: null,
  } as unknown as SessionRecord;
  const w = new DialogWatcher({
    registry: { get: () => session, list: () => [session], publish: () => void published++ },
    events: {
      emit: (b) => {
        events.push(b as RelayEvent);
        return b as RelayEvent;
      },
    },
    hasOpen,
    read: async () => screens.shift() ?? null,
  });
  return { w, events, session, published: () => published };
}

test("a dialog on screen is waiting at the Mac, with one attention notice, until it is gone", async () => {
  const { w, events, session } = setup([THEME, THEME, PROMPT, PROMPT]);
  await w.look("sd");
  await w.look("sd");
  expect(atMacOfSession("sd")?.title).toBe("Choose a theme");
  const pub = publicSession(session);
  expect(pub.status).toBe("waiting");
  expect(pub.atMac).toEqual({
    id: expect.any(String),
    kind: "other",
    title: "Choose a theme",
    canClose: true,
  });
  expect(events.filter((e) => e.type === "session.notice")).toHaveLength(1);
  expect(events[0]).toMatchObject({ level: "attention" });
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeDefined();
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeUndefined();
  expect(publicSession(session).status).toBe("idle");
  expect(publicSession(session).atMac).toBeUndefined();
});

test("a session with a hook prompt open is not looked at, and its screen dialog is dropped", async () => {
  let open = false;
  const { w, events } = setup([THEME, THEME, THEME], () => open);
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeDefined();
  open = true;
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeUndefined();
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeUndefined();
  expect(events.filter((e) => e.type === "session.notice")).toHaveLength(1);
});

test("a screen dialog is cleared when the session turns working", async () => {
  const { w, session } = setup([THEME]);
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeDefined();
  (session as { status: string }).status = "working";
  await w.tick();
  expect(atMacOfSession("sd")).toBeUndefined();
});

test("the trust dialog is not shown as waiting at the Mac, and an unreadable screen changes nothing", async () => {
  const { w } = setup([TRUST, THEME, null, null, null]);
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeUndefined();
  await w.look("sd");
  await w.look("sd");
  await w.look("sd");
  expect(atMacOfSession("sd")).toBeDefined();
  w.clear("sd");
});

test("a hook's dialog waits at the Mac until the next prompt, tool, stop or end", () => {
  const { w, events } = setup([]);
  expect(HOOK_DIALOGS.has("elicitation_dialog")).toBe(true);
  w.fromHook("sd", "elicitation_dialog", "Server docs asks for a choice");
  w.fromHook("sd", "elicitation_dialog", "Server docs asks for a choice");
  expect(atMacOfSession("sd")).toMatchObject({ kind: "elicitation_dialog", canClose: false });
  expect(events).toHaveLength(1);
  w.hookCleared("sd");
  expect(atMacOfSession("sd")).toBeUndefined();
});

test("through the hooks: an MCP form waits at the Mac with one notice, and the next prompt clears it", async () => {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const registry = new Registry(db, events);
  const dialogs = new DialogWatcher({ registry, events });
  const hooks = new HookHandler({
    db,
    events,
    registry,
    broker: new Broker(db, events),
    presence: { noteLocalActivity() {} } as unknown as PresenceMonitor,
    config: { previewChars: 600 } as RelayConfig,
    dialogs,
  });
  const hook = (event: string, fields: Record<string, unknown> = {}) =>
    hooks.handle(
      {
        payload: { hook_event_name: event, session_id: "hk", cwd: "/Users/me/app", ...fields },
        env: { socket: "/tmp/hk.sock" },
      },
      new AbortController().signal,
    );
  await hook("SessionStart");
  await hook("Notification", { notification_type: "elicitation_dialog", message: "docs asks a question" });
  expect(registry.get("hk") && publicSession(registry.get("hk") as SessionRecord).status).toBe("waiting");
  const notices = db.query("SELECT data_json FROM events WHERE type = 'session.notice'").all();
  expect(notices).toHaveLength(1);
  await hook("UserPromptSubmit", { prompt: "go on" });
  expect(atMacOfSession("hk")).toBeUndefined();
});

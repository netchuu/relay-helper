import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InterruptVia } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import {
  defaultKeyOps,
  defaultTypeOps,
  type KeyOps,
  pressEscape,
  readSuggestion,
  type TypeOps,
  terminalRoutesOf,
  typingRouteFor,
} from "../src/daemon/inject.ts";
import { sessionModels } from "../src/daemon/model.ts";
import { type HookEnv, publicSession, Registry, type SessionRecord } from "../src/daemon/registry.ts";

const RULE = "─".repeat(100);
const screen = (...prompt: string[]) =>
  ["⏺ Done.", RULE, ...prompt, RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const WEZ_ENV: HookEnv = {
  termProgram: "WezTerm",
  weztermPane: "7",
  weztermSocket: "/tmp/wez/gui-sock-1",
  claudePid: 4242,
};
const KITTY_ENV: HookEnv = {
  termProgram: "kitty",
  kittyWindowId: "5",
  kittyListenOn: "unix:/tmp/kitty-9",
  claudePid: 4242,
};

let dir: string;
let oldPath: string | undefined;

function fake(name: string) {
  const script = `#!/bin/sh
{ printf 'CALL %s\\n' "$*"; case "$*" in *send-text*) printf 'STDIN %s\\n' "$(cat | od -An -c | tr -s ' ' | tr -d '\\n')";; esac; } >> ${dir}/log
case "$*" in
  *get-text*) cat ${dir}/screen ;;
  *" list "*) cat ${dir}/list.json ;;
  *" ls "*) cat ${dir}/ls.json ;;
esac
`;
  writeFileSync(join(dir, name), script);
  chmodSync(join(dir, name), 0o755);
}

const log = () => {
  try {
    return readFileSync(join(dir, "log"), "utf8");
  } catch {
    return "";
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-routes-"));
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  fake("wezterm");
  fake("kitty");
  writeFileSync(join(dir, "screen"), screen("❯ "));
  writeFileSync(join(dir, "list.json"), JSON.stringify([{ pane_id: 7, tty_name: "/dev/ttys042" }]));
  writeFileSync(
    join(dir, "ls.json"),
    JSON.stringify([{ tabs: [{ windows: [{ id: 5, foreground_processes: [{ pid: 4242 }] }] }] }]),
  );
});
afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

function session(env: HookEnv): SessionRecord {
  const db = openDb(":memory:");
  return new Registry(db, new EventLog(db)).touch("s", { cwd: "/p", env }).session;
}

function keys(front = true): KeyOps {
  return {
    ...defaultKeyOps,
    ttyOf: async () => "/dev/ttys042",
    inFront: async () => front,
    routes: () => [],
  };
}

function typeOps(front = true): TypeOps {
  return {
    ...defaultTypeOps,
    ttyOf: async () => "/dev/ttys042",
    inFront: async () => front,
    routes: () => [],
    sleep: async () => {},
  };
}

describe("Escape", () => {
  test("goes to a WezTerm pane as the Esc key", async () => {
    expect(await pressEscape(session(WEZ_ENV), keys())).toBe("wezterm");
    expect(log()).toMatch(/send-text --pane-id 7 --no-paste\nSTDIN\s+033\s*\n/);
  });

  test("goes to a kitty window as the Esc key", async () => {
    expect(await pressEscape(session(KITTY_ENV), keys())).toBe("kitty");
    expect(log()).toMatch(/send-text --match id:5 --stdin\nSTDIN\s+033\s*\n/);
  });

  test("is not sent when Claude Code isn't in front of the pane", async () => {
    expect(await pressEscape(session(WEZ_ENV), keys(false))).toBeNull();
    expect(await pressEscape(session(KITTY_ENV), keys(false))).toBeNull();
    expect(log()).not.toContain("send-text");
  });

  test("is not sent without the in-front check", async () => {
    const { inFront: _, ...without } = keys();
    expect(await pressEscape(session(WEZ_ENV), without as unknown as KeyOps)).toBeNull();
    expect(log()).not.toContain("send-text");
  });

  test("the answer can be reported to the phone", () => {
    expect(InterruptVia.parse("wezterm")).toBe("wezterm");
    expect(InterruptVia.parse("kitty")).toBe("kitty");
  });
});

describe("suggestions", () => {
  const dimmed = screen(`❯ \u001b[2mrun the tests and fix what fails\u001b[0m`);

  for (const [name, env] of [
    ["WezTerm", WEZ_ENV],
    ["kitty", KITTY_ENV],
  ] as const) {
    test(`${name}: the dimmed prompt is the suggestion`, async () => {
      writeFileSync(join(dir, "screen"), dimmed);
      expect(await readSuggestion(session(env), typeOps())).toBe("run the tests and fix what fails");
    });

    test(`${name}: typing in the prompt is not one, and an empty prompt has none`, async () => {
      writeFileSync(join(dir, "screen"), screen("❯ also check the signup"));
      expect(await readSuggestion(session(env), typeOps())).toBeNull();
      writeFileSync(join(dir, "screen"), screen("❯ "));
      expect(await readSuggestion(session(env), typeOps())).toBeNull();
    });
  }

  test("a pane that can't be read gives undefined", async () => {
    const ops = { ...typeOps(), paneScreen: async () => null };
    expect(await readSuggestion(session(WEZ_ENV), ops)).toBeUndefined();
  });
});

describe("the table", () => {
  test("lists the route, and only when Claude Code is in front", async () => {
    expect(await typingRouteFor(session(WEZ_ENV), typeOps())).toBe("wezterm");
    expect(await typingRouteFor(session(KITTY_ENV), typeOps())).toBe("kitty");
    expect(await typingRouteFor(session(WEZ_ENV), typeOps(false))).toBeNull();
  });

  test("a model change is offered only where a terminal route exists", () => {
    const row = (env: HookEnv) => ({ ...session(env), id: "model-routes" });
    sessionModels.setModel("model-routes", "claude-fable-5-2");
    try {
      expect(publicSession(row(WEZ_ENV))).toHaveProperty("model");
      expect(publicSession(row(KITTY_ENV))).toHaveProperty("model");
      expect(publicSession({ ...row(WEZ_ENV), runsInHelper: true })).not.toHaveProperty("model");
      expect(terminalRoutesOf(row({ termProgram: "Apple_Terminal", claudePid: 4242 }))).toEqual([]);
      expect(publicSession(row({ termProgram: "Apple_Terminal", claudePid: 4242 }))).not.toHaveProperty(
        "model",
      );
    } finally {
      sessionModels.forget("model-routes");
    }
  });
});

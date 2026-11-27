import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionCommands } from "../../protocol/index.ts";
import { openDb } from "../src/daemon/db.ts";
import { EventLog } from "../src/daemon/events.ts";
import {
  commandRouteOf,
  publicSession,
  Registry,
  type SessionRecord,
  setTypingPreferred,
} from "../src/daemon/registry.ts";
import { createRpc, type RpcDeps, type RpcOutcome } from "../src/daemon/rpc.ts";
import { BUILTIN_COMMANDS, frontmatter, SKILL_FILE, slashCommandsFor } from "../src/daemon/slashCommands.ts";

let root: string;
let home: string;
let project: string;
let oldHome: string | undefined;

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const md = (description: string, body = "Do it.") => `---\ndescription: ${description}\n---\n${body}\n`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "relay-slash-")));
  home = join(root, "home");
  project = join(root, "shop");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  oldHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const find = (cwd: string, name: string) => slashCommandsFor(cwd).find((c) => c.name === name);

describe("sources", () => {
  test("built-ins, user, project and plugin entries each carry their source", () => {
    put(join(home, ".claude/commands/tidy-notes.md"), md("Sort today's notes"));
    put(
      join(home, ".claude/skills/pressing", SKILL_FILE),
      "---\nname: pressing\ndescription: Press flowers\n---\nBody",
    );
    put(join(project, ".claude/commands/ship-it.md"), md("Run the checks, then push"));
    put(
      join(project, ".claude/skills/stock-count", SKILL_FILE),
      "---\ndescription: Count the stock\n---\nBody",
    );
    const plugin = join(home, ".claude/plugins/cache/market/garden/1.0");
    put(join(plugin, "commands/water-plants.md"), md("Water the plants"));
    put(join(plugin, "skills/prune", SKILL_FILE), "---\ndescription: Prune the hedge\n---\n");
    put(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "garden@market": [{ scope: "user", installPath: plugin }] } }),
    );

    expect(find(project, "compact")?.source).toBe("builtin");
    expect(find(project, "tidy-notes")).toEqual({
      name: "tidy-notes",
      description: "Sort today's notes",
      source: "user",
    });
    expect(find(project, "pressing")).toEqual({
      name: "pressing",
      description: "Press flowers",
      source: "user",
    });
    expect(find(project, "ship-it")).toEqual({
      name: "ship-it",
      description: "Run the checks, then push",
      source: "project",
    });
    expect(find(project, "stock-count")?.source).toBe("project");
    expect(find(project, "garden:water-plants")).toEqual({
      name: "garden:water-plants",
      description: "Water the plants",
      source: "plugin",
    });
    expect(find(project, "garden:prune")?.source).toBe("plugin");
  });

  test("no folders at all still gives the built-ins", () => {
    const names = slashCommandsFor(join(root, "missing")).map((c) => c.name);
    expect(names).toEqual(BUILTIN_COMMANDS.map((c) => c.name).sort());
  });

  test("a project's commands belong to that project's sessions only", () => {
    put(join(project, ".claude/commands/ship-it.md"), md("Push"));
    expect(find(join(root, "other"), "ship-it")).toBeUndefined();
  });

  test("a folder inside commands goes before the file name, joined with a colon", () => {
    put(join(project, ".claude/commands/shop/restock.md"), md("Reorder stock"));
    put(join(project, ".claude/commands/a/b/deep.md"), md("Deep"));
    expect(find(project, "shop:restock")?.source).toBe("project");
    expect(find(project, "a:b:deep")?.source).toBe("project");
    expect(find(project, "restock")).toBeUndefined();
  });

  test("project folders are read from every parent up to the repository root, nearest first", () => {
    const web = join(project, "packages/web");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(web, { recursive: true });
    put(join(project, ".claude/skills/stock-count", SKILL_FILE), "---\ndescription: root\n---\n");
    put(join(project, ".claude/commands/deploy.md"), md("root deploy"));
    put(join(web, ".claude/commands/deploy.md"), md("web deploy"));
    put(join(root, ".claude/commands/above.md"), md("above the repository"));
    expect(find(web, "stock-count")?.source).toBe("project");
    expect(find(web, "deploy")?.description).toBe("web deploy");
    expect(find(web, "above")).toBeUndefined();
  });

  test("a description missing from the front matter is the first line of the text", () => {
    put(join(project, ".claude/commands/plain.md"), "\n# Check the till\nMore.\n");
    expect(find(project, "plain")?.description).toBe("Check the till");
  });

  test("a long description is cut", () => {
    put(join(project, ".claude/commands/wordy.md"), md("w ".repeat(300)));
    const d = find(project, "wordy")?.description ?? "";
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d.endsWith("…")).toBe(true);
  });

  test("a skill only Claude may call, and an odd file name, are left out", () => {
    put(
      join(project, ".claude/skills/quiet", SKILL_FILE),
      "---\ndescription: x\nuser-invocable: false\n---\n",
    );
    put(join(project, ".claude/commands/not a name.md"), md("x"));
    put(join(project, ".claude/commands/notes.txt"), "x");
    const names = slashCommandsFor(project).map((c) => c.name);
    expect(names).not.toContain("quiet");
    expect(names).not.toContain("not a name");
    expect(names).not.toContain("notes");
  });
});

describe("plugins", () => {
  const install = (installed: (path: string) => unknown, settings?: unknown) => {
    const path = join(home, ".claude/plugins/cache/market/garden/1.0");
    put(join(path, "commands/water-plants.md"), md("Water"));
    put(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: installed(path) }));
    if (settings) put(join(home, ".claude/settings.json"), JSON.stringify(settings));
  };

  test("a plugin installed for another project is not offered here", () => {
    install((path: string) => ({
      "garden@market": [{ scope: "project", installPath: path, projectPath: join(root, "else") }],
    }));
    expect(find(project, "garden:water-plants")).toBeUndefined();
  });

  test("a plugin installed for this project, or a folder in it, is offered", () => {
    install((path: string) => ({
      "garden@market": [{ scope: "project", installPath: path, projectPath: project }],
    }));
    expect(find(project, "garden:water-plants")).toBeDefined();
    expect(find(join(project, "web"), "garden:water-plants")).toBeDefined();
  });

  test("a plugin switched off in settings is not offered", () => {
    install((path: string) => ({ "garden@market": [{ scope: "user", installPath: path }] }), {
      enabledPlugins: { "garden@market": false },
    });
    expect(find(project, "garden:water-plants")).toBeUndefined();
  });

  test("broken JSON gives no plugin commands and no error", () => {
    put(join(home, ".claude/plugins/installed_plugins.json"), "{nope");
    expect(slashCommandsFor(project).every((c) => c.source === "builtin")).toBe(true);
  });
});

describe("dedupe", () => {
  test("a name in two sources appears once: skills before commands, user before project", () => {
    put(join(home, ".claude/commands/ship-it.md"), md("The user's command"));
    put(join(project, ".claude/commands/ship-it.md"), md("The project's command"));
    put(join(home, ".claude/skills/ship-it", SKILL_FILE), "---\ndescription: user skill\n---\n");
    put(join(project, ".claude/skills/deploy", SKILL_FILE), "---\ndescription: project skill\n---\n");
    put(join(home, ".claude/skills/deploy", SKILL_FILE), "---\ndescription: user skill\n---\n");
    put(join(project, ".claude/commands/both.md"), md("project command"));
    put(join(home, ".claude/commands/both.md"), md("user command"));
    const all = slashCommandsFor(project);
    expect(all.filter((c) => c.name === "ship-it")).toEqual([
      { name: "ship-it", description: "user skill", source: "user" },
    ]);
    expect(all.filter((c) => c.name === "deploy")).toEqual([
      { name: "deploy", description: "user skill", source: "user" },
    ]);
    expect(find(project, "both")?.description).toBe("user command");
  });

  test("a user or project skill replaces a built-in of the same name", () => {
    put(join(project, ".claude/skills/compact", SKILL_FILE), "---\ndescription: mine\n---\n");
    put(join(home, ".claude/commands/review.md"), md("Mine too"));
    const all = slashCommandsFor(project);
    expect(all.filter((c) => c.name === "compact")).toEqual([
      { name: "compact", description: "mine", source: "project" },
    ]);
    expect(all.filter((c) => c.name === "review")).toHaveLength(1);
  });

  test("a command and a skill of the same name in one folder appear once", () => {
    put(join(home, ".claude/commands/twin.md"), md("command"));
    put(join(home, ".claude/skills/twin", SKILL_FILE), "---\ndescription: skill\n---\n");
    expect(slashCommandsFor(project).filter((c) => c.name === "twin")).toHaveLength(1);
  });

  test("a plugin's command keeps its prefix, so it does not hide a user command of the same name", () => {
    const plugin = join(home, "p");
    put(join(plugin, "commands/tidy.md"), md("plugin"));
    put(join(home, ".claude/commands/tidy.md"), md("user"));
    put(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { "garden@m": [{ scope: "user", installPath: plugin }] } }),
    );
    expect(find(project, "tidy")?.source).toBe("user");
    expect(find(project, "garden:tidy")?.source).toBe("plugin");
  });
});

describe("built-ins", () => {
  test("leave out the ones that open a terminal dialog", () => {
    const names = slashCommandsFor(project).map((c) => c.name);
    for (const dialog of [
      "model",
      "config",
      "resume",
      "agents",
      "mcp",
      "permissions",
      "login",
      "logout",
      "help",
      "release-notes",
      "pr-comments",
    ])
      expect(names).not.toContain(dialog);
    expect(names).toContain("compact");
  });
});

describe("withMenus", () => {
  const menus = (cwd = project) => slashCommandsFor(cwd, true);
  const opens = (name: string) => menus().find((c) => c.name === name);

  test("without it the list has no menu commands and no opens", () => {
    const list = slashCommandsFor(project);
    expect(list.some((c) => "opens" in c || "phone" in c)).toBe(false);
    expect(list.map((c) => c.name)).not.toContain("config");
    expect(slashCommandsFor(project, false)).toEqual(list);
  });

  test("adds the menu built-ins and every entry says what it does", () => {
    put(join(project, ".claude/commands/ship-it.md"), md("Push"));
    const list = menus();
    expect(list.every((c) => c.opens !== undefined)).toBe(true);
    for (const name of ["config", "permissions", "mcp", "hooks", "agents", "login", "help"])
      expect(opens(name)?.opens).toBe("menu");
    expect(opens("ship-it")?.opens).toBe("turn");
    expect(opens("compact")?.opens).toBe("turn");
    expect(opens("context")?.opens).toBe("output");
    expect(list.length).toBeGreaterThan(slashCommandsFor(project).length);
  });

  test("every menu built-in of the coverage matrix opens a menu", () => {
    const names = [
      "model",
      "config",
      "permissions",
      "mcp",
      "hooks",
      "ide",
      "memory",
      "theme",
      "status",
      "usage",
      "stats",
      "usage-credits",
      "tasks",
      "bashes",
      "diff",
      "export",
      "skills",
      "skill-doctor",
      "plugin",
      "output-style",
      "advisor",
      "autocompact",
      "copy",
      "artifacts",
      "chrome",
      "sandbox",
      "privacy-settings",
      "remote-control",
      "rc",
      "remote-env",
      "release-notes",
      "scroll-speed",
      "workflows",
      "powerup",
      "import",
      "install-github-app",
      "setup-bedrock",
      "setup-vertex",
      "bug",
      "feedback",
      "help",
      "rate-limit-options",
      "effort",
      "agents",
      "login",
    ];
    for (const name of names) expect(opens(name)?.opens, name).toBe("menu");
  });

  test("/model and /effort name the phone's own control", () => {
    expect(opens("model")).toMatchObject({ opens: "menu", phone: "model" });
    expect(opens("effort")).toMatchObject({ opens: "menu", phone: "effort" });
    expect(opens("config")).not.toHaveProperty("phone");
  });

  test("/exit, /quit and /logout end the chat; /clear and /resume replace it", () => {
    for (const name of ["exit", "quit", "logout"]) expect(opens(name)?.opens).toBe("ends");
    for (const name of ["clear", "resume"]) expect(opens(name)?.opens).toBe("replaces");
  });

  test("a user command of a menu built-in's name still wins", () => {
    put(join(home, ".claude/commands/config.md"), md("Mine"));
    expect(opens("config")).toMatchObject({ source: "user", opens: "turn" });
  });

  test("session.commands passes the flag through", async () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const rpc = createRpc({ db, events, registry, broker: { listOpen: () => [] } } as unknown as RpcDeps);
    registry.touch("s1", { cwd: project, env: { socket: "/i" } });
    const run = async (params: object) => {
      const o = await rpc("session.commands", { sessionId: "s1", ...params }, "device:a");
      if (!("result" in o)) throw new Error("no result");
      return SessionCommands.parse(o.result).commands;
    };
    expect((await run({})).some((c) => c.name === "exit")).toBe(false);
    expect((await run({ withMenus: true })).find((c) => c.name === "exit")?.opens).toBe("ends");
  });
});

describe("front matter", () => {
  test("quoted, folded and missing values", () => {
    expect(frontmatter('---\ndescription: "Quoted: yes"\n---\nbody').data.description).toBe("Quoted: yes");
    expect(frontmatter("---\ndescription: >\n  one\n  two\n---\nx").data.description).toBe("one two");
    expect(frontmatter("no front matter").data).toEqual({});
    expect(frontmatter("---\nunclosed: 1\nbody").data).toEqual({});
  });
});

describe("whether a typed command runs", () => {
  const base = {
    id: "x-not-a-desktop-session",
    cwd: "/x",
    status: "idle",
    terminal: null,
    pid: null,
    ptySocket: null,
    tmuxPane: null,
    tmuxSocket: null,
    socketPath: null,
    runsInHelper: false,
    transcript: null,
  };
  const s = (o: Record<string, unknown>) => ({ ...base, ...o }) as unknown as SessionRecord;
  const noApp = { isApp: () => false, allowed: () => false };

  test("the helper's pty and tmux run it", () => {
    expect(commandRouteOf(s({ ptySocket: "/p", socketPath: "/i" }), noApp)).toBe("terminal");
    expect(commandRouteOf(s({ tmuxPane: "%1", tmuxSocket: "/t", socketPath: "/i" }), noApp)).toBe("terminal");
  });

  // These terminals are driven through macOS only.
  test.skipIf(process.platform !== "darwin")("iTerm, WezTerm and kitty run it", () => {
    expect(commandRouteOf(s({ terminal: "iTerm.app", socketPath: "/i" }), noApp)).toBe("terminal");
    for (const env of [
      { termProgram: "WezTerm", weztermPane: "7", weztermSocket: "/tmp/wez/gui-sock-1", claudePid: 4242 },
      { termProgram: "kitty", kittyWindowId: "5", kittyListenOn: "unix:/tmp/kitty-9", claudePid: 4242 },
    ]) {
      const db = openDb(":memory:");
      const rec = new Registry(db, new EventLog(db)).touch("s", { cwd: "/p", env }).session;
      expect(commandRouteOf(rec, noApp)).toBe("terminal");
      expect(publicSession(rec).commandsRun).toBe(true);
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "the desktop app and editor panels run it with Accessibility, and arrive as a note without",
    () => {
      const app = { isApp: () => true, allowed: () => true };
      expect(commandRouteOf(s({ socketPath: "/i" }), app)).toBe("app");
      expect(commandRouteOf(s({}), app)).toBe("app");
      expect(commandRouteOf(s({ socketPath: "/i" }), { isApp: () => true, allowed: () => false })).toBe(
        "inbox",
      );
    },
  );

  test("with typing off every message goes to the inbox", () => {
    setTypingPreferred(false);
    try {
      expect(commandRouteOf(s({ tmuxPane: "%1", tmuxSocket: "/t", socketPath: "/i" }), noApp)).toBe("inbox");
      expect(commandRouteOf(s({ tmuxPane: "%1", tmuxSocket: "/t" }), noApp)).toBeNull();
      expect(commandRouteOf(s({ runsInHelper: true }), noApp)).toBe("helper");
      const db = openDb(":memory:");
      const rec = new Registry(db, new EventLog(db)).touch("t", {
        cwd: "/p",
        env: { tmuxPane: "%1", tmux: "/t,1,0", socket: "/i" },
      }).session;
      expect(publicSession(rec)).toMatchObject({ commandsRun: false, replyRoute: "labelled" });
    } finally {
      setTypingPreferred(true);
    }
  });

  test("the helper's own Claude Code runs it", () => {
    expect(commandRouteOf(s({ runsInHelper: true }), noApp)).toBe("helper");
  });

  test("the inbox only shows a labelled note; no route means no way to send", () => {
    expect(commandRouteOf(s({ socketPath: "/i" }), noApp)).toBe("inbox");
    expect(commandRouteOf(s({ terminal: "Apple_Terminal", socketPath: "/i" }), noApp)).toBe("inbox");
    expect(commandRouteOf(s({}), noApp)).toBeNull();
    expect(commandRouteOf(s({ status: "ended", socketPath: "/i" }), noApp)).toBeNull();
  });

  test("the session record carries the flag", () => {
    const db = openDb(":memory:");
    const registry = new Registry(db, new EventLog(db));
    const rec = registry.touch("n", { cwd: "/p", env: { socket: "/i" } }).session;
    expect(publicSession(rec).commandsRun).toBe(false);
    expect(publicSession({ ...rec, runsInHelper: true }).commandsRun).toBe(true);
    expect(publicSession({ ...rec, status: "ended" })).not.toHaveProperty("commandsRun");
  });
});

describe("session.commands", () => {
  function setup(extra: Partial<RpcDeps> = {}) {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    const registry = new Registry(db, events);
    const rpc = createRpc({
      db,
      events,
      registry,
      broker: { listOpen: () => [] },
      ...extra,
    } as unknown as RpcDeps);
    return { registry, rpc };
  }
  const result = (o: RpcOutcome) => {
    if (!("result" in o)) throw new Error(`expected a result, got ${JSON.stringify(o.error)}`);
    return SessionCommands.parse(o.result);
  };

  test("lists the session's folder, and says the inbox won't run it", async () => {
    put(join(project, ".claude/commands/ship-it.md"), md("Push"));
    const { registry, rpc } = setup();
    registry.touch("s1", { cwd: project, env: { socket: "/i" } });
    const r = result(await rpc("session.commands", { sessionId: "s1" }, "device:a"));
    expect(r.commands.some((c) => c.name === "ship-it" && c.source === "project")).toBe(true);
    expect(r.run).toBe(false);
    expect(r.route).toBe("inbox");
  });

  test("an ended session whose conversation is on disk runs it by resuming", async () => {
    const { registry, rpc } = setup({
      claudeBin: "/bin/claude",
      headless: { has: () => false },
      hasTranscript: () => true,
    } as never);
    registry.touch("s1", { cwd: project });
    registry.setStatus("s1", "ended");
    const r = result(await rpc("session.commands", { sessionId: "s1" }, "device:a"));
    expect(r).toMatchObject({ run: true, route: "resume" });
  });

  test("an ended session the helper is resuming right now runs it through the helper", async () => {
    const { registry, rpc } = setup({ headless: { has: () => true } } as never);
    registry.touch("s1", { cwd: project });
    registry.setStatus("s1", "ended");
    const r = result(await rpc("session.commands", { sessionId: "s1" }, "device:a"));
    expect(r).toMatchObject({ run: true, route: "helper" });
  });

  test("an ended session with nothing to resume has no route", async () => {
    const { registry, rpc } = setup();
    registry.touch("s1", { cwd: project });
    registry.setStatus("s1", "ended");
    const r = result(await rpc("session.commands", { sessionId: "s1" }, "device:a"));
    expect(r.run).toBe(false);
    expect(r).not.toHaveProperty("route");
  });

  test("an unknown session is not_found", async () => {
    const { rpc } = setup();
    const o = await rpc("session.commands", { sessionId: "nope" }, "device:a");
    expect(o).toMatchObject({ error: { code: "not_found" } });
  });
});

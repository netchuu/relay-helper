import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { SlashCommand } from "../../../protocol/index.ts";

/**
 * Claude Code's own commands that run from a typed line. The ones that open a terminal dialog or picker (/model,
 * /config, /resume, /agents, /mcp, /permissions, /login, ...) can't be driven from a phone and are left out.
 */
export const BUILTIN_COMMANDS: readonly { name: string; description: string }[] = [
  { name: "add-dir", description: "Add a working directory for this session" },
  { name: "clear", description: "Start a new conversation with an empty context" },
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "context", description: "Show how much of the context is used" },
  { name: "cost", description: "Show what this session has cost" },
  { name: "init", description: "Create a CLAUDE.md for this project" },
  { name: "review", description: "Review a pull request" },
  { name: "security-review", description: "Review the pending changes for security problems" },
];

export const SKILL_FILE = "SKILL.md";
const MAX_COMMANDS = 500;
const MAX_DESCRIPTION = 200;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

// Read per call: Bun's homedir() ignores a HOME set after start, which tests rely on.
const home = () => process.env.HOME || homedir();

/** The `---` block at the top of a markdown file as plain key/value strings, and the text after it. */
export function frontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  const lines = (m[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i] ?? "");
    if (!kv) continue;
    const key = kv[1] as string;
    let value = (kv[2] ?? "").trim();
    // A block scalar (`>` or `|`) or a plain value that continues on indented lines.
    if (/^[>|][+-]?$/.test(value) || value === "") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1] ?? ""))
        parts.push((lines[++i] ?? "").trim());
      value = parts.join(" ");
    }
    data[key] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return { data, body: text.slice(m[0].length) };
}

function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** `*.md` files under a commands folder, folders included (`frontend/x.md` is `/frontend:x`). */
function commandFiles(dir: string, depth = 0): string[] {
  const files: string[] = [];
  for (const e of entries(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory() && depth < 4) files.push(...commandFiles(path, depth + 1));
    else if (e.isFile() && e.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function fromCommands(dir: string, source: SlashCommand["source"], prefix: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const path of commandFiles(dir)) {
    const text = read(path);
    if (text === null) continue;
    const parts = relative(dir, path).replace(/\.md$/, "").split(sep);
    const base = parts.join(":");
    const { data, body } = frontmatter(text);
    if (!parts.every((p) => NAME.test(p))) continue;
    const firstLine = body.split("\n").find((l) => l.trim() !== "") ?? "";
    out.push({
      name: prefix + base,
      description: tidy(data.description || firstLine.replace(/^#+\s*/, "")),
      source,
    });
  }
  return out;
}

function fromSkills(dir: string, source: SlashCommand["source"], prefix: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const e of entries(dir)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const text = read(join(dir, e.name, SKILL_FILE));
    if (text === null) continue;
    const { data } = frontmatter(text);
    // A skill only Claude may call doesn't answer to a typed name.
    if (/^false$/i.test(data["user-invocable"] ?? data["user-invokable"] ?? "")) continue;
    const name = data.name && NAME.test(data.name) ? data.name : e.name;
    if (!NAME.test(name)) continue;
    out.push({ name: prefix + name, description: tidy(data.description ?? ""), source });
  }
  return out;
}

/** `<cwd>/.claude` and the same folder in every parent up to the repository root, nearest first. */
function projectRoots(cwd: string): string[] {
  const roots: string[] = [];
  const userHome = home();
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    if (dir !== userHome) roots.push(join(dir, ".claude"));
    if (entries(dir).some((e) => e.name === ".git")) return roots;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return [join(cwd, ".claude")];
}

function jsonOf(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(read(path) ?? "null");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The install folders of the plugins that apply to a session in `cwd`: user-wide ones and ones for its folder. */
function pluginRoots(cwd: string): { plugin: string; path: string }[] {
  const claude = join(home(), ".claude");
  const installed = jsonOf(join(claude, "plugins", "installed_plugins.json")).plugins;
  const enabled = jsonOf(join(claude, "settings.json")).enabledPlugins;
  if (!installed || typeof installed !== "object") return [];
  const off = (key: string) =>
    !!enabled && typeof enabled === "object" && (enabled as Record<string, unknown>)[key] === false;
  const roots: { plugin: string; path: string }[] = [];
  for (const [key, list] of Object.entries(installed as Record<string, unknown>)) {
    if (off(key) || !Array.isArray(list)) continue;
    const plugin = key.split("@")[0] ?? "";
    for (const item of list) {
      const { scope, installPath, projectPath } = (item ?? {}) as Record<string, unknown>;
      if (typeof installPath !== "string" || !NAME.test(plugin)) continue;
      const here =
        typeof projectPath === "string" && (cwd === projectPath || cwd.startsWith(projectPath + sep));
      if (scope === "user" || here) {
        roots.push({ plugin, path: installPath });
        break;
      }
    }
  }
  return roots;
}

/**
 * What a session in `cwd` can run when its message is typed: Claude Code's non-dialog built-ins, then project,
 * user and plugin commands and skills. A name appears once, as Claude Code resolves it: skills before commands,
 * user before project (nearest folder first), and both before a built-in.
 */
export function slashCommandsFor(cwd: string): SlashCommand[] {
  const userRoot = join(home(), ".claude");
  const projects = projectRoots(cwd);
  const plugins = pluginRoots(cwd);
  const all: SlashCommand[] = [
    ...fromSkills(join(userRoot, "skills"), "user", ""),
    ...projects.flatMap((r) => fromSkills(join(r, "skills"), "project", "")),
    ...fromCommands(join(userRoot, "commands"), "user", ""),
    ...projects.flatMap((r) => fromCommands(join(r, "commands"), "project", "")),
    ...plugins.flatMap(({ plugin, path }) => [
      ...fromSkills(join(path, "skills"), "plugin", `${plugin}:`),
      ...fromCommands(join(path, "commands"), "plugin", `${plugin}:`),
    ]),
    ...BUILTIN_COMMANDS.map((c) => ({ ...c, source: "builtin" as const })),
  ];
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const c of all) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  const order = { builtin: 0, project: 1, user: 2, plugin: 3 };
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => order[a.c.source] - order[b.c.source] || a.c.name.localeCompare(b.c.name) || a.i - b.i)
    .map(({ c }) => c)
    .slice(0, MAX_COMMANDS);
}

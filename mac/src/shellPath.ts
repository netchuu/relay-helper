import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertWritable, resolveLink, writeFileAtomic } from "./atomicWrite.ts";

export const BLOCK_START = "# >>> relay >>>";
export const BLOCK_END = "# <<< relay <<<";

export type ShellName = "zsh" | "bash" | "fish";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Puts `dir` first in PATH unless it already is. Written last in each rc file, after the person's own PATH lines. */
export function posixBlock(dir: string): string {
  const d = quote(dir);
  return `${BLOCK_START}
case ":$PATH:" in
  ":"${d}":"*) ;;
  *) PATH=${d}":$PATH"; export PATH ;;
esac
${BLOCK_END}
`;
}

export function fishBlock(dir: string): string {
  const d = quote(dir);
  return `${BLOCK_START}
if test "$PATH[1]" != ${d}
    set -gx PATH ${d} (string match -v -- ${d} $PATH)
end
${BLOCK_END}
`;
}

/** The files each shell reads, as `claude` has to be first after all of them ran. */
export function shellFiles(home: string, env: Record<string, string | undefined> = process.env) {
  const zdot = env.ZDOTDIR || home;
  const bashLogin =
    [".bash_profile", ".bash_login", ".profile"].map((f) => join(home, f)).find((f) => existsSync(f)) ??
    join(home, ".bash_profile");
  const fish = join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish");
  return {
    zsh: [join(zdot, ".zshenv"), join(zdot, ".zshrc")],
    bash: [join(home, ".bashrc"), bashLogin],
    fish: [join(fish, "conf.d", "relay.fish"), join(fish, "config.fish")],
  } satisfies Record<ShellName, string[]>;
}

function blockRange(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return null;
  const close = text.indexOf(BLOCK_END, start);
  if (close === -1) return null;
  let end = close + BLOCK_END.length;
  if (text[end] === "\n") end++;
  return { start, end };
}

/** Pure: the file with Relay's block at the end, once. */
export function withBlock(text: string, block: string): string {
  const base = withoutBlock(text);
  if (base === "") return block;
  return `${base}\n${block}`;
}

/** Pure: the file as it was before `withBlock`. */
export function withoutBlock(text: string): string {
  const r = blockRange(text);
  if (!r) return text;
  const before = text.slice(0, r.start);
  const after = text.slice(r.end);
  // The block came with a blank line before it, or a line break when the file had no final one.
  if (before.endsWith("\n\n")) return before.slice(0, -1) + after;
  if (after === "" && before.endsWith("\n")) return before.slice(0, -1);
  return before + after;
}

function hasBlock(text: string, block: string): boolean {
  return withBlock(text, block) === text;
}

/** Backs up, then writes through links so a dotfiles link stays a link. Returns the backup's path. */
function write(path: string, text: string, existed: boolean): string | null {
  mkdirSync(dirname(resolveLink(path)), { recursive: true });
  assertWritable(path);
  let backup: string | null = null;
  let mode = 0o644;
  if (existed) {
    backup = `${path}.relay-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(resolveLink(path), backup);
    mode = statSync(resolveLink(path)).mode & 0o777;
  }
  writeFileAtomic(path, text, mode);
  return backup;
}

export type ShellChange = { path: string; backup: string | null };

/** Puts the block in every file of the shells in `shells`. Files that already have it stay untouched. */
export function addShellBlocks(
  dir: string,
  shells: ShellName[],
  home: string,
  env: Record<string, string | undefined> = process.env,
): ShellChange[] {
  const files = shellFiles(home, env);
  const changes: ShellChange[] = [];
  for (const shell of shells) {
    const block = shell === "fish" ? fishBlock(dir) : posixBlock(dir);
    for (const path of files[shell]) {
      const existed = existsSync(path);
      const text = existed ? readFileSync(resolveLink(path), "utf8") : "";
      if (existed && hasBlock(text, block)) continue;
      changes.push({ path, backup: write(path, withBlock(text, block), existed) });
    }
  }
  return changes;
}

/** Takes the block out of every file that holds it; a file that only held the block is deleted. */
export function removeShellBlocks(
  home: string,
  env: Record<string, string | undefined> = process.env,
): ShellChange[] {
  const changes: ShellChange[] = [];
  const files = shellFiles(home, env);
  const candidates = new Set<string>(Object.values(files).flat());
  // A login file that appeared after install is where bash looks now, but the block went where it was then.
  for (const f of [".bash_profile", ".bash_login", ".profile"]) candidates.add(join(home, f));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(resolveLink(path), "utf8");
    if (blockRange(text) === null) continue;
    const rest = withoutBlock(text);
    if (rest === "") {
      const backup = `${path}.relay-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(resolveLink(path), backup);
      rmSync(resolveLink(path));
      changes.push({ path, backup });
    } else changes.push({ path, backup: write(path, rest, true) });
  }
  return changes;
}

/** Which shells have the block in every file they read. */
export function shellsSetUp(
  home: string,
  env: Record<string, string | undefined> = process.env,
): ShellName[] {
  const files = shellFiles(home, env);
  const done = (path: string) => {
    try {
      return readFileSync(resolveLink(path), "utf8").includes(BLOCK_START);
    } catch {
      return false;
    }
  };
  return (Object.keys(files) as ShellName[]).filter((s) => files[s].every(done));
}

/** Copies the compiled wrapper to `to` (as `claude`), replacing a running one safely. */
export function placeShim(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, `${to}.new`);
  chmodSync(`${to}.new`, 0o755);
  renameSync(`${to}.new`, to);
}

/** The shells this computer has: installed, or with a startup file the person already uses. */
export function detectShells(
  home: string,
  env: Record<string, string | undefined> = process.env,
): ShellName[] {
  const files = shellFiles(home, env);
  const present = (s: ShellName) =>
    Bun.which(s) !== null || files[s].some((f) => existsSync(f) && s !== "fish");
  return (["zsh", "bash", "fish"] as const).filter(
    (s) => present(s) || (s === "fish" && existsSync(dirname(files.fish[0] as string))),
  );
}

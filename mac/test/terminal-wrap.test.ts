import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addShellBlocks,
  BLOCK_START,
  placeShim,
  removeShellBlocks,
  shellFiles,
  shellsSetUp,
  withBlock,
  withoutBlock,
} from "../src/shellPath.ts";

// `relay install` puts Relay's `claude` first in PATH for new terminals; these run real shells on temp homes.

const ROOT = resolve(import.meta.dir, "../..");
const dirs: string[] = [];
let shim = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-shim-"));
  dirs.push(dir);
  shim = join(dir, "relay-wrap");
  const build = Bun.spawn(
    [process.execPath, "build", "--compile", resolve(ROOT, "mac/src/shell/wrapMain.ts"), "--outfile", shim],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await build.exited).toBe(0);
}, 120_000);

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeHome(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "relay-term-"));
  dirs.push(home);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(home, name, ".."), { recursive: true });
    writeFileSync(join(home, name), text);
  }
  const bin = join(home, ".relay", "bin");
  return { home, bin, log: join(home, "log") };
}

const PREPENDING = {
  ".zshrc": 'export PATH="$HOME/.local/bin:$PATH"\nalias ll="ls -l"\nexport PATH="$HOME/.claude/bin:$PATH"\n',
  ".zshenv": "export EDITOR=vi\n",
  ".bashrc": 'export PATH="$HOME/.local/bin:$PATH"\nexport PATH="$HOME/.claude/bin:$PATH"',
  ".bash_profile": "[ -f ~/.bashrc ] && . ~/.bashrc\n",
};

describe("rc files", () => {
  test("install twice changes nothing more; uninstall restores every file exactly", () => {
    const { home, bin } = makeHome({ ...PREPENDING, ".config/fish/config.fish": "set -x A 1\n" });
    const read = () =>
      Object.fromEntries(
        Object.values(shellFiles(home))
          .flat()
          .map((f) => [f, existsSync(f) ? readFileSync(f, "utf8") : null]),
      );
    const before = read();
    addShellBlocks(bin, ["zsh", "bash", "fish"], home);
    const once = read();
    expect(once).not.toEqual(before);
    const second = addShellBlocks(bin, ["zsh", "bash", "fish"], home);
    expect(second).toEqual([]);
    expect(read()).toEqual(once);
    expect(shellsSetUp(home).sort()).toEqual(["bash", "fish", "zsh"]);
    removeShellBlocks(home);
    expect(read()).toEqual(before);
    expect(shellsSetUp(home)).toEqual([]);
  });

  test("a changed block moves to the end; text edits round-trip", () => {
    const block = `${BLOCK_START}\nx\n# <<< relay <<<\n`;
    for (const text of ["", "a\n", "a", "a\n\n", "a\nb\n"]) {
      expect(withoutBlock(withBlock(text, block))).toBe(text);
    }
    const moved = withBlock(`${withBlock("a\n", block)}later\n`, block);
    expect(moved.endsWith(block)).toBe(true);
    expect(moved.split(BLOCK_START).length).toBe(2);
  });

  test("the backup holds the file as it was", () => {
    const { home, bin } = makeHome(PREPENDING);
    const changes = addShellBlocks(bin, ["zsh"], home);
    const rc = changes.find((c) => c.path.endsWith(".zshrc"));
    expect(readFileSync(rc?.backup as string, "utf8")).toBe(PREPENDING[".zshrc"]);
  });

  test("a linked rc file stays a link", () => {
    const { home, bin } = makeHome({ "dot/zshrc": "export A=1\n" });
    symlinkSync(join(home, "dot/zshrc"), join(home, ".zshrc"));
    addShellBlocks(bin, ["zsh"], home);
    expect(readFileSync(join(home, "dot/zshrc"), "utf8")).toContain(BLOCK_START);
    removeShellBlocks(home);
    expect(readFileSync(join(home, "dot/zshrc"), "utf8")).toBe("export A=1\n");
  });
});

async function run(home: string, cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    env: { HOME: home, PATH: "/usr/bin:/bin", RELAY_HOME: join(home, ".relay"), ...env },
    cwd: home,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out: out.trim(), code };
}

describe("PATH order in new shells", () => {
  const shells: [string, string[]][] = [
    ["zsh -ic", ["/bin/zsh", "-ic", "command -v claude"]],
    ["zsh -c", ["/bin/zsh", "-c", "command -v claude"]],
    ["zsh -lc", ["/bin/zsh", "-lc", "command -v claude"]],
    ["bash -ic", ["/bin/bash", "-ic", "command -v claude"]],
    ["bash -lc", ["/bin/bash", "-lc", "command -v claude"]],
  ];
  for (const [name, cmd] of shells) {
    test(`${name} finds Relay's claude first, behind rc files that prepend folders`, async () => {
      const { home, bin } = makeHome(PREPENDING);
      for (const d of [".local/bin", ".claude/bin"]) {
        mkdirSync(join(home, d), { recursive: true });
        writeFileSync(join(home, d, "claude"), "#!/bin/sh\n");
        chmodSync(join(home, d, "claude"), 0o755);
      }
      placeShim(shim, join(bin, "claude"));
      addShellBlocks(bin, ["zsh", "bash"], home);
      expect((await run(home, cmd)).out).toBe(join(bin, "claude"));
      removeShellBlocks(home);
      expect((await run(home, cmd)).out).not.toBe(join(bin, "claude"));
    });
  }

  test("the fish block keeps the folder first and runs under fish when it is installed", async () => {
    const fish = Bun.which("fish");
    if (!fish) return;
    const { home, bin } = makeHome({ ".config/fish/config.fish": "set -gx PATH $HOME/.local/bin $PATH\n" });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/claude"), "#!/bin/sh\n");
    chmodSync(join(home, ".local/bin/claude"), 0o755);
    placeShim(shim, join(bin, "claude"));
    addShellBlocks(bin, ["fish"], home);
    for (const args of [["-c"], ["-ic"]])
      expect(
        (await run(home, [fish, ...args, "command -v claude"], { XDG_CONFIG_HOME: join(home, ".config") }))
          .out,
      ).toBe(join(bin, "claude"));
  });
});

// The person's own claude() runs through Corral's sd-wrap, then reaches Relay's program, then the real claude.
const FUNCTIONS = `export PATH="$HOME/.local/bin:$PATH"
sd-wrap() { echo "sd-wrap $*" >> "$HOME/log"; "$@"; }
claude() {
  local extra=()
  [[ -f .claude/rules.md ]] && extra=(--append-system-prompt-file .claude/rules.md)
  sd-wrap command claude "\${extra[@]}" "$@"
}
export PATH="$HOME/.claude/bin:$PATH"
`;
const REAL_CLAUDE = `#!/bin/sh
echo "real $* wrapped=\${RELAY_PTY:+yes}" >> "$HOME/log"
`;

function chain(opts: { relay?: boolean; helper?: boolean } = {}) {
  const { home, bin, log } = makeHome({ ".zshrc": FUNCTIONS, ".claude/rules.md": "rules\n" });
  mkdirSync(join(home, ".relay", "versions"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  // Claude Code's updater rewrites this link to the new version.
  writeFileSync(join(home, ".relay/versions/2.1.0"), REAL_CLAUDE);
  chmodSync(join(home, ".relay/versions/2.1.0"), 0o755);
  symlinkSync(join(home, ".relay/versions/2.1.0"), join(home, ".local/bin/claude"));
  placeShim(shim, join(bin, "claude"));
  if (opts.relay !== false) writeFileSync(join(bin, "relay"), "#!/bin/sh\n");
  addShellBlocks(bin, ["zsh"], home);
  const server =
    opts.helper === false
      ? null
      : Bun.listen({ unix: join(home, ".relay", "hook.sock"), socket: { data() {}, open() {} } });
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { home, lines, stop: () => server?.stop(true) };
}

const inTerminal = (home: string, command: string, env: Record<string, string> = {}) =>
  run(home, ["script", "-q", "/dev/null", "/bin/zsh", "-ic", command], env);

describe.skipIf(process.platform !== "darwin")(
  "the chain from the person's function to the real claude",
  () => {
    test("their flags reach the real claude, which runs inside Relay's terminal", async () => {
      const c = chain();
      try {
        await inTerminal(c.home, "claude --model x");
        expect(c.lines()).toEqual([
          "sd-wrap command claude --append-system-prompt-file .claude/rules.md --model x",
          "real --append-system-prompt-file .claude/rules.md --model x wrapped=yes",
        ]);
      } finally {
        c.stop();
      }
    }, 30_000);

    for (const [name, opts, env] of [
      ["RELAY_NO_WRAP is set", {}, { RELAY_NO_WRAP: "1" }],
      ["relay is missing", { relay: false }, {}],
      ["the helper is stopped", { helper: false }, {}],
    ] as const) {
      test(`claude still starts when ${name}`, async () => {
        const c = chain(opts);
        try {
          await inTerminal(c.home, "claude hi", env);
          expect(c.lines().at(-1)).toBe("real --append-system-prompt-file .claude/rules.md hi wrapped=");
        } finally {
          c.stop();
        }
      }, 30_000);
    }
  },
);

test("without a terminal (claude -p, a pipe) the real claude starts directly", async () => {
  const c = chain();
  try {
    const r = await run(c.home, ["/bin/zsh", "-ic", "claude -p hello | cat"]);
    expect(r.code).toBe(0);
    expect(c.lines().at(-1)).toBe("real --append-system-prompt-file .claude/rules.md -p hello wrapped=");
  } finally {
    c.stop();
  }
}, 30_000);

test("the program never calls itself when it is the only claude", async () => {
  const { home, bin } = makeHome({});
  placeShim(shim, join(bin, "claude"));
  const r = await run(home, [join(bin, "claude")], { PATH: `${bin}:/usr/bin:/bin` });
  expect(r.code).toBe(127);
  expect(readdirSync(bin)).toEqual(["claude"]);
});

describe("relay doctor", () => {
  async function terminalsLine(
    setup: (h: ReturnType<typeof makeHome>) => void,
    env: Record<string, string> = {},
  ) {
    const h = makeHome({});
    mkdirSync(h.bin, { recursive: true });
    writeFileSync(
      join(h.home, ".relay", "config.json"),
      JSON.stringify({ relayUrl: "https://relay.invalid", port: 59173 }),
    );
    setup(h);
    const proc = Bun.spawn([process.execPath, resolve(ROOT, "mac/src/cli.ts"), "doctor"], {
      env: {
        HOME: h.home,
        RELAY_HOME: join(h.home, ".relay"),
        PATH: "/usr/bin:/bin",
        TMUX_TMPDIR: h.home,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      out += decoder.decode(chunk);
      if (/new terminals:.*\n/.test(out)) break;
    }
    proc.kill();
    await proc.exited;
    return out.split("\n").find((l) => l.includes("new terminals:")) ?? "(no line)";
  }

  test("not set up", async () => {
    expect(await terminalsLine(() => {})).toContain("not set up");
  }, 30_000);

  test("program there but no startup lines", async () => {
    const line = await terminalsLine((h) => placeShim(shim, join(h.bin, "claude")));
    expect(line).toContain("no Relay lines");
  }, 30_000);

  test("set up, helper stopped", async () => {
    const line = await terminalsLine((h) => {
      placeShim(shim, join(h.bin, "claude"));
      addShellBlocks(h.bin, ["zsh", "bash"], h.home);
    });
    expect(line).toContain("set up for zsh, bash");
    expect(line).toContain("until the helper runs");
  }, 30_000);

  test("RELAY_NO_WRAP in the shell is said", async () => {
    const line = await terminalsLine(
      (h) => {
        placeShim(shim, join(h.bin, "claude"));
        addShellBlocks(h.bin, ["zsh"], h.home);
      },
      { RELAY_NO_WRAP: "1" },
    );
    expect(line).toContain("RELAY_NO_WRAP");
  }, 30_000);

  test("helper running", async () => {
    let server: { stop(force?: boolean): void } | null = null;
    const line = await terminalsLine((h) => {
      placeShim(shim, join(h.bin, "claude"));
      addShellBlocks(h.bin, ["zsh"], h.home);
      server = Bun.serve({ unix: join(h.home, ".relay", "hook.sock"), fetch: () => Response.json({}) });
    });
    (server as { stop(force?: boolean): void } | null)?.stop(true);
    expect(line).toContain("✅");
    expect(line).toContain("starts through Relay (zsh)");
  }, 30_000);
});

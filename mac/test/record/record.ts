/**
 * Records short real Claude Code sessions (Haiku) and saves their transcripts, redacted, as the fixtures under
 * mac/test/fixtures/transcripts/. Run it when Claude Code changes its transcript format:
 *
 *   bun run record:transcripts [scenario ...]      (no names: all of them)
 *   bun protocol/fixtures.ts                       (then: the protocol fixtures the apps decode)
 *   bun test                                       (and read what the new shapes changed)
 *
 * Each scenario is a real interactive `claude --model haiku` driven through its own tmux server, in a scratch
 * folder under the temp folder, with only the project's settings (no hooks of yours reach the helper, no MCP
 * servers, no memory). Nothing touches your own sessions. Needs `claude` and `tmux` on the PATH and costs a few cents.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { type Context, firstTimestamp, sanitizeMeta, sanitizeTranscript } from "./sanitize.ts";

const OUT = join(import.meta.dir, "..", "fixtures", "transcripts");
const SOCKET = `relay-record-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmux(...args: string[]): string {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
  return r.stdout ?? "";
}

interface Scenario {
  name: string;
  about: string;
  /** Drives the session; `s` types, pastes, presses keys and waits. */
  run: (s: Session) => Promise<void>;
}

class Session {
  constructor(
    readonly id: string,
    readonly dir: string,
    private readonly transcript: () => string | null,
  ) {}

  pane(): string {
    return tmux("capture-pane", "-t", "r", "-p");
  }
  entries(): Record<string, unknown>[] {
    const p = this.transcript();
    if (!p) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  }
  /** How many turns have ended: Claude Code's `turn_duration` entries and its interrupt markers. */
  endedTurns(): number {
    return this.entries().filter(
      (e) =>
        (e.type === "system" && e.subtype === "turn_duration") ||
        (e.type === "user" && JSON.stringify(e.message).includes("[Request interrupted by user")),
    ).length;
  }
  async until(what: string, ok: () => boolean, timeoutMs = 90_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (ok()) return;
      await sleep(400);
    }
    throw new Error(`timed out waiting for ${what}\n${this.pane().slice(-1500)}`);
  }
  type(text: string): void {
    tmux("send-keys", "-t", "r", "-l", text);
  }
  enter(): void {
    tmux("send-keys", "-t", "r", "Enter");
  }
  key(k: string): void {
    tmux("send-keys", "-t", "r", k);
  }
  /** Like dropping a file on the terminal: a bracketed paste of its path, which Claude Code turns into [Image #N]. */
  paste(text: string): void {
    const r = spawnSync("tmux", ["-L", SOCKET, "load-buffer", "-"], { input: text });
    if (r.status !== 0) throw new Error("tmux load-buffer failed");
    tmux("paste-buffer", "-p", "-t", "r");
  }
  /** Sends a prompt and waits for its turn to end. */
  async ask(text: string, opts: { paste?: string } = {}): Promise<void> {
    const before = this.endedTurns();
    if (opts.paste) {
      this.paste(opts.paste);
      await sleep(1200);
    }
    this.type(text);
    await sleep(600);
    this.enter();
    await this.until("the turn to end", () => this.endedTurns() > before);
    await sleep(1500);
  }
}

/** A 32x32 red PNG, made here so nothing binary is committed to record it. */
function redPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const w = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: w }, () => [220, 40, 40]).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: w }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const SCENARIOS: Scenario[] = [
  {
    name: "plain",
    about: "A plain prompt and its answer.",
    run: async (s) => {
      await s.ask("Say hello in exactly five words.");
    },
  },
  {
    name: "image",
    about: "A prompt with an image: the prompt holds an [Image #1] token and an image block.",
    run: async (s) => {
      await s.ask("what colour is this? one word", { paste: join(s.dir, "red.png") });
    },
  },
  {
    name: "stop",
    about: "Stop mid-answer (the interrupt marker), then a new prompt.",
    run: async (s) => {
      const before = s.endedTurns();
      s.type("Write a 1500 word story about a lighthouse keeper. Do not use any tools.");
      await sleep(600);
      s.enter();
      // Esc before Claude has written anything takes the prompt back out of the conversation: wait for its text.
      await s.until("the answer to start", () => s.pane().includes("⏺"), 30_000);
      await sleep(1500);
      s.key("Escape");
      await s.until("the interrupt", () => s.endedTurns() > before);
      await sleep(1500);
      await s.ask("Say OK.");
    },
  },
  {
    name: "subagent",
    about: "A sub-agent: the Agent call in the transcript and the agent's own transcript beside it.",
    run: async (s) => {
      await s.ask(
        "Use the Agent tool once, with the general-purpose agent, to count the .txt files in this folder. Run the agent in the foreground and wait for it. Then tell me the number.",
      );
    },
  },
  {
    name: "background",
    about: "A background shell, and the turn Claude Code starts itself when it ends (a task notification).",
    run: async (s) => {
      const before = s.endedTurns();
      s.type(
        "Run `sleep 12; echo finished` with the Bash tool in the background (run_in_background). Then tell me it started, and nothing more.",
      );
      await sleep(600);
      s.enter();
      await s.until("the first turn", () => s.endedTurns() > before);
      await s.until("the notification turn", () => s.endedTurns() > before + 1, 120_000);
      await sleep(1500);
    },
  },
  {
    name: "failed-tool",
    about: "A tool that fails (a file that isn't there).",
    run: async (s) => {
      await s.ask("Read the file missing-file.txt in this folder and tell me what it says.");
    },
  },
];

function findTranscript(id: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

function freshScratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-record-")));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const n of ["notes", "todo", "ideas"]) writeFileSync(join(dir, `${n}.txt`), `${n}\n`);
  writeFileSync(join(dir, "red.png"), redPng());
  // Only the project's own settings count; nothing here needs a permission prompt.
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash", "Read", "Write", "Edit", "Agent"] } }),
  );
  return dir;
}

async function record(sc: Scenario): Promise<void> {
  const dir = freshScratch();
  const id = crypto.randomUUID();
  const session = new Session(id, dir, () => findTranscript(id));
  tmux("kill-server");
  tmux(
    "new-session",
    "-d",
    "-s",
    "r",
    "-x",
    "140",
    "-y",
    "50",
    "-c",
    dir,
    `claude --model haiku --setting-sources project,local --strict-mcp-config --session-id ${id}`,
  );
  try {
    await session.until(
      "Claude Code to start",
      () => {
        const p = session.pane();
        if (/trust this folder/i.test(p)) {
          session.key("Down");
          session.key("Enter");
        }
        return /Try "|\? for shortcuts|auto mode|accept edits/.test(p) && !/trust this folder/i.test(p);
      },
      60_000,
    );
    await sleep(1500);
    await sc.run(session);
    const path = findTranscript(id);
    if (!path) throw new Error("no transcript was written");
    save(sc, id, dir, path);
    console.log(`recorded ${sc.name}`);
  } finally {
    tmux("kill-server");
    rmSync(dir, { recursive: true, force: true });
  }
}

function save(sc: Scenario, id: string, dir: string, path: string): void {
  const raw = readFileSync(path, "utf8");
  const ctx: Context = {
    cwds: [...new Set([dir, dir.replace(/^\/private/, "")])],
    home: homedir(),
    user: userInfo().username,
    sessionId: id,
    fixedSessionId: `rec-${sc.name}`,
    firstAt: firstTimestamp(raw),
  };
  const dest = join(OUT, sc.name);
  rmSync(dest, { recursive: true, force: true });
  rmSync(`${dest}.jsonl`, { force: true });
  mkdirSync(OUT, { recursive: true });
  // The agents' transcripts sit where the helper looks for them: <name>/subagents/ next to <name>.jsonl.
  const sub = `${path.replace(/\.jsonl$/, "")}/subagents`;
  if (existsSync(sub)) {
    mkdirSync(join(dest, "subagents"), { recursive: true });
    for (const f of readdirSync(sub)) {
      const text = readFileSync(join(sub, f), "utf8");
      if (f.endsWith(".jsonl"))
        writeFileSync(join(dest, "subagents", f), sanitizeTranscript(text, { ...ctx, firstAt: ctx.firstAt }));
      else if (f.endsWith(".meta.json")) writeFileSync(join(dest, "subagents", f), sanitizeMeta(text, ctx));
    }
  }
  writeFileSync(join(OUT, `${sc.name}.jsonl`), sanitizeTranscript(raw, ctx));
  const version = /"version":"([^"]+)"/.exec(raw)?.[1] ?? "unknown";
  const meta = JSON.parse(
    existsSync(join(OUT, "index.json")) ? readFileSync(join(OUT, "index.json"), "utf8") : "{}",
  );
  meta[sc.name] = {
    about: sc.about,
    claudeVersion: version,
    recordedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(join(OUT, "index.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

if (import.meta.main) {
  for (const bin of ["claude", "tmux"]) {
    if (spawnSync("which", [bin]).status !== 0) {
      console.error(`${bin} is not on the PATH`);
      process.exit(1);
    }
  }
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length) {
    console.error(
      `unknown scenario: ${unknown.join(", ")} (have: ${SCENARIOS.map((s) => s.name).join(", ")})`,
    );
    process.exit(1);
  }
  for (const sc of SCENARIOS) if (!wanted.length || wanted.includes(sc.name)) await record(sc);
  console.log("done. Next: bun protocol/fixtures.ts && bun test");
}

// `relay attach`: shows a chat running in a `relay host` in your terminal and passes keys both ways.
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { paths } from "../config.ts";
import { processState } from "../platform/processIdentity.ts";
import { type HostState, hostSaved, readHostState } from "./ptyHost.ts";

/** Ctrl-] leaves the chat running, as in telnet. */
export const DETACH_KEY = 0x1d;

export interface Chat {
  /** The first 8 characters of the session id. */
  id: string;
  name: string | null;
  state: HostState;
}

export interface KnownSession {
  id: string;
  name: string | null;
  project: string;
  status: string;
}

/** The chats with a host still running, named from the sessions the daemon knows. */
export function runningChats(dir: string, sessions: KnownSession[]): Chat[] {
  const out: Chat[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names.sort()) {
    if (!file.startsWith("h-") || !file.endsWith(".json")) continue;
    const id = file.slice(2, -5);
    const state = readHostState(dir, id);
    if (!state || state.exited || processState(state.hostPid, hostSaved(dir, id, state)) === "dead") continue;
    const s = sessions.find((x) => x.id.startsWith(id));
    out.push({ id, name: s ? (s.name ?? s.project) : null, state });
  }
  return out;
}

export type Pick = { chat: Chat } | { error: string };

/** Finds one chat by id prefix or part of its name. */
export function pickChat(query: string, chats: Chat[], sessions: KnownSession[]): Pick {
  const q = query.toLowerCase();
  const byId = chats.filter((c) => c.id.startsWith(q) || q.startsWith(c.id));
  const found = byId.length > 0 ? byId : chats.filter((c) => c.name?.toLowerCase().includes(q));
  if (found.length === 1) return { chat: found[0] as Chat };
  if (found.length > 1)
    return {
      error: `More than one chat matches "${query}": ${found.map((c) => c.id).join(", ")}. Use more of the id.`,
    };
  const ended = sessions.find((s) => s.id.startsWith(q) || (s.name ?? s.project).toLowerCase().includes(q));
  return {
    error: ended
      ? `That chat isn't running in Relay's terminal. To continue it: claude --resume ${ended.id}`
      : `No chat matches "${query}". If it ended, continue it with: claude --resume <id>`,
  };
}

export function chatList(chats: Chat[]): string {
  if (chats.length === 0) return "No chats are running in Relay's terminal.";
  return chats.map((c) => `${c.id}  ${c.name ?? ""}`.trimEnd()).join("\n");
}

export interface AttachIO {
  socket: string;
  token: string;
  size(): { cols: number; rows: number };
  stdin: {
    on(event: "data", cb: (d: Buffer) => void): unknown;
    on(event: "end", cb: () => void): unknown;
  };
  write(data: string | Uint8Array): void;
  /** Called with a function that reports a changed window size. */
  onResize(cb: () => void): void;
}

export type AttachResult = "detached" | "ended" | "refused";

/** Bridges the terminal to the chat until the detach key, the window closing, or the chat ending. */
export function attachTo(io: AttachIO): Promise<AttachResult> {
  return new Promise((resolve) => {
    const sock = connect(io.socket);
    let acked = false;
    let head = "";
    let finished = false;
    const finish = (result: AttachResult) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve(result);
    };
    sock.on("error", () => finish(acked ? "ended" : "refused"));
    sock.on("close", () => finish(acked ? "ended" : "refused"));
    sock.on("connect", () => {
      const { cols, rows } = io.size();
      sock.write(`${JSON.stringify({ op: "attach", token: io.token, cols, rows })}\n`);
    });
    sock.on("data", (chunk) => {
      if (acked) return io.write(chunk);
      head += chunk.toString("latin1");
      const nl = head.indexOf("\n");
      if (nl === -1) return;
      let ok = false;
      try {
        ok = JSON.parse(head.slice(0, nl)).ok === true;
      } catch {
        // not a reply
      }
      if (!ok) return finish("refused");
      acked = true;
      const rest = Buffer.from(head.slice(nl + 1), "latin1");
      if (rest.length > 0) io.write(rest);
    });
    io.stdin.on("data", (d) => {
      if (!acked) return;
      const at = d.indexOf(DETACH_KEY);
      if (at === -1) return void sock.write(d);
      if (at > 0) sock.write(d.subarray(0, at));
      finish("detached");
    });
    io.stdin.on("end", () => finish("detached"));
    io.onResize(() => {
      if (!acked) return;
      const { cols, rows } = io.size();
      sock.write(`\x1b]relay;resize;${cols};${rows}\x07`);
    });
  });
}

async function knownSessions(): Promise<KnownSession[]> {
  try {
    const res = await fetch("http://relay/admin/rpc", {
      method: "POST",
      unix: paths.hookSock,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "sessions.list", params: { includeEnded: true } }),
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { result?: KnownSession[] };
    return body.result ?? [];
  } catch {
    return [];
  }
}

/** `relay attach [chat]`; returns the exit code. */
export async function runAttach(args: string[]): Promise<number> {
  const dir = join(paths.home, "pty");
  const sessions = await knownSessions();
  const chats = runningChats(dir, sessions);
  const query = args[0];
  if (query === undefined) {
    console.log(chatList(chats));
    return 0;
  }
  const pick = pickChat(query, chats, sessions);
  if ("error" in pick) {
    console.error(pick.error);
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("relay attach needs a terminal.");
    return 1;
  }
  const { stdin, stdout } = process;
  // The alternate screen keeps your scrollback intact, and leaving it puts the window back as it was.
  stdout.write("\x1b[?1049h");
  stdin.setRawMode(true);
  stdin.resume();
  const restore = () => {
    try {
      stdin.setRawMode(false);
    } catch {
      // the terminal is gone
    }
    stdout.write("\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
  };
  const result = await attachTo({
    socket: pick.chat.state.socket,
    token: pick.chat.state.token,
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    stdin,
    write: (d) => stdout.write(d),
    onResize: (cb) => {
      process.on("SIGWINCH", cb);
    },
  });
  restore();
  stdin.pause();
  if (result === "refused") {
    console.error("This chat doesn't take attaching. Restart it to use `relay attach`.");
    return 1;
  }
  console.log(
    result === "detached" ? `Detached; the chat keeps running (${pick.chat.id}).` : "The chat ended.",
  );
  return 0;
}

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  graphemes,
  TURN_STEP_DETAIL_MAX,
  TURN_STEP_DETAIL_UNITS,
  TURN_STEP_OUTPUT_LINES,
  TURN_STEP_OUTPUT_MAX,
  TURN_STEP_OUTPUT_UNITS,
  type TurnStep,
} from "../../../protocol/index.ts";
import { AgentRuns, isAgentTool, textOf } from "./agents.ts";
import { redact } from "./redact.ts";
import { fitLabel, oneLine, stepFor, withoutBidiControls } from "./steps.ts";

/**
 * Turn timeline: each action with its tool, title and detail, and each thinking
 * line, built from transcript entries the same way live and in a finished turn. Only short, redacted text leaves
 * the Mac: the command, a path, a pattern, a site, an agent's description, and the end of what a shell command
 * printed. Never file contents, edit text, another tool's output, web search queries, agent prompts or thinking
 * text.
 */

const EDIT_OR_READ = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** The tool's name as people see it: an MCP tool's own name, else the tool's. */
export function toolShown(toolName: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return mcp ? (mcp[2] as string) : toolName;
}

/** Relative to the session's folder when inside it, else the full path with the home folder as `~`. */
export function detailPath(file: string, cwd: string | null): string {
  const dir = cwd ? normalize(cwd).replace(/\/+$/, "") : null;
  const full = normalize(isAbsolute(file) || !dir ? file : join(dir, file));
  if (dir && full.startsWith(`${dir}/`)) return full.slice(dir.length + 1);
  const home = homedir().replace(/\/+$/, "");
  return full === home || full.startsWith(`${home}/`) ? `~${full.slice(home.length)}` : full;
}

/** Redacted whole first, then at most TURN_STEP_DETAIL_MAX characters (an ellipsis included), never half a character. */
export function cutDetail(text: string): string {
  const shown = redact(withoutBidiControls(text)).replace(/\r\n/g, "\n").trim();
  const g = graphemes(shown);
  if (g.length <= TURN_STEP_DETAIL_MAX && shown.length <= TURN_STEP_DETAIL_UNITS) return shown;
  const kept: string[] = [];
  let units = 1;
  for (const ch of g) {
    if (kept.length >= TURN_STEP_DETAIL_MAX - 1 || units + ch.length > TURN_STEP_DETAIL_UNITS) break;
    kept.push(ch);
    units += ch.length;
  }
  return `${kept.join("").trimEnd()}…`;
}

/** An empty text has no lines; a line break at the very end doesn't start one. */
export function lineCount(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < text.length - 1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

export interface EditCounts {
  added?: number;
  removed?: number;
}

/**
 * How many lines an edit puts in and takes out, from what Claude asked for (the file is never read). With
 * `replace_all` it is one occurrence's lines. A written file or notebook cell has no `removed`.
 */
export function editCounts(toolName: string, input: Record<string, unknown> | undefined): EditCounts {
  const i = input ?? {};
  const pair = (edit: unknown): [number, number] | null => {
    const e = edit as { old_string?: unknown; new_string?: unknown } | null;
    return e && typeof e.old_string === "string" && typeof e.new_string === "string"
      ? [lineCount(e.new_string), lineCount(e.old_string)]
      : null;
  };
  if (toolName === "Edit") {
    const one = pair(i);
    return one ? { added: one[0], removed: one[1] } : {};
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(i.edits) || !i.edits.length) return {};
    let added = 0;
    let removed = 0;
    for (const edit of i.edits) {
      const one = pair(edit);
      if (!one) return {};
      added += one[0];
      removed += one[1];
    }
    return { added, removed };
  }
  if (toolName === "Write") return typeof i.content === "string" ? { added: lineCount(i.content) } : {};
  if (toolName === "NotebookEdit")
    return typeof i.new_source === "string" && i.edit_mode !== "delete"
      ? { added: lineCount(i.new_source) }
      : {};
  return {};
}

export interface CommandOutput {
  output?: string;
  outputCut?: true;
}

const ESCAPE_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this removes
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[PX^_][^\x1b\n]*(?:\x1b\\)?|[ -/]*[0-~])?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Without escape sequences and control characters; a line a carriage return rewrote keeps its last text. */
function plainText(text: string): string {
  const plain = withoutBidiControls(text.replace(ESCAPE_SEQUENCES, "").replace(CONTROLS, ""));
  if (!plain.includes("\r")) return plain;
  return plain
    .split("\n")
    .map((line) => {
      let end = line.length;
      while (end > 0 && line.charCodeAt(end - 1) === 13) end--;
      return line.slice(end > 0 ? line.lastIndexOf("\r", end - 1) + 1 : 0, end);
    })
    .join("\n");
}

/**
 * What a command printed, as the phone may show it: redacted whole, then without control codes, then its last
 * TURN_STEP_OUTPUT_LINES lines and TURN_STEP_OUTPUT_MAX characters. Nothing for a command that printed nothing.
 */
export function shownOutput(raw: string): CommandOutput {
  const redacted = redact(raw);
  const plain = plainText(redacted);
  // An escape sequence inside a secret hides it from the first pass.
  const text = (plain === redacted ? plain : redact(plain)).trimEnd();
  if (!text.trim()) return {};
  const lines = text.split("\n");
  const last = lines.length > TURN_STEP_OUTPUT_LINES ? lines.slice(-TURN_STEP_OUTPUT_LINES).join("\n") : text;
  // Characters are counted on a piece twice the size kept, so one cut at the piece's start is never kept.
  const g = graphemes(last.slice(-2 * TURN_STEP_OUTPUT_UNITS));
  let from = g.length;
  let units = 0;
  while (from > 0 && g.length - from < TURN_STEP_OUTPUT_MAX) {
    units += (g[from - 1] as string).length;
    if (units > TURN_STEP_OUTPUT_UNITS) break;
    from--;
  }
  let kept = g.slice(from).join("");
  if (!kept.trim()) return {};
  if (kept.length < last.length && last[last.length - kept.length - 1] !== "\n") {
    // The cut fell inside a line: start at the next whole one, when there is one.
    const next = kept.indexOf("\n");
    if (next !== -1) kept = kept.slice(next + 1);
  }
  return kept.length < text.length ? { output: kept, outputCut: true } : { output: kept };
}

/**
 * A shell command's output as its result's transcript entry has it. A command that ended: the entry's
 * `toolUseResult` (`stdout`, then `stderr`). One that failed: the result's text after its "Exit code N" line.
 * Null when the entry has neither: a refused call, an image, a command still running in the background, or an
 * output Claude Code kept only the start of.
 */
function recordedOutput(entry: TimelineEntry, block: Block, alone: boolean): string | null {
  if (block.is_error) {
    const text = textOf(block.content);
    const exit = /^Exit code \d+(?:\n|$)/.exec(text);
    if (!exit || text.includes("<persisted-output>")) return null;
    return text.slice(exit[0].length).replace(FOLDER_NOTE, "");
  }
  const r = entry.toolUseResult;
  if (!alone || !r || typeof r !== "object" || Array.isArray(r)) return null;
  const result = r as {
    stdout?: unknown;
    stderr?: unknown;
    isImage?: unknown;
    persistedOutputPath?: unknown;
    backgroundTaskId?: unknown;
  };
  if (result.isImage === true) return null;
  if (result.persistedOutputPath !== undefined || result.backgroundTaskId !== undefined) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.replace(FOLDER_NOTE, "") : "";
  return [stdout.trimEnd(), stderr].filter((part) => part.trim()).join("\n");
}

/** Claude Code's own line about the folder, not the command's. */
const FOLDER_NOTE = /^Shell cwd was reset to .*$/gm;

/** The step as a phone that doesn't reassemble pieces gets it: a turn's outputs could pass one relay frame. */
export function withoutOutput<S extends { output?: string; outputCut?: boolean }>(step: S): S {
  if (step.output === undefined && step.outputCut === undefined) return step;
  const { output: _o, outputCut: _c, ...rest } = step;
  return rest as S;
}

/** The fields an action adds to its step: the tool, its own title, the detail the phone may show, an edit's counts. */
export function actionFields(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | null,
): { tool: string; title?: string; detail?: string } & EditCounts {
  const i = input ?? {};
  const out: { tool: string; title?: string; detail?: string } & EditCounts = {
    tool: toolShown(toolName || "Tool"),
    ...editCounts(toolName, input),
  };
  const description = str(i.description);
  if (description && (toolName === "Bash" || toolName === "Task" || toolName === "Agent"))
    out.title = fitLabel(oneLine(redact(description)));
  let detail: string | null = null;
  if (toolName === "Bash") detail = str(i.command);
  else if (EDIT_OR_READ.has(toolName)) {
    const file = str(i.file_path) ?? str(i.notebook_path);
    detail = file ? detailPath(file, cwd) : null;
  } else if (toolName === "Grep" || toolName === "Glob") {
    const pattern = str(i.pattern);
    const path = str(i.path);
    detail = pattern ? (path ? `${pattern} in ${detailPath(path, cwd)}` : pattern) : null;
  } else if (toolName === "WebFetch") {
    try {
      detail = typeof i.url === "string" ? new URL(i.url).hostname.replace(/^www\./, "") || null : null;
    } catch {
      detail = null;
    }
  }
  if (detail) out.detail = cutDetail(detail);
  return out;
}

/** "4s", "1m 5s": how long a thinking line took. */
export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function thoughtStep(id: string, at: number, durationMs: number): TurnStep {
  const ms = Math.max(1000, durationMs);
  return { kind: "thinking", label: `Thought for ${durationText(ms)}`, id, at, durationMs: ms };
}

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

export interface TimelineEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  parentUuid?: string | null;
  agentId?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
}

/**
 * Reads transcript entries in order and keeps the turn's actions (one per `tool_use` of the main conversation,
 * failed when its `tool_result` says `is_error`) and thinking lines (one per thinking block, timed from the
 * previous main-conversation entry). `add` returns what the entry added or changed, for the live events.
 */
export class TimelineReader {
  readonly actions: TurnStep[] = [];
  readonly thoughts: TurnStep[] = [];
  private readonly byId = new Map<string, TurnStep>();
  private readonly liveLabels = new Map<string, string>();
  private readonly agents: AgentRuns;
  private readonly sidechain: boolean;
  private lastAt: number | null;

  /**
   * `sidechain`: the entries are a subagent's own (agent-progress), so they are read, not skipped. `transcriptPath`:
   * where the session's transcript is; its `subagents` folder holds the agents' transcripts.
   */
  constructor(
    private readonly cwd: string | null,
    startedAt: number | null = null,
    opts: { sidechain?: boolean; transcriptPath?: string | null } = {},
  ) {
    this.lastAt = startedAt;
    this.sidechain = opts.sidechain === true;
    this.agents = new AgentRuns(cwd, opts.transcriptPath ?? null);
  }

  /** When the last entry was written (ms), if any had a time. */
  get lastEntryAt(): number | null {
    return this.lastAt;
  }

  /** An action's step in the live form ("Reading lib.ts"), for an agent's current step. */
  liveLabel(id: string): string | null {
    return this.liveLabels.get(id) ?? null;
  }

  /** Reads what the agents' transcripts have now; the agent steps that changed. */
  refreshAgents(): TurnStep[] {
    return this.agents.refresh();
  }

  /** The turn is over: its agent steps no longer say they run. */
  finish(): void {
    this.agents.finalize();
  }

  add(entry: TimelineEntry): TurnStep[] {
    if (!entry) return [];
    if (entry.isSidechain && !this.sidechain) return this.agents.sidechain(entry);
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    // Without a timestamp, the time of the entry before it, so the item doesn't sort to 1970.
    const at = Number.isNaN(ts) ? (this.lastAt ?? 0) : ts;
    const changed: TurnStep[] = [];
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      content.forEach((raw, index) => {
        const block = raw as Block;
        if (!block || typeof block !== "object") return;
        if (entry.type === "assistant" && block.type === "thinking") {
          const base = typeof entry.uuid === "string" ? entry.uuid : `t${at}-${this.thoughts.length}`;
          const id = `${base}${index ? `:${index}` : ""}`;
          if (this.byId.has(id)) return;
          const step = thoughtStep(id, at, this.lastAt !== null && at ? at - this.lastAt : 0);
          // A second thinking block in the same entry doesn't claim the same gap again.
          if (!Number.isNaN(ts)) this.lastAt = ts;
          this.thoughts.push(step);
          this.byId.set(id, step);
          changed.push(step);
        } else if (entry.type === "assistant" && block.type === "tool_use") {
          // A malformed transcript can have a name or id that isn't a string: leave those out.
          const name = typeof block.name === "string" ? block.name : "";
          const toolId = typeof block.id === "string" && block.id ? block.id : null;
          if (toolId && this.byId.has(toolId)) return;
          const input = block.input && typeof block.input === "object" ? block.input : undefined;
          const step: TurnStep = {
            ...stepFor(name, input, this.cwd, "done"),
            at,
            ...(toolId ? { id: toolId } : {}),
            ...actionFields(name, input, this.cwd),
          };
          this.actions.push(step);
          if (toolId) {
            this.byId.set(toolId, step);
            if (this.sidechain) this.liveLabels.set(toolId, stepFor(name, input, this.cwd, "live").label);
          }
          if (toolId && (isAgentTool(name) || name === "Workflow") && !this.sidechain)
            this.agents.start(step, name, input, entry.uuid);
          changed.push(step);
        } else if (entry.type === "user" && block.type === "tool_result" && block.tool_use_id) {
          const step = this.byId.get(block.tool_use_id);
          if (!step || step.kind === "thinking") return;
          let touched = false;
          if (block.is_error && !step.failed) {
            step.failed = true;
            // A failed edit changed nothing.
            delete step.added;
            delete step.removed;
            touched = true;
          }
          if (step.kind === "run" && !this.sidechain && step.output === undefined) {
            const alone = content.filter((b) => (b as Block | null)?.type === "tool_result").length === 1;
            const recorded = recordedOutput(entry, block, alone);
            const shown = recorded ? shownOutput(recorded) : {};
            if (shown.output !== undefined) {
              Object.assign(step, shown);
              touched = true;
            }
          }
          if (this.agents.result(block.tool_use_id, textOf(block.content), ts)) touched = true;
          if (touched) changed.push(step);
        }
      });
    }
    // A background agent's or workflow's end arrives as a task notification (a user entry with text).
    if (entry.type === "user" && !this.sidechain && !this.agents.empty) {
      const text = textOf(content);
      if (text.includes("<task-notification>"))
        for (const s of this.agents.notification(text, ts)) changed.push(s);
    }
    if ((entry.type === "user" || entry.type === "assistant") && !Number.isNaN(ts)) this.lastAt = ts;
    return changed;
  }
}

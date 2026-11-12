import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  graphemes,
  TURN_STEP_DETAIL_MAX,
  TURN_STEP_DETAIL_UNITS,
  type TurnStep,
} from "../../../protocol/index.ts";
import { AgentRuns, isAgentTool, textOf } from "./agents.ts";
import { redact } from "./redact.ts";
import { fitLabel, oneLine, stepFor, withoutBidiControls } from "./steps.ts";

/**
 * Turn timeline: each action with its tool, title and detail, and each thinking
 * line, built from transcript entries the same way live and in a finished turn. Only short, redacted text leaves
 * the Mac: the command, a path, a pattern, a site, an agent's description. Never file contents, edit text, tool
 * output, web search queries, agent prompts or thinking text.
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

/** The fields an action adds to its step: the tool, its own title, and the detail the phone may show. */
export function actionFields(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | null,
): { tool: string; title?: string; detail?: string } {
  const i = input ?? {};
  const out: { tool: string; title?: string; detail?: string } = { tool: toolShown(toolName || "Tool") };
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
            touched = true;
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

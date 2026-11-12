import { basename, isAbsolute, join, normalize } from "node:path";
import {
  graphemes,
  TURN_STEP_LABEL_MAX,
  TURN_STEP_LABEL_UNITS,
  TURN_STEPS_MAX,
  TURN_THOUGHTS_MAX,
  type TurnStep,
  type TurnStepKind,
} from "../../../protocol/index.ts";
import type { EventLog } from "./events.ts";
import { redact } from "./redact.ts";
import { actionFields, type TimelineEntry, TimelineReader } from "./timeline.ts";

/**
 * Turn steps: the words the phones show for what Claude is doing, built here
 * so both phones show the same text. Only short, redacted labels leave the Mac: never file contents, edit
 * text, the rest of a command, tool output, URL paths, search queries or agent prompts.
 */

export type Tense = "live" | "done";

const PATH_MAX = 60;
const COMMAND_MAX = 40;
const PATTERN_MAX = 30;
const AGENT_MAX = 50;
const SKILL_MAX = 30;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` characters as people see them (an emoji or an accented letter counts once, never split). */
function clip(text: string, max: number): string {
  const g = graphemes(text);
  return g.length > max ? `${g.slice(0, max - 1).join("")}…` : text;
}

/**
 * At most TURN_STEP_LABEL_MAX characters as people see them and TURN_STEP_LABEL_UNITS UTF-16 units (many
 * combining marks on one character), cut between characters with "…".
 */
/**
 * Without invisible text-direction controls (embeddings, overrides, isolates, marks): in a label they can reverse
 * what follows on the phone, as in `build \u202Egnp.exe` showing as "exe.png".
 */
export function withoutBidiControls(text: string): string {
  return text.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "");
}

export function fitLabel(text: string): string {
  const clipped = clip(withoutBidiControls(text), TURN_STEP_LABEL_MAX);
  if (clipped.length <= TURN_STEP_LABEL_UNITS) return clipped;
  const kept: string[] = [];
  let units = 1; // the "…"
  for (const g of graphemes(clipped)) {
    if (units + g.length > TURN_STEP_LABEL_UNITS) break;
    kept.push(g);
    units += g.length;
  }
  return `${kept.join("").replace(/…$/, "")}…`;
}

/** The last `max` characters as people see them, with "…" in front when cut. */
function clipStart(text: string, max: number): string {
  const g = graphemes(text);
  return g.length > max ? `…${g.slice(g.length - (max - 1)).join("")}` : text;
}

/**
 * Relative to the session's folder when inside it (after resolving `..`), else only the file name; long
 * paths keep their end.
 */
export function shortPath(file: string, cwd: string | null): string {
  const dir = cwd ? normalize(cwd).replace(/\/+$/, "") : null;
  const full = normalize(isAbsolute(file) || !dir ? file : join(dir, file));
  let shown = dir && full.startsWith(`${dir}/`) ? full.slice(dir.length + 1) : basename(full);
  if (graphemes(shown).length > PATH_MAX) {
    const tail = graphemes(shown)
      .slice(-(PATH_MAX - 2))
      .join("");
    const slash = tail.indexOf("/");
    shown = `…/${slash >= 0 && slash < tail.length - 1 ? tail.slice(slash + 1) : basename(shown)}`;
    shown = clipStart(shown, PATH_MAX);
  }
  return shown;
}

/** The first words of a command: no `cd … &&`, no leading VAR=value, up to the first shell operator. */
export function shortCommand(command: string): string {
  let line = (command.split("\n").find((l) => l.trim()) ?? "").trim();
  for (;;) {
    const before = line;
    line = line.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
    line = line.replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "");
    if (line === before) break;
  }
  line = oneLine(line.split(/\s*(?:\|\||&&|\||;|\d*>|<|&(?!&))\s*/)[0] ?? "");
  if (graphemes(line).length > COMMAND_MAX) {
    const cut = graphemes(line)
      .slice(0, COMMAND_MAX - 1)
      .join("");
    const space = cut.lastIndexOf(" ");
    line = `${space > 10 ? cut.slice(0, space) : cut}…`;
  }
  return line;
}

function host(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h || null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** Kind and label for one tool call, in the live ("Reading …") or finished ("Read …") form. */
export function stepFor(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | null,
  tense: Tense,
): { kind: TurnStepKind; label: string } {
  const live = tense === "live";
  // Secrets are removed from the whole value before anything is cut, so a cut never leaves half a token.
  const i: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {}))
    i[k] = typeof v === "string" && k !== "url" ? redact(v) : v;
  const pick = (): { kind: TurnStepKind; label: string } => {
    const file = str(i.file_path) ?? str(i.notebook_path);
    if (toolName === "Read")
      return {
        kind: "read",
        label: file
          ? `${live ? "Reading" : "Read"} ${shortPath(file, cwd)}`
          : live
            ? "Reading"
            : "Read a file",
      };
    if (EDIT_TOOLS.has(toolName))
      return {
        kind: "edit",
        label: file
          ? `${live ? "Editing" : "Edited"} ${shortPath(file, cwd)}`
          : live
            ? "Editing"
            : "Edited a file",
      };
    if (toolName === "Bash") {
      const cmd = str(i.command) ? shortCommand(i.command as string) : "";
      return {
        kind: "run",
        label: cmd ? `${live ? "Running" : "Ran"} ${cmd}` : live ? "Running a command" : "Ran a command",
      };
    }
    if (toolName === "Grep" || toolName === "Glob") {
      const pattern = str(i.pattern);
      const shown = pattern ? `“${clip(oneLine(pattern), PATTERN_MAX)}”` : null;
      const verb = live ? "Searching" : "Searched";
      return { kind: "search", label: shown ? `${verb} for ${shown}` : verb };
    }
    if (toolName === "WebSearch")
      return { kind: "web", label: live ? "Searching the web" : "Searched the web" };
    if (toolName === "WebFetch") {
      const site = host(i.url);
      if (site) return { kind: "web", label: `${live ? "Reading" : "Read"} ${site}` };
      return { kind: "web", label: live ? "Searching the web" : "Searched the web" };
    }
    if (toolName === "Task" || toolName === "Agent") {
      const what = str(i.description);
      const base = live ? "Running an agent" : "Ran an agent";
      return { kind: "agent", label: what ? `${base}: ${clip(oneLine(what), AGENT_MAX)}` : base };
    }
    if (toolName === "TodoWrite")
      return { kind: "todo", label: live ? "Updating the to-do list" : "Updated the to-do list" };
    if (toolName === "AskUserQuestion")
      return { kind: "question", label: live ? "Asking you a question" : "Asked you a question" };
    if (toolName === "ExitPlanMode")
      return { kind: "plan", label: live ? "Showing you the plan" : "Showed you the plan" };
    if (toolName === "Skill") {
      const name = str(i.skill) ?? str(i.name);
      const shown = name ? clip(oneLine(name), SKILL_MAX) : null;
      if (shown) return { kind: "other", label: `${live ? "Running" : "Ran"} the ${shown} skill` };
      return { kind: "other", label: live ? "Running a skill" : "Ran a skill" };
    }
    if (toolName === "Workflow") {
      const script = str(i.scriptPath) ?? str(i.name) ?? str(i.workflow);
      const name = script ? basename(script).replace(/\.[A-Za-z0-9]+$/, "") : "";
      const shown = name ? clip(oneLine(name), SKILL_MAX) : null;
      if (shown) return { kind: "agent", label: `${live ? "Running" : "Ran"} the ${shown} workflow` };
      return { kind: "agent", label: live ? "Running a workflow" : "Ran a workflow" };
    }
    if (toolName === "SendMessage")
      return { kind: "other", label: live ? "Messaging another session" : "Messaged another session" };
    if (toolName === "Monitor") {
      const what = str(i.description);
      const verb = live ? "Watching" : "Watched";
      return { kind: "other", label: `${verb} for ${what ? clip(oneLine(what), AGENT_MAX) : "output"}` };
    }
    if (toolName === "TaskStop")
      return { kind: "other", label: live ? "Stopping a background task" : "Stopped a background task" };
    if (toolName === "TaskOutput")
      return { kind: "other", label: live ? "Checking a background task" : "Checked a background task" };
    if (toolName === "ToolSearch") return { kind: "other", label: live ? "Loading tools" : "Loaded tools" };
    if (toolName === "ScheduleWakeup")
      return { kind: "other", label: live ? "Scheduling a wake-up" : "Scheduled a wake-up" };
    if (toolName === "EnterWorktree")
      return { kind: "other", label: live ? "Entering a worktree" : "Entered a worktree" };
    if (toolName === "ExitWorktree")
      return { kind: "other", label: live ? "Leaving a worktree" : "Left a worktree" };
    // A tool this helper has no wording for: its name, never just "Working".
    const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
    const verb = live ? "Using" : "Used";
    return {
      kind: "other",
      label: mcp ? `${verb} ${mcp[2]} (${mcp[1]})` : `${verb} ${toolName || "a tool"}`,
    };
  };
  const { kind, label } = pick();
  return { kind, label: fitLabel(oneLine(redact(label))) };
}

export const THINKING_LABEL = "Thinking";

/** Keeps at most TURN_STEPS_MAX steps; the rest is a count. */
export function capSteps(steps: TurnStep[]): { steps: TurnStep[]; stepsMore?: number } {
  if (steps.length <= TURN_STEPS_MAX) return { steps };
  return { steps: steps.slice(0, TURN_STEPS_MAX), stepsMore: steps.length - TURN_STEPS_MAX };
}

/** A finished turn's steps and thinking lines (turn-timeline), capped, as the Turn's optional fields. */
export function timelineFields(
  steps: TurnStep[],
  thoughts: TurnStep[] = [],
): { steps?: TurnStep[]; stepsMore?: number; thoughts?: TurnStep[] } {
  const capped = capSteps(steps);
  const kept = thoughts.slice(0, TURN_THOUGHTS_MAX);
  return {
    ...(capped.steps.length ? { steps: capped.steps } : {}),
    ...(capped.stepsMore ? { stepsMore: capped.stepsMore } : {}),
    ...(kept.length ? { thoughts: kept } : {}),
  };
}

/** JSON for `turns.steps_json`; null when the turn has neither steps nor thinking lines. */
export function stepsJsonOf(f: ReturnType<typeof timelineFields>): string | null {
  return f.steps || f.thoughts ? JSON.stringify(f) : null;
}

/** `turns.steps_json` back into the Turn's optional fields; nothing for turns from before (NULL). */
export function parseStepsJson(json: string | null | undefined): {
  steps?: TurnStep[];
  stepsMore?: number;
  thoughts?: TurnStep[];
} {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as { steps?: TurnStep[]; stepsMore?: number; thoughts?: TurnStep[] };
    const steps = Array.isArray(v.steps) && v.steps.length ? v.steps : null;
    const thoughts = Array.isArray(v.thoughts) && v.thoughts.length ? v.thoughts : null;
    return {
      ...(steps ? { steps } : {}),
      ...(steps && v.stepsMore ? { stepsMore: v.stepsMore } : {}),
      ...(thoughts ? { thoughts } : {}),
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------------
// Live steps
// ---------------------------------------------------------------------------------------------------

/** The current step of each working session, read by `session.live` and `publicSession`. */
const current = new Map<string, { turnId: string; step: TurnStep }>();

export function liveStep(sessionId: string, turnId?: string): TurnStep | null {
  const entry = current.get(sessionId);
  if (!entry || (turnId !== undefined && entry.turnId !== turnId)) return null;
  return entry.step;
}

/** Tests only. */
export function resetLiveSteps(): void {
  current.clear();
}

export interface ToolCall {
  toolUseId: string | null;
  toolName: string;
  input: Record<string, unknown> | undefined;
  cwd: string | null;
  /** Set by Claude Code on tool calls made inside a subagent. */
  agentId: string | null;
}

interface TurnState {
  turnId: string;
  running: Map<string, TurnStep>;
  ended: Set<string>;
  sawPre: boolean;
  current: TurnStep;
  lastSent: string | null;
  lastSentAt: number;
  trailing: ReturnType<typeof setTimeout> | null;
  thinking: ReturnType<typeof setTimeout> | null;
  /** Finished steps as the hooks saw them: the list when there's no transcript. */
  done: TurnStep[];
}

/**
 * Follows the tool hooks of each running turn and emits `turn.step`: at most once per `throttleMs` per session
 * (the newest step wins), never the same label twice in a row, "Thinking" `thinkingDelayMs` after the last
 * tool ends unless another starts. Async hooks arrive late and not always in order, so a PreToolUse whose
 * tool already finished is ignored.
 */
/** How many replaced turns keep their steps for a late Stop. */
const SUPERSEDED_KEPT = 32;

export class StepTracker {
  private readonly turns = new Map<string, TurnState>();
  /**
   * Steps of turns a new prompt replaced before their Stop arrived (a prompt queued at the computer), by turn id,
   * for that Stop. A few are kept; a Stop that never comes doesn't keep them forever.
   */
  private readonly superseded = new Map<string, TurnStep[]>();
  private readonly throttleMs: number;
  private readonly thinkingDelayMs: number;

  constructor(
    private readonly events: EventLog,
    opts: { throttleMs?: number; thinkingDelayMs?: number } = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 1000;
    this.thinkingDelayMs = opts.thinkingDelayMs ?? 1500;
    // Going idle or ending without a Stop (the reconcile's stale check, an interrupt): the turn is over.
    events.subscribe((e) => {
      if (e.type === "session.upsert" && (e.session.status === "idle" || e.session.status === "ended"))
        this.clear(e.session.id);
    });
  }

  turnStarted(sessionId: string, turnId: string): void {
    const previous = this.turns.get(sessionId);
    if (previous) {
      this.end(sessionId, previous);
      this.superseded.set(previous.turnId, previous.done);
      for (const id of this.superseded.keys()) {
        if (this.superseded.size <= SUPERSEDED_KEPT) break;
        this.superseded.delete(id);
      }
    }
    const state: TurnState = {
      turnId,
      running: new Map(),
      ended: new Set(),
      sawPre: false,
      current: { kind: "thinking", label: THINKING_LABEL, at: Date.now() },
      lastSent: null,
      lastSentAt: 0,
      trailing: null,
      thinking: null,
      done: [],
    };
    this.turns.set(sessionId, state);
    this.show(sessionId, state, state.current);
  }

  toolStarted(sessionId: string, call: ToolCall): void {
    const state = this.turns.get(sessionId);
    if (!state || call.agentId) return;
    state.sawPre = true;
    const id = call.toolUseId ?? `anon-${Date.now()}-${Math.random()}`;
    if (state.ended.has(id)) return;
    const step = { ...stepFor(call.toolName, call.input, call.cwd, "live"), at: Date.now() };
    state.running.set(id, step);
    this.cancelThinking(state);
    this.show(sessionId, state, step);
  }

  toolEnded(sessionId: string, call: ToolCall, failed: boolean): void {
    const state = this.turns.get(sessionId);
    if (!state || call.agentId) return;
    const id = call.toolUseId;
    // A PostToolUse delivered twice is one step (ids are unique on the phones).
    if (id && state.ended.has(id)) return;
    const started = id ? state.running.get(id) : undefined;
    const doneStep: TurnStep = {
      ...stepFor(call.toolName, call.input, call.cwd, "done"),
      ...(call.toolUseId ? { id: call.toolUseId } : {}),
      ...actionFields(call.toolName, call.input, call.cwd),
      at: started?.at ?? Date.now(),
      ...(failed ? { failed: true } : {}),
    };
    state.done.push(doneStep);
    if (id) {
      state.ended.add(id);
      state.running.delete(id);
    }
    if (!started) {
      // No PreToolUse seen (yet, or ever: a session from before the hook): show this tool for now.
      this.show(sessionId, state, {
        ...stepFor(call.toolName, call.input, call.cwd, "live"),
        at: doneStep.at,
      });
    } else if (state.running.size > 0) {
      const newest = [...state.running.values()].at(-1);
      if (newest) this.show(sessionId, state, newest);
    }
    // Without PreToolUse there's no way to tell when the next tool starts, so stay on the last one.
    if (state.running.size === 0 && state.sawPre) this.scheduleThinking(sessionId, state);
  }

  /** The turn finished: returns the steps the hooks saw, and forgets the turn. */
  turnEnded(sessionId: string): TurnStep[] {
    const state = this.turns.get(sessionId);
    if (!state) return [];
    this.end(sessionId, state);
    return state.done;
  }

  /** A turn ended without a Stop hook (stopped from the phone or with Esc): like turnEnded, for that turn only. */
  endTurn(sessionId: string, turnId: string): TurnStep[] {
    const state = this.turns.get(sessionId);
    if (!state || state.turnId !== turnId) {
      this.events.deleteTurnSteps(turnId);
      const done = this.superseded.get(turnId) ?? [];
      this.superseded.delete(turnId);
      return done;
    }
    return this.turnEnded(sessionId);
  }

  /** The session ended or went idle without a Stop. */
  clear(sessionId: string): void {
    const state = this.turns.get(sessionId);
    if (state) this.end(sessionId, state);
  }

  private end(sessionId: string, state: TurnState): void {
    if (state.trailing) clearTimeout(state.trailing);
    this.cancelThinking(state);
    this.turns.delete(sessionId);
    if (current.get(sessionId)?.turnId === state.turnId) current.delete(sessionId);
    this.events.deleteTurnSteps(state.turnId);
  }

  private cancelThinking(state: TurnState): void {
    if (state.thinking) clearTimeout(state.thinking);
    state.thinking = null;
  }

  private scheduleThinking(sessionId: string, state: TurnState): void {
    this.cancelThinking(state);
    state.thinking = setTimeout(() => {
      state.thinking = null;
      if (this.turns.get(sessionId) !== state || state.running.size > 0) return;
      this.show(sessionId, state, { kind: "thinking", label: THINKING_LABEL, at: Date.now() });
    }, this.thinkingDelayMs);
  }

  private show(sessionId: string, state: TurnState, step: TurnStep): void {
    state.current = step;
    current.set(sessionId, { turnId: state.turnId, step });
    const wait = state.lastSentAt + this.throttleMs - Date.now();
    if (wait <= 0) this.send(sessionId, state);
    else if (!state.trailing)
      state.trailing = setTimeout(() => {
        state.trailing = null;
        if (this.turns.get(sessionId) === state) this.send(sessionId, state);
      }, wait);
  }

  private send(sessionId: string, state: TurnState): void {
    const step = state.current;
    if (step.label === state.lastSent) return;
    state.lastSent = step.label;
    state.lastSentAt = Date.now();
    this.events.emit({ type: "turn.step", sessionId, turnId: state.turnId, step });
  }
}

// ---------------------------------------------------------------------------------------------------
// Steps from a transcript
// ---------------------------------------------------------------------------------------------------

export class TranscriptSteps {
  private readonly reader: TimelineReader;

  private finished = false;

  /** `transcriptPath`: where the session's transcript is, to read its agents' own transcripts (agent-progress). */
  constructor(cwd: string | null, startedAt: number | null = null, transcriptPath: string | null = null) {
    this.reader = new TimelineReader(cwd, startedAt, { transcriptPath });
  }

  /** The tool calls, with their tool, title and detail (turn-timeline). Agents are read as they ended. */
  get steps(): TurnStep[] {
    if (!this.finished) {
      this.finished = true;
      this.reader.finish();
    }
    return this.reader.actions;
  }

  /** The thinking lines ("Thought for 4s"). */
  get thoughts(): TurnStep[] {
    return this.reader.thoughts;
  }

  add(entry: TimelineEntry): void {
    this.reader.add(entry);
  }
}

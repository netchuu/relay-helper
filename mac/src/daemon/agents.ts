import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TURN_STEP_CHILDREN_MAX, type TurnStep } from "../../../protocol/index.ts";
import { redact } from "./redact.ts";
import { fitLabel, oneLine } from "./steps.ts";
import { type TimelineEntry, TimelineReader } from "./timeline.ts";

/**
 * Agent progress: what an agent's or workflow's step shows beyond its own row, how
 * many steps the agent has taken, its current one, how long it ran, and its own steps.
 *
 * Where an agent's steps come from (Claude Code 2.1.x): `<session>/subagents/agent-<id>.jsonl` next to the
 * session's transcript, with `agent-<id>.meta.json` naming the Agent call (`toolUseId`), the description and
 * whether it `finished`. Older versions put the agent's entries in the main transcript with `isSidechain: true`;
 * both are read. A workflow's agents have no call of their own in the main transcript: they are the subagents
 * started after the workflow whose `toolUseId` is no Agent call's.
 *
 * Only the same short, redacted labels as for a turn's steps leave the Mac, without details.
 */

export const isAgentTool = (name: string) => name === "Task" || name === "Agent";

type Block = { type?: string; text?: string };

/** The plain text of a tool_result's content or a message's content (string or text blocks). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const block = b as Block;
      return block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("\n");
}

/** One step as the agent's list shows it: no detail, no progress of its own. */
function childOf(step: TurnStep): TurnStep {
  const { detail: _d, children: _c, childrenMore: _m, stepCount: _n, current: _u, ...rest } = step;
  return rest;
}

interface Meta {
  toolUseId?: string;
  description?: string;
  finished?: boolean;
}

interface FileState {
  path: string;
  offset: number;
  partial: Buffer;
}

interface Run {
  step: TurnStep;
  workflow: boolean;
  prompt: string | null;
  sub: TimelineReader;
  /** The call's tool_result arrived, and whether it was only "launched" (the work goes on in the background). */
  resultAt: number | null;
  launchedOnly: boolean;
  /** A `<task-notification>` for the call arrived: the background work is over. */
  endedAt: number | null;
  file: FileState | null;
  metaFinished: boolean;
  firstAt: number | null;
}

/** A workflow's agent, found as a subagent file nobody's Agent call owns. */
interface Orphan {
  id: string;
  description: string;
  file: FileState;
  finished: boolean;
  firstAt: number | null;
  lastAt: number | null;
  count: number;
  size: number;
}

export class AgentRuns {
  private readonly runs = new Map<string, Run>();
  /** Main-transcript entry uuid → the agent calls it made (older transcripts with sidechain entries). */
  private readonly calls = new Map<string, string[]>();
  private readonly sideOwner = new Map<string, string>();
  private readonly dir: string | null;
  private readonly orphans = new Map<string, Orphan>();
  /** Subagents whose meta says finished: not read again. */
  private readonly settled = new Set<string>();

  constructor(
    private readonly cwd: string | null,
    transcriptPath: string | null,
  ) {
    this.dir = transcriptPath
      ? join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents")
      : null;
  }

  get empty(): boolean {
    return this.runs.size === 0;
  }

  /** An Agent/Task/Workflow call began: its step shows as running until its result (or notification) says otherwise. */
  start(
    step: TurnStep,
    name: string,
    input: Record<string, unknown> | undefined,
    entryUuid: string | undefined,
  ): void {
    const id = step.id;
    if (!id || this.runs.has(id)) return;
    const prompt = typeof input?.prompt === "string" ? input.prompt : null;
    this.runs.set(id, {
      step,
      workflow: name === "Workflow",
      prompt,
      sub: new TimelineReader(this.cwd, null, { sidechain: true }),
      resultAt: null,
      launchedOnly: name === "Workflow",
      endedAt: null,
      file: null,
      metaFinished: false,
      firstAt: null,
    });
    step.running = true;
    if (entryUuid && !this.workflowStep(id))
      this.calls.set(entryUuid, [...(this.calls.get(entryUuid) ?? []), id]);
    this.relabel(this.runs.get(id) as Run);
  }

  private workflowStep(id: string): boolean {
    return this.runs.get(id)?.workflow === true;
  }

  /** The call's tool_result. Returns whether the step changed. */
  result(id: string, text: string, at: number): boolean {
    const run = this.runs.get(id);
    if (!run || run.resultAt !== null) return false;
    run.resultAt = Number.isNaN(at) ? Date.now() : at;
    if (!run.workflow) run.launchedOnly = /Async agent launched/i.test(text);
    return this.apply(run);
  }

  /** A `<task-notification>` in the main transcript: the background agent or workflow with that call id ended. */
  notification(text: string, at: number): TurnStep[] {
    const changed: TurnStep[] = [];
    for (const m of text.matchAll(/<tool-use-id>([^<\s]+)<\/tool-use-id>/g)) {
      const run = this.runs.get(m[1] as string);
      if (!run || run.endedAt !== null) continue;
      run.endedAt = Number.isNaN(at) ? Date.now() : at;
      if (this.apply(run)) changed.push(run.step);
    }
    return changed;
  }

  /** An entry of a subagent found in the main transcript (older Claude Code). Returns the owner's step when it changed. */
  sidechain(entry: TimelineEntry & { parentUuid?: string | null; agentId?: string }): TurnStep[] {
    const owner = this.ownerOf(entry);
    if (!owner) return [];
    if (entry.uuid) this.sideOwner.set(entry.uuid, owner);
    const run = this.runs.get(owner);
    if (!run) return [];
    run.sub.add(entry);
    return this.apply(run) ? [run.step] : [];
  }

  private ownerOf(entry: TimelineEntry & { parentUuid?: string | null; agentId?: string }): string | null {
    if (entry.parentUuid) {
      const known = this.sideOwner.get(entry.parentUuid);
      if (known) return known;
      const calls = this.calls.get(entry.parentUuid);
      if (calls?.length === 1) return calls[0] as string;
    }
    if (entry.agentId) {
      const known = this.sideOwner.get(`agent:${entry.agentId}`);
      if (known) return known;
    }
    // The agent's first entry is its prompt: the call whose prompt it is.
    const prompt = entry.type === "user" ? textOf(entry.message?.content) : "";
    let found: string | null = null;
    if (prompt) {
      for (const [id, run] of this.runs)
        if (!run.workflow && run.prompt === prompt && run.sub.actions.length === 0) found = id;
    }
    if (!found) {
      const open = [...this.runs].filter(([, r]) => !r.workflow && r.resultAt === null);
      if (open.length === 1) found = (open[0] as [string, Run])[0];
    }
    if (found && entry.agentId) this.sideOwner.set(`agent:${entry.agentId}`, found);
    return found;
  }

  /** Reads what the subagent files have now; returns the steps that changed. */
  refresh(): TurnStep[] {
    const changed: TurnStep[] = [];
    if (this.runs.size === 0) return changed;
    this.scan();
    for (const run of this.runs.values()) {
      if (run.file) this.readFile(run.file, run.sub);
      if (this.apply(run)) changed.push(run.step);
    }
    return changed;
  }

  /** The turn is over: nothing still "runs" in what it keeps (a background agent that goes on is not this turn's). */
  finalize(): void {
    this.refresh();
    for (const run of this.runs.values()) {
      if (run.step.running) {
        run.endedAt ??= run.sub.lastEntryAt ?? run.resultAt ?? Date.now();
        this.apply(run, true);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------

  /** Finds new subagent files: the call's own, and a workflow's agents. */
  private scan(): void {
    if (!this.dir) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^agent-(.+)\.meta\.json$/.exec(name);
      if (!m) continue;
      const id = m[1] as string;
      if (this.settled.has(id)) continue;
      let meta: Meta;
      try {
        meta = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Meta;
      } catch {
        continue;
      }
      const path = join(this.dir, `agent-${id}.jsonl`);
      const run = meta.toolUseId ? this.runs.get(meta.toolUseId) : undefined;
      if (run) {
        run.file ??= { path, offset: 0, partial: Buffer.alloc(0) };
        run.metaFinished = meta.finished === true;
        if (run.metaFinished) this.settled.add(id);
        continue;
      }
      let orphan = this.orphans.get(id);
      if (!orphan) {
        orphan = {
          id,
          description: typeof meta.description === "string" ? meta.description : "",
          file: { path, offset: 0, partial: Buffer.alloc(0) },
          finished: false,
          firstAt: null,
          lastAt: null,
          count: 0,
          size: -1,
        };
        this.orphans.set(id, orphan);
      }
      orphan.finished = meta.finished === true;
      this.peek(orphan);
      if (orphan.finished) this.settled.add(id);
    }
  }

  /** An orphan's first and last time and step count, from its file. */
  private peek(orphan: Orphan): void {
    const f = orphan.file;
    let size = -1;
    try {
      size = statSync(f.path).size;
    } catch {}
    if (size === orphan.size) return;
    orphan.size = size;
    const reader = new TimelineReader(this.cwd, null, { sidechain: true });
    f.offset = 0;
    f.partial = Buffer.alloc(0);
    this.readFile(f, reader, (e) => {
      const ts = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
      if (!Number.isNaN(ts)) {
        orphan.firstAt ??= ts;
        orphan.lastAt = ts;
      }
    });
    orphan.count = reader.actions.length;
  }

  private readFile(f: FileState, into: TimelineReader, each?: (e: TimelineEntry) => void): void {
    let size: number;
    try {
      size = statSync(f.path).size;
    } catch {
      return;
    }
    if (size < f.offset) {
      f.offset = 0;
      f.partial = Buffer.alloc(0);
    }
    if (size === f.offset) return;
    let chunk: Buffer;
    try {
      const fd = openSync(f.path, "r");
      try {
        chunk = Buffer.alloc(size - f.offset);
        const n = readSync(fd, chunk, 0, chunk.length, f.offset);
        chunk = chunk.subarray(0, n);
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    f.offset += chunk.length;
    const data = Buffer.concat([f.partial, chunk]);
    const end = data.lastIndexOf(0x0a);
    f.partial = Buffer.from(data.subarray(end + 1));
    if (end < 0) return;
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TimelineEntry;
        into.add(entry);
        each?.(entry);
      } catch {}
    }
  }

  private isRunning(run: Run): boolean {
    if (run.endedAt !== null || run.metaFinished) return false;
    if (run.workflow) {
      // Its agents may start after the launch's own result; with agents still going, it runs.
      return true;
    }
    return run.resultAt === null || run.launchedOnly;
  }

  /** The step's wording keeps its object ("Running an agent: Review PR #30"): only the verb follows the state. */
  private relabel(run: Run): void {
    const step = run.step;
    step.label = step.running
      ? step.label.replace(/^Ran\b/, "Running")
      : step.label.replace(/^Running\b/, "Ran");
  }

  /** Brings the step's fields up to date; returns whether any changed. `force`: the turn ended, so it no longer runs. */
  private apply(run: Run, force = false): boolean {
    const step = run.step;
    const before = JSON.stringify(step);
    const running = force ? false : this.isRunning(run);
    const endedAt = run.endedAt ?? (run.launchedOnly ? null : run.resultAt);
    if (running) step.running = true;
    else delete step.running;
    this.relabel(run);
    if (run.workflow) this.applyWorkflow(run, running);
    else this.applyAgent(run, running);
    if (!running) {
      const end = endedAt ?? (run.workflow ? this.workflowEnd(run) : run.sub.lastEntryAt) ?? null;
      if (end !== null && end >= step.at) step.durationMs = end - step.at;
    } else {
      delete step.durationMs;
    }
    return JSON.stringify(step) !== before;
  }

  private applyAgent(run: Run, running: boolean): void {
    const step = run.step;
    const actions = run.sub.actions;
    if (actions.length === 0) {
      delete step.stepCount;
      delete step.children;
      delete step.childrenMore;
      delete step.current;
      return;
    }
    step.stepCount = actions.length;
    const kept = actions.slice(0, TURN_STEP_CHILDREN_MAX).map(childOf);
    step.children = kept;
    if (actions.length > TURN_STEP_CHILDREN_MAX) step.childrenMore = actions.length - TURN_STEP_CHILDREN_MAX;
    else delete step.childrenMore;
    const last = actions.at(-1);
    const live = last?.id ? run.sub.liveLabel(last.id) : null;
    if (running && live) step.current = live;
    else delete step.current;
  }

  private workflowAgents(run: Run): Orphan[] {
    const mine = [...this.runs.values()].filter((r) => r.workflow).sort((a, b) => a.step.at - b.step.at);
    return [...this.orphans.values()]
      .filter((o) => {
        if (o.firstAt === null || o.firstAt < run.step.at - 1000) return false;
        // The latest workflow started before the agent owns it.
        const owner = [...mine].reverse().find((r) => r.step.at - 1000 <= (o.firstAt as number));
        return owner === run;
      })
      .sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0));
  }

  private workflowEnd(run: Run): number | null {
    const times = this.workflowAgents(run).map((o) => o.lastAt ?? 0);
    return times.length ? Math.max(...times) : run.resultAt;
  }

  private applyWorkflow(run: Run, running: boolean): void {
    const step = run.step;
    const agents = this.workflowAgents(run);
    if (agents.length === 0) {
      delete step.children;
      delete step.childrenMore;
      delete step.stepCount;
      delete step.current;
      return;
    }
    const lines: TurnStep[] = agents.slice(0, TURN_STEP_CHILDREN_MAX).map((o) => ({
      kind: "agent",
      label: fitLabel(oneLine(redact(o.description || "An agent"))),
      at: o.firstAt ?? step.at,
      id: `agent-${o.id}`,
      state: o.finished || !running ? "done" : "running",
    }));
    step.children = lines;
    if (agents.length > TURN_STEP_CHILDREN_MAX) step.childrenMore = agents.length - TURN_STEP_CHILDREN_MAX;
    else delete step.childrenMore;
    delete step.stepCount;
    delete step.current;
  }
}

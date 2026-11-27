import { randomUUID } from "node:crypto";
import type {
  Answer,
  Prompt,
  PromptDialog,
  PromptKind,
  PromptPayload,
  Question,
  ResolvedBy,
} from "../../../protocol/index.ts";
import type { DB } from "./db.ts";
import { audit } from "./db.ts";
import {
  AnswerMismatchError,
  hookOutputFor,
  type PermissionRequestInput,
  payloadFor,
  promptKindFor,
  resolveChoices,
  restoreCutChoices,
  restoreCutQuestion,
  stopHookOutput,
  validateQuestionAnswer,
} from "./decisions.ts";
import type { EventLog } from "./events.ts";
import { redact, redactDeep } from "./redact.ts";

/** What the waiting PermissionRequest hook prints. Empty stdout means "no decision": Claude Code keeps its own dialog. */
export interface HookReply {
  stdout: string;
}

interface Waiter {
  resolve: (reply: HookReply) => void;
}

interface PromptRow {
  id: string;
  session_id: string;
  kind: PromptKind;
  tool_name: string;
  tool_input: string;
  suggestions: string | null;
  payload_json: string;
  status: "open" | "closed";
  resolved_by: ResolvedBy | null;
  answer_json: string | null;
  created_at: number;
  resolved_at: number | null;
  dialog_json: string | null;
}

export type AnswerResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "conflict" | "bad_request"; message: string };

function toPrompt(r: PromptRow): Prompt {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json) as PromptPayload,
    status: r.status,
    resolvedBy: r.resolved_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    outcome: outcomeOf(r.resolved_by, r.answer_json ? (JSON.parse(r.answer_json) as StoredAnswer) : null),
    ...(r.dialog_json ? { dialog: JSON.parse(r.dialog_json) as PromptDialog } : {}),
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** At most `n` characters as people see them, so an emoji at the cut is never split in half. */
const clip = (s: string, n = 80) => {
  const chars = Array.from(graphemes.segment(s), (g) => g.segment);
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : s;
};

/** How long after a question closed at the Mac its late PostToolUse may still add the picks. */
const LATE_PICKS_MS = 2 * 60_000;

/** What `answer_json` holds: the phone's answer, or the phone's Stop (never sent on the wire as an Answer). */
type StoredAnswer = Answer | { kind: "stop" };

/** A few words for the Inbox history and chat; at the Mac only a question's picks are known. */
export function outcomeOf(by: ResolvedBy | null, answer: StoredAnswer | null): string | null {
  if (!by) return null;
  if (answer?.kind === "stop") return "Stopped";
  if (by === "mac" && answer?.kind !== "question") return "Answered on the Mac";
  if (by === "timeout") return "Expired";
  if (by === "superseded") return "Closed";
  if (!answer) return "Answered on the phone";
  switch (answer.kind) {
    case "question":
      // Typed answers can hold a key or a token, from the Mac or the phone: redacted like everything sent.
      return clip(redact(Object.values(answer.answers).join(" · ")));
    case "plan":
      return {
        approve: "Approved",
        approve_accept_edits: "Approved, edits auto-accepted",
        revise: clip(redact(`Revise: ${answer.feedback ?? ""}`.trim())),
        reject: "Rejected",
      }[answer.action];
    case "permission":
      return { allow: "Allowed", allow_always: "Always allowed", deny: "Denied" }[answer.action];
  }
}

/** Every prompt column, and the terminal dialog it stands for (a table of its own). */
const PROMPT_ROWS =
  "SELECT prompts.*, (SELECT dialog_json FROM prompt_dialogs WHERE prompt_id = prompts.id) AS dialog_json FROM prompts";

const DIALOG_GONE = "That question is no longer open on your computer.";

/** Owns open prompts; each closes once: phone answer, Mac answer (seen via hooks), "superseded" or "timeout". */
export class Broker {
  private readonly waiters = new Map<string, Waiter>();
  private readonly answering = new Set<string>();

  constructor(
    private readonly db: DB,
    private readonly events: EventLog,
    private readonly onChange: (sessionId: string) => void = () => {},
  ) {}

  /** Opens a prompt and returns a promise for what the waiting hook should print. */
  open(input: PermissionRequestInput): { prompt: Prompt; reply: Promise<HookReply> } {
    // Plan feedback at the Mac ("Tell Claude what to change") leaves the old plan's hook running and
    // asks again with the revised plan. A session shows one plan at a time, so the older one is settled.
    if (input.tool_name === "ExitPlanMode")
      for (const p of this.listOpenRows(input.session_id))
        if (p.tool_name === "ExitPlanMode") this.close(p.id, "mac");
    const kind = promptKindFor(input.tool_name);
    const payload = payloadFor(input);
    const id = `p_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO prompts (id, session_id, kind, tool_name, tool_input, suggestions, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        id,
        input.session_id,
        kind,
        input.tool_name,
        JSON.stringify(input.tool_input ?? {}),
        input.permission_suggestions ? JSON.stringify(input.permission_suggestions) : null,
        JSON.stringify(payload),
        now,
      );
    const reply = new Promise<HookReply>((resolve) => this.waiters.set(id, { resolve }));
    const prompt = this.get(id) as Prompt;
    this.events.emit({ type: "prompt.opened", prompt });
    this.onChange(input.session_id);
    return { prompt, reply };
  }

  /** A terminal dialog as a question for the phone. No hook waits for it: the screen is its only way to settle. */
  openDialog(sessionId: string, dialogId: string, dialog: PromptDialog, question: Question): Prompt {
    const id = `p_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db
      .query(
        `INSERT INTO prompts (id, session_id, kind, tool_name, tool_input, payload_json, status, created_at)
         VALUES (?, ?, 'question', 'Dialog', ?, ?, 'open', ?)`,
      )
      .run(
        id,
        sessionId,
        JSON.stringify({ dialogId }),
        JSON.stringify({ kind: "question", questions: [redactDeep(question)] }),
        Date.now(),
      );
    this.db
      .query("INSERT INTO prompt_dialogs (prompt_id, dialog_json) VALUES (?, ?)")
      .run(id, JSON.stringify(dialog));
    const prompt = this.get(id) as Prompt;
    this.events.emit({ type: "prompt.opened", prompt });
    this.onChange(sessionId);
    return prompt;
  }

  /** The open dialog question of the session, with the id of the dialog it stands for. */
  openDialogOf(sessionId: string): { prompt: Prompt; dialogId: string } | null {
    const row = this.listOpenRows(sessionId).find((r) => r.dialog_json !== null);
    if (!row) return null;
    const dialogId = (JSON.parse(row.tool_input) as { dialogId?: string }).dialogId ?? "";
    return { prompt: toPrompt(row), dialogId };
  }

  /**
   * The phone's pick on a dialog question, by label. `press` moves the terminal's cursor there and presses Enter
   * after re-reading the screen; false means the screen changed and nothing was answered.
   */
  async answerDialog(
    promptId: string,
    answer: Answer,
    actor: string,
    press: (label: string, dialogId: string, sessionId: string) => Promise<boolean>,
  ): Promise<AnswerResult> {
    const row = this.db.query(`${PROMPT_ROWS} WHERE id = ?`).get(promptId) as PromptRow | null;
    if (!row) return { ok: false, code: "not_found", message: "unknown prompt" };
    if (row.status !== "open" || !row.dialog_json) return this.answer(promptId, answer, actor);
    const payload = JSON.parse(row.payload_json) as PromptPayload;
    if (answer.kind !== "question" || payload.kind !== "question")
      return { ok: false, code: "bad_request", message: "this prompt takes a question answer" };
    const given = restoreCutQuestion(payload.questions, answer.answers);
    const answers = resolveChoices(
      payload.questions,
      given,
      restoreCutChoices(payload.questions, answer.choices),
    );
    const problem = validateQuestionAnswer(payload.questions, answers);
    if (problem) return { ok: false, code: "bad_request", message: problem };
    const question = payload.questions[0];
    const label = question ? answers[question.question] : undefined;
    if (!question || label === undefined || !question.options.some((o) => o.label === label))
      return { ok: false, code: "bad_request", message: "that is not one of the options" };
    if (this.answering.has(promptId)) return { ok: false, code: "conflict", message: DIALOG_GONE };
    this.answering.add(promptId);
    try {
      const dialogId = (JSON.parse(row.tool_input) as { dialogId?: string }).dialogId ?? "";
      if (!(await press(label, dialogId, row.session_id)))
        return { ok: false, code: "conflict", message: DIALOG_GONE };
    } finally {
      this.answering.delete(promptId);
    }
    this.close(promptId, "phone", { kind: "question", answers: { [question.question]: label } });
    audit(this.db, actor, "prompt.answer", { promptId, kind: row.kind, action: "answered a dialog" });
    return { ok: true };
  }

  get(id: string): Prompt | null {
    const row = this.db.query(`${PROMPT_ROWS} WHERE id = ?`).get(id) as PromptRow | null;
    return row ? toPrompt(row) : null;
  }

  listOpen(sessionId?: string): Prompt[] {
    const rows = (
      sessionId
        ? this.db
            .query(`${PROMPT_ROWS} WHERE status = 'open' AND session_id = ? ORDER BY created_at`)
            .all(sessionId)
        : this.db.query(`${PROMPT_ROWS} WHERE status = 'open' ORDER BY created_at`).all()
    ) as PromptRow[];
    return rows.map(toPrompt);
  }

  /** Settled prompts, newest first (the Inbox history). */
  listRecent(limit: number): Prompt[] {
    const rows = this.db
      .query(`${PROMPT_ROWS} WHERE status = 'closed' ORDER BY resolved_at DESC LIMIT ?`)
      .all(limit) as PromptRow[];
    return rows.map(toPrompt);
  }

  hasOpen(sessionId: string): boolean {
    return Boolean(
      this.db.query("SELECT 1 FROM prompts WHERE status = 'open' AND session_id = ? LIMIT 1").get(sessionId),
    );
  }

  /** Answer from a paired device. First wins, later ones get `conflict`, except a phone re-sending the same answer. */
  answer(promptId: string, answer: Answer, actor: string): AnswerResult {
    const row = this.db.query(`${PROMPT_ROWS} WHERE id = ?`).get(promptId) as PromptRow | null;
    if (!row) return { ok: false, code: "not_found", message: "unknown prompt" };
    if (row.status !== "open") {
      if (row.resolved_by === "phone" && row.answer_json) {
        // A notification answer comes under the cut question; compare both sides under the full one.
        const payload = JSON.parse(row.payload_json) as PromptPayload;
        const whole = (a: Answer): Answer =>
          a.kind === "question" && payload.kind === "question" ? wholeAnswer(payload.questions, a) : a;
        const stored = JSON.parse(row.answer_json) as Answer;
        if (sameAnswer(row.answer_json, answer) || sameAnswer(JSON.stringify(whole(stored)), whole(answer)))
          return { ok: true };
      }
      return { ok: false, code: "conflict", message: `already closed (${row.resolved_by ?? "unknown"})` };
    }

    // What the hook gets: a picked option's index (`choices`) stands for its full label.
    let forHook: Answer = answer;
    // What is kept and shown in the history: the same, but with the choices kept so a repeat still matches.
    let stored: Answer = answer;
    let hookChoices: Record<string, number> | undefined;
    if (answer.kind === "question") {
      const payload = JSON.parse(row.payload_json) as PromptPayload;
      // A long question's notification answers under the cut text the push carried.
      const given =
        payload.kind === "question" ? restoreCutQuestion(payload.questions, answer.answers) : answer.answers;
      const answers =
        payload.kind === "question"
          ? resolveChoices(payload.questions, given, restoreCutChoices(payload.questions, answer.choices))
          : given;
      forHook = { kind: "question", answers };
      if (payload.kind === "question") stored = wholeAnswer(payload.questions, answer);
      if (payload.kind === "question") hookChoices = restoreCutChoices(payload.questions, answer.choices);
      const problem = payload.kind === "question" ? validateQuestionAnswer(payload.questions, answers) : null;
      if (problem) return { ok: false, code: "bad_request", message: problem };
    }
    let stdout: string;
    try {
      stdout = hookOutputFor(
        row.kind,
        JSON.parse(row.tool_input) as Record<string, unknown>,
        row.suggestions ? (JSON.parse(row.suggestions) as unknown[]) : null,
        forHook,
        hookChoices,
      );
    } catch (err) {
      if (err instanceof AnswerMismatchError) return { ok: false, code: "bad_request", message: err.message };
      throw err;
    }
    const waiter = this.waiters.get(promptId);
    if (!waiter) {
      // The daemon restarted while the hook was waiting; the hook has fallen back to the terminal.
      this.close(promptId, "superseded");
      return { ok: false, code: "conflict", message: "the session is no longer waiting for this answer" };
    }
    this.close(promptId, "phone", stored);
    waiter.resolve({ stdout });
    audit(this.db, actor, "prompt.answer", { promptId, kind: row.kind, action: describe(answer) });
    return { ok: true };
  }

  /** The phone's Stop on a waiting prompt: deny-and-interrupt, closed as "Stopped". Returns its ID, or null if no hook waited. */
  stop(sessionId: string, actor: string): string | null {
    const rows = this.listOpenRows(sessionId).sort((a, b) => a.created_at - b.created_at);
    const answered = rows.find((r) => this.waiters.has(r.id));
    if (!answered) return null;
    const waiter = this.waiters.get(answered.id);
    this.close(answered.id, "phone", { kind: "stop" });
    waiter?.resolve({ stdout: stopHookOutput() });
    for (const r of rows) if (r.id !== answered.id) this.close(r.id, "superseded");
    audit(this.db, actor, "prompt.stop", { promptId: answered.id, kind: answered.kind });
    return answered.id;
  }

  /** For hook events proving a prompt was settled elsewhere: closes it and releases its hook silently. */
  settleFromSessionEvent(
    sessionId: string,
    event: {
      hookEventName: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolResponse?: unknown;
    },
  ): void {
    const open = this.listOpenRows(sessionId);
    if (!open.some((p) => p.tool_name === event.toolName)) this.addMacPicks(sessionId, event);
    for (const p of open) {
      const sameTool = event.toolName !== undefined && event.toolName === p.tool_name;
      const inputMatches =
        sameTool &&
        (p.kind !== "permission" || // questions/plans: input is rewritten by the answer
          stableJson(event.toolInput ?? {}) === stableJson(JSON.parse(p.tool_input)));
      const endsTurn = ["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"].includes(
        event.hookEventName,
      );
      if (endsTurn) this.close(p.id, event.hookEventName === "UserPromptSubmit" ? "mac" : "superseded");
      else if (inputMatches) this.close(p.id, "mac", p.kind === "question" ? macAnswers(event) : undefined);
    }
  }

  /**
   * A question's waiting hook can end before the PostToolUse that carries its picks arrives: the prompt was
   * already closed as answered at the Mac without them. The picks complete it, sent as a second `prompt.closed`.
   */
  private addMacPicks(
    sessionId: string,
    event: {
      hookEventName: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolResponse?: unknown;
    },
  ): void {
    if (event.hookEventName !== "PostToolUse" || event.toolName === undefined) return;
    const answer = macAnswers(event);
    if (!answer) return;
    const row = this.db
      .query(
        `SELECT id FROM prompts WHERE session_id = ? AND tool_name = ? AND kind = 'question' AND status = 'closed'
         AND resolved_by = 'mac' AND answer_json IS NULL AND resolved_at > ? ORDER BY resolved_at DESC LIMIT 1`,
      )
      .get(sessionId, event.toolName, Date.now() - LATE_PICKS_MS) as { id: string } | null;
    if (!row) return;
    this.db.query("UPDATE prompts SET answer_json = ? WHERE id = ?").run(JSON.stringify(answer), row.id);
    this.events.emit({
      type: "prompt.closed",
      promptId: row.id,
      resolvedBy: "mac",
      outcome: outcomeOf("mac", answer),
    });
    this.onChange(sessionId);
  }

  /** Closes prompts older than the timeout. */
  expire(timeoutMs: number): void {
    const cutoff = Date.now() - timeoutMs;
    const rows = this.db
      .query("SELECT id FROM prompts WHERE status = 'open' AND created_at < ?")
      .all(cutoff) as { id: string }[];
    for (const r of rows) this.close(r.id, "timeout");
  }

  /** After a daemon restart nobody is waiting on old prompts any more. */
  closeOrphans(): void {
    const rows = this.db.query("SELECT id FROM prompts WHERE status = 'open'").all() as { id: string }[];
    for (const r of rows) if (!this.waiters.has(r.id)) this.close(r.id, "superseded");
  }

  close(promptId: string, by: ResolvedBy, answer?: StoredAnswer): void {
    const res = this.db
      .query(
        "UPDATE prompts SET status = 'closed', resolved_by = ?, answer_json = ?, resolved_at = ? WHERE id = ? AND status = 'open' RETURNING session_id, payload_json",
      )
      .get(by, answer ? JSON.stringify(answer) : null, Date.now(), promptId) as {
      session_id: string;
      payload_json: string;
    } | null;
    if (!res) return;
    // The raw tool input was only needed to answer the waiting hook. Once settled, keep a redacted
    // copy for the history and drop the rest, so secrets in commands don't sit in relay.db.
    this.db
      .query("UPDATE prompts SET tool_input = '{}', payload_json = ? WHERE id = ?")
      .run(JSON.stringify(redactDeep(JSON.parse(res.payload_json))), promptId);
    if (by !== "phone") this.waiters.get(promptId)?.resolve({ stdout: "" });
    this.waiters.delete(promptId);
    this.events.emit({
      type: "prompt.closed",
      promptId,
      resolvedBy: by,
      outcome: outcomeOf(by, answer ?? null),
    });
    this.onChange(res.session_id);
  }

  private listOpenRows(sessionId: string): PromptRow[] {
    return this.db
      .query(`${PROMPT_ROWS} WHERE status = 'open' AND session_id = ?`)
      .all(sessionId) as PromptRow[];
  }
}

/** What was picked for an AskUserQuestion answered in the terminal, from `answers` in its PostToolUse; else undefined. */
export function macAnswers(event: {
  toolInput?: Record<string, unknown>;
  toolResponse?: unknown;
}): Answer | undefined {
  for (const source of [event.toolResponse, event.toolInput]) {
    const answers = (source as { answers?: unknown } | null | undefined)?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) continue;
    const picked = Object.fromEntries(
      Object.entries(answers).filter(
        (e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== "",
      ),
    );
    // Kept in relay.db and sent as the outcome: no secret typed at the Mac is stored or leaves it.
    if (Object.keys(picked).length > 0)
      return {
        kind: "question",
        answers: Object.fromEntries(Object.entries(picked).map(([q, a]) => [q, redact(a)])),
      };
  }
  return undefined;
}

function describe(answer: Answer): string {
  if (answer.kind === "question") return `answered ${Object.keys(answer.answers).length} question(s)`;
  return answer.action;
}

/** JSON with sorted keys, for comparing tool inputs regardless of key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** The stored answer and a new one say the same, whatever the order of their keys. */
/** A notification answer under the full question, its button index standing for the option's full label. */
function wholeAnswer(questions: Question[], a: Extract<Answer, { kind: "question" }>): Answer {
  const choices = restoreCutChoices(questions, a.choices);
  const answers = resolveChoices(questions, restoreCutQuestion(questions, a.answers), choices);
  return choices ? { kind: "question", answers, choices } : { kind: "question", answers };
}

function sameAnswer(storedJson: string, answer: Answer): boolean {
  try {
    return stableJson(JSON.parse(storedJson)) === stableJson(answer);
  } catch {
    return false;
  }
}

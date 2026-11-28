import type { Answer, PromptKind, PromptPayload, Question } from "../../../protocol/index.ts";
import { redact, redactDeep } from "./redact.ts";
import { cleanName, head, visibleEscapes } from "./text.ts";

/** Translates between Claude Code's PermissionRequest hook contract and Relay prompts (pure). */

export interface PermissionRequestInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: unknown[];
}

export function promptKindFor(toolName: string): PromptKind {
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "ExitPlanMode") return "plan";
  return "permission";
}

export function payloadFor(
  input: PermissionRequestInput,
  approvalModes: ("bypassPermissions" | "auto")[] = [],
): PromptPayload {
  const kind = promptKindFor(input.tool_name);
  const ti = input.tool_input ?? {};
  if (kind === "question") {
    const questions = (Array.isArray(ti.questions) ? ti.questions : []) as Question[];
    return { kind, questions: redactDeep(questions) };
  }
  if (kind === "plan") {
    return {
      kind,
      plan: redact(typeof ti.plan === "string" ? ti.plan : ""),
      planFilePath: typeof ti.planFilePath === "string" ? ti.planFilePath : null,
      ...(approvalModes.length ? { approvalModes } : {}),
    };
  }
  // Shown unredacted: redaction could hide the dangerous part (`TOKEN=$(curl …|sh) npm test`). It goes
  // end-to-end encrypted; push notifications redact separately.
  const full = JSON.stringify(ti, null, 2);
  const rules =
    Array.isArray(input.permission_suggestions) && input.permission_suggestions.length
      ? `\n\n"Always Allow" adds:\n${JSON.stringify(input.permission_suggestions, null, 2)}`
      : "";
  return {
    kind: "permission",
    toolName: input.tool_name,
    summary: visibleEscapes(permissionSummary(input.tool_name, ti)),
    description: toolDescription(ti),
    detail: visibleEscapes(
      (full.length > 20_000 ? `${head(full, 20_000)}\n… (${full.length - 20_000} more characters)` : full) +
        rules,
    ),
    canAlwaysAllow: Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0,
  };
}

const DESCRIPTION_MAX = 140;

/** The call's own one-line description, when Claude wrote one; undefined when missing or empty. */
function toolDescription(ti: Record<string, unknown>): string | undefined {
  if (typeof ti.description !== "string") return undefined;
  const line = redact(cleanName(ti.description)).split(/\s+/).filter(Boolean).join(" ");
  return line ? head(line, DESCRIPTION_MAX) : undefined;
}

function permissionSummary(tool: string, ti: Record<string, unknown>): string {
  const str = (k: string) => (typeof ti[k] === "string" ? (ti[k] as string) : "");
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return shortenLeadingCd(str("command")) || str("description");
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "Read":
      return str("file_path");
    case "NotebookEdit":
      return str("notebook_path");
    case "WebFetch":
      return str("url");
    case "WebSearch":
      return str("query");
    default: {
      const first = Object.values(ti).find((v) => typeof v === "string") as string | undefined;
      return first ? `${tool}: ${first}` : tool;
    }
  }
}

/** A `cd` to a plain path at least this long, at the start of a command, is shortened on the card. */
const CD_SHORTEN_FROM = 40;

/**
 * Shortens a leading `cd /plain/path` to its last folder ("cd …/scratchpad; ..."); anything with `$`, quotes
 * or spaces stays whole. The details keep the exact command; `needsReview` bars it from the lock screen.
 */
export function shortenLeadingCd(command: string): string {
  const m = /^(\s*cd\s+)([A-Za-z0-9_./~+@%:-]+)(\s*(?:&&|;|\n))/.exec(command);
  const path = m?.[2]?.replace(/\/+$/, "") ?? "";
  if (!m || path.length < CD_SHORTEN_FROM) return command;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!last || last === path) return command;
  return `${m[1]}…/${last}${m[3]}${command.slice(m[0].length)}`;
}

/** True for a summary whose leading `cd` was shortened: the notification doesn't show the whole request. */
export function hasShortenedCd(summary: string): boolean {
  return /^\s*cd\s+…\//.test(summary);
}

export class AnswerMismatchError extends Error {}

export interface ElicitationInput {
  session_id: string;
  mcp_server_name?: string;
  message?: string;
  mode?: string;
  requested_schema?: unknown;
  url?: string;
}

/** What the phone's answer maps back to, kept in the prompt's `tool_input`. */
export interface ElicitationAsk {
  key: string;
  property: string;
  /** `value` is what the server gets; the decline option has none. */
  values: { label: string; value?: string | boolean }[];
}

const ELICITATION_OPTIONS_MAX = 8;
const DECLINE = "Decline";

/**
 * A form with one enum or boolean field, as a question for the phone; null for anything else (more fields,
 * other types, URL mode), which the terminal's own dialog handles.
 */
export function elicitationQuestion(
  input: ElicitationInput,
): { question: Question; ask: ElicitationAsk } | null {
  if (input.mode !== undefined && input.mode !== "form") return null;
  const schema = input.requested_schema as { properties?: Record<string, unknown> } | undefined;
  const entries = Object.entries(schema?.properties ?? {});
  if (entries.length !== 1) return null;
  const [property, raw] = entries[0] as [string, Record<string, unknown> | null];
  if (!raw || typeof raw !== "object") return null;
  let values: { label: string; value: string | boolean }[] = [];
  if (raw.type === "boolean") {
    values = [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ];
  } else if (raw.type === "string" && Array.isArray(raw.enum)) {
    const names = Array.isArray(raw.enumNames) ? raw.enumNames : [];
    values = raw.enum.flatMap((v, i) =>
      typeof v === "string"
        ? [{ label: typeof names[i] === "string" ? (names[i] as string) : v, value: v }]
        : [],
    );
    if (values.length !== raw.enum.length) return null;
  } else if (raw.type === "string" && Array.isArray(raw.oneOf)) {
    for (const o of raw.oneOf as { const?: unknown; title?: unknown }[]) {
      if (typeof o?.const !== "string") return null;
      values.push({ label: typeof o.title === "string" ? o.title : o.const, value: o.const });
    }
  } else return null;
  values = values.map((v) => ({ ...v, label: redact(v.label) }));
  if (values.length === 0 || values.length > ELICITATION_OPTIONS_MAX) return null;
  const labels = new Set(values.map((v) => v.label));
  if (labels.size !== values.length || labels.has(DECLINE)) return null;
  const title = typeof raw.title === "string" ? raw.title : property;
  const asked = redact(input.message?.trim() || title);
  return {
    question: {
      question: asked,
      header: input.mcp_server_name ? head(redact(input.mcp_server_name), 40) : "MCP server",
      options: [...values.map((v) => ({ label: v.label })), { label: DECLINE }],
      multiSelect: false,
    } as Question,
    ask: { key: asked, property, values: [...values, { label: DECLINE }] },
  };
}

/** The Elicitation hook's stdout for the phone's pick: `accept` with the value, or `decline`. */
export function elicitationOutput(ask: ElicitationAsk, answers: Record<string, string>): string {
  const picked = answers[ask.key] ?? Object.values(answers)[0];
  const match = ask.values.find((v) => v.label === picked);
  if (!match) throw new AnswerMismatchError("not one of the options");
  const output =
    match.value === undefined
      ? { hookEventName: "Elicitation", action: "decline" }
      : { hookEventName: "Elicitation", action: "accept", content: { [ask.property]: match.value } };
  return JSON.stringify({ hookSpecificOutput: output });
}

/** The hook's stdout for the phone's Stop on an Elicitation: the server gets `decline`. */
export function elicitationDeclineOutput(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } });
}

/** Builds the exact stdout JSON for the waiting PermissionRequest hook. */
export function hookOutputFor(
  kind: PromptKind,
  toolInput: Record<string, unknown>,
  suggestions: unknown[] | null,
  answer: Answer,
  choices?: Record<string, number>,
): string {
  if (answer.kind !== kind) throw new AnswerMismatchError(`expected a ${kind} answer, got ${answer.kind}`);
  const ask = toolInput.elicitation as ElicitationAsk | undefined;
  if (ask && answer.kind === "question") return elicitationOutput(ask, answer.answers);
  let decision: Record<string, unknown>;
  switch (answer.kind) {
    case "question":
      decision = {
        behavior: "allow",
        updatedInput: {
          ...toolInput,
          answers: originalAnswers(toolInput.questions, answer.answers, choices),
        },
      };
      break;
    case "plan":
      // allow is ignored unless updatedInput echoes the tool input.
      if (answer.action === "approve") decision = { behavior: "allow", updatedInput: toolInput };
      else if (answer.action === "approve_accept_edits")
        decision = {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        };
      else if (answer.action === "approve_bypass_permissions" || answer.action === "approve_auto")
        decision = {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: [
            {
              type: "setMode",
              mode: answer.action === "approve_auto" ? "auto" : "bypassPermissions",
              destination: "session",
            },
          ],
        };
      else if (answer.action === "revise")
        decision = {
          behavior: "deny",
          message: `The user asked for changes to the plan (sent from their phone): ${answer.feedback?.trim() || "Please revise the plan."}`,
        };
      else
        decision = {
          behavior: "deny",
          message: `The user rejected this plan from their phone.${answer.feedback ? ` Reason: ${answer.feedback}` : ""}`,
          interrupt: true,
        };
      break;
    case "permission":
      if (answer.action === "deny")
        decision = {
          behavior: "deny",
          message: `The user denied this from their phone.${answer.reason ? ` Reason: ${answer.reason}` : ""}`,
        };
      else if (answer.action === "allow_always" && suggestions?.length)
        decision = { behavior: "allow", updatedPermissions: suggestions };
      else decision = { behavior: "allow" };
      break;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

/** Hook output for the phone's Stop (session.interrupt): deny and interrupt; the turn ends without a Stop hook. */
export function stopHookOutput(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "The user stopped this from their phone.", interrupt: true },
    },
  });
}

/** Maps answers keyed by the redacted text back to the original question and option labels (free text unchanged). */
export function originalAnswers(
  rawQuestions: unknown,
  answers: Record<string, string>,
  choices?: Record<string, number>,
): Record<string, string> {
  if (!Array.isArray(rawQuestions)) return answers;
  const out: Record<string, string> = { ...answers };
  for (const q of rawQuestions as Question[]) {
    if (typeof q?.question !== "string") continue;
    const shown = redact(q.question);
    const value = answers[shown] ?? answers[q.question];
    if (value === undefined) continue;
    const labels = (Array.isArray(q.options) ? q.options : [])
      .map((o) => o?.label)
      .filter((l): l is string => typeof l === "string");
    const byShown = new Map<string, string>();
    for (const l of labels) if (!byShown.has(redact(l))) byShown.set(redact(l), l);
    // Options equal after redaction share one text; a notification's index still names its own option.
    const index = choices?.[shown] ?? choices?.[q.question];
    const byIndex = index === undefined ? undefined : labels[index];
    let restored = byIndex !== undefined && redact(byIndex) === value ? byIndex : byShown.get(value);
    if (restored === undefined && q.multiSelect !== false && value.includes(", "))
      restored = value
        .split(", ")
        .map((part) => byShown.get(part) ?? part)
        .join(", ");
    if (shown !== q.question) delete out[shown];
    out[q.question] = restored ?? value;
  }
  return out;
}

/** Answers each question that has a `choices` index with that option's full label (a bad index keeps the text). */
export function resolveChoices(
  questions: Question[],
  answers: Record<string, string>,
  choices: Record<string, number> | undefined,
): Record<string, string> {
  if (!choices) return answers;
  const out = { ...answers };
  for (const q of questions) {
    const index = choices[q.question];
    const label = index === undefined ? undefined : q.options?.[index]?.label;
    if (typeof label === "string") out[q.question] = label;
  }
  return out;
}

/** Validates a question answer against the open prompt so typos from the client fail loudly. */
export function validateQuestionAnswer(
  questions: Question[],
  answers: Record<string, string>,
): string | null {
  for (const q of questions) {
    const value = answers[q.question];
    if (value === undefined || value.trim() === "") return `missing answer for "${q.question}"`;
  }
  return null;
}

/** A push cuts a long question (fitAlert) and its buttons answer under the cut: re-key it to the full question. */
export function restoreCutQuestion(
  questions: Question[],
  answers: Record<string, string>,
): Record<string, string> {
  const only = questions.length === 1 ? questions[0] : undefined;
  const keys = Object.keys(answers);
  if (!only || keys.length !== 1) return answers;
  const key = keys[0] as string;
  if (key === only.question || key === redact(only.question)) return answers;
  const stem = key.endsWith("…") ? key.slice(0, -1) : key;
  if (stem === "" || !(only.question.startsWith(stem) || redact(only.question).startsWith(stem)))
    return answers;
  return { [only.question]: answers[key] as string };
}

/** The `choices` of a cut question's notification, keyed by the whole question like its `answers`. */
export function restoreCutChoices(
  questions: Question[],
  choices: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!choices) return choices;
  const keys = Object.keys(choices);
  const only = questions.length === 1 ? questions[0] : undefined;
  if (!only || keys.length !== 1) return choices;
  const key = keys[0] as string;
  const mapped = Object.keys(restoreCutQuestion(questions, { [key]: "" }))[0];
  return mapped === undefined || mapped === key ? choices : { [mapped]: choices[key] as number };
}

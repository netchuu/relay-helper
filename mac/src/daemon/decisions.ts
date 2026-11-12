import type { Answer, PromptKind, PromptPayload, Question } from "../../../protocol/index.ts";
import { redact, redactDeep } from "./redact.ts";

/**
 * Pure translation between Claude Code's PermissionRequest hook contract and Relay prompts.
 *
 * Verified against Claude Code 2.1.316 (Phase 0 spikes):
 *  - AskUserQuestion and ExitPlanMode both reach PermissionRequest; the terminal dialog stays visible
 *    while the hook waits, so the Mac and the phone race and the first answer wins.
 *  - AskUserQuestion: allow + updatedInput {questions, answers}. Free text and "A, B" multi-select work.
 *  - ExitPlanMode: allow is ignored unless updatedInput echoes the tool input (plan, planFilePath).
 *    deny + message makes Claude revise the plan.
 */

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

export function payloadFor(input: PermissionRequestInput): PromptPayload {
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
    };
  }
  // What you approve is shown exactly, never redacted: a redaction can hide the dangerous part of a
  // command (e.g. `TOKEN=$(curl …|sh) npm test`). It travels end-to-end encrypted to your own phone;
  // push notifications redact it separately (notifier.ts).
  const full = JSON.stringify(ti, null, 2);
  const rules =
    Array.isArray(input.permission_suggestions) && input.permission_suggestions.length
      ? `\n\n"Always Allow" adds:\n${JSON.stringify(input.permission_suggestions, null, 2)}`
      : "";
  return {
    kind: "permission",
    toolName: input.tool_name,
    summary: permissionSummary(input.tool_name, ti),
    detail:
      (full.length > 20_000
        ? `${full.slice(0, 20_000)}\n… (${full.length - 20_000} more characters)`
        : full) + rules,
    canAlwaysAllow: Array.isArray(input.permission_suggestions) && input.permission_suggestions.length > 0,
  };
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
 * Shortens a long `cd /plain/path` at the start of a command to its last folder ("cd …/scratchpad; …"), so
 * commands that differ only after it don't look the same at the top of the card (the desktop
 * app's scratch folders run to 230 characters). Only a plain path is shortened: one with `$`, backticks, quotes,
 * spaces or anything else that could run or hide something is left whole. The details keep the exact command, and a
 * shortened summary is never allowed from the lock screen (`needsReview`).
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

/** Builds the exact stdout JSON for the waiting PermissionRequest hook. */
export function hookOutputFor(
  kind: PromptKind,
  toolInput: Record<string, unknown>,
  suggestions: unknown[] | null,
  answer: Answer,
): string {
  if (answer.kind !== kind) throw new AnswerMismatchError(`expected a ${kind} answer, got ${answer.kind}`);
  let decision: Record<string, unknown>;
  switch (answer.kind) {
    case "question":
      decision = { behavior: "allow", updatedInput: { ...toolInput, answers: answer.answers } };
      break;
    case "plan":
      if (answer.action === "approve") decision = { behavior: "allow", updatedInput: toolInput };
      else if (answer.action === "approve_accept_edits")
        decision = {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
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

/**
 * The waiting PermissionRequest hook's output for the phone's Stop (session.interrupt): deny and interrupt,
 * Claude Code's own "stop here". Verified with 2.1.318 on Bash and AskUserQuestion: the dialog closes, the tool
 * doesn't run, the turn ends without a Stop hook and the transcript gets "[Request interrupted by user for tool use]".
 */
export function stopHookOutput(): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "The user stopped this from their phone.", interrupt: true },
    },
  });
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

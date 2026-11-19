import { type Prompt, REPLY_DATA_BYTES, type Turn, type TurnStep } from "../../../protocol/index.ts";
import { withoutOutput } from "./timeline.ts";

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Never cut a text shorter than this, however many prompts share the reply. */
const MIN_CHARS = 200;

/** `s` cut to at most `max` UTF-16 units (never between a surrogate pair), with how much was left out. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${s.slice(0, end)}\n… (${s.length - end} more characters)`;
}

/**
 * The free texts that may be cut. A question and its option labels are never cut: an answer is given under
 * the exact text shown, so a cut one could not be answered.
 */
const CUTTABLE = new Set(["plan", "summary", "detail", "description"]);

function cutStrings(value: unknown, max: number, key = ""): unknown {
  if (typeof value === "string") return CUTTABLE.has(key) ? cut(value, max) : value;
  if (Array.isArray(value)) return value.map((v) => cutStrings(v, max, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutStrings(v, max, k)]));
  return value;
}

function cutPrompt(p: Prompt, max: number): Prompt {
  const payload = cutStrings(p.payload, max) as Prompt["payload"];
  return bytes(payload) === bytes(p.payload) ? p : { ...p, payload, truncated: true };
}

/**
 * Prompts for one reply to the phone (the first sync, `prompts.open`, `prompts.recent`) kept under `budget`
 * bytes. Within it they are sent as they are; over it, every long text in a payload is cut to the same length
 * (the longest that fits, down to MIN_CHARS) and the prompt says `truncated`. If even that is too much, the oldest
 * ones are dropped: from the front for the open list (oldest first), from the end for the history (newest first),
 * as `oldest` says. Ids, answers, statuses, questions and option labels are never touched.
 */
export function fitPrompts(
  prompts: Prompt[],
  budget: number = REPLY_DATA_BYTES,
  oldest: "first" | "last" = "last",
): Prompt[] {
  if (bytes(prompts) <= budget) return prompts;
  let max = Math.max(...prompts.map((p) => bytes(p.payload)), MIN_CHARS);
  let out = prompts;
  while (max > MIN_CHARS) {
    max = Math.max(MIN_CHARS, Math.floor(max * 0.7));
    out = prompts.map((p) => cutPrompt(p, max));
    if (bytes(out) <= budget) return out;
  }
  out = prompts.map((p) => cutPrompt(p, MIN_CHARS));
  while (out.length > 1 && bytes(out) > budget) out = oldest === "first" ? out.slice(1) : out.slice(0, -1);
  return out;
}

/** What one `prompt.opened` event may take over the relay, so a big prompt still fits a frame and a sync page. */
export const PROMPT_EVENT_BYTES = 128 * 1024;

/**
 * `event` as a phone that doesn't reassemble pieces gets it over the relay: a `prompt.opened` with long texts is
 * cut and says `truncated`, and steps come without their command output.
 */
export function fitEvent<E extends { type: string }>(event: E): E {
  if (event.type === "turn.action") {
    const e = event as unknown as { step: TurnStep };
    const step = withoutOutput(e.step);
    return step === e.step ? event : ({ ...event, step } as E);
  }
  if (event.type === "turn.done") {
    const e = event as unknown as { turn: Turn };
    if (!e.turn.steps?.some((s) => s.output !== undefined)) return event;
    return { ...event, turn: { ...e.turn, steps: e.turn.steps.map(withoutOutput) } } as E;
  }
  if (event.type !== "prompt.opened") return event;
  const e = event as unknown as { prompt: Prompt };
  const [prompt] = fitPrompts([e.prompt], PROMPT_EVENT_BYTES);
  return prompt === e.prompt ? event : ({ ...event, prompt } as E);
}

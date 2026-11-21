import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomicWrite.ts";

/** One round of pushes: how many phones were tried, how many accepted, and the last refusal. Never a token or text. */
export interface PushOutcome {
  at: number;
  tried: number;
  accepted: number;
  status?: number;
  reason?: string;
}

const KEEP = 10;
const FAILED_IN_A_ROW = 3;

function valid(o: unknown): o is PushOutcome {
  const x = o as PushOutcome;
  return (
    typeof x === "object" &&
    x !== null &&
    Number.isFinite(x.at) &&
    Number.isInteger(x.tried) &&
    Number.isInteger(x.accepted) &&
    (x.status === undefined || Number.isInteger(x.status)) &&
    (x.reason === undefined || typeof x.reason === "string")
  );
}

export function readPushOutcomes(path: string): PushOutcome[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw.filter(valid).slice(-KEEP) : [];
  } catch {
    return [];
  }
}

export class PushOutcomes {
  constructor(private readonly path: string) {}

  record(o: PushOutcome): void {
    if (o.tried === 0) return;
    const clean: PushOutcome = { at: o.at, tried: o.tried, accepted: o.accepted };
    if (o.status !== undefined) clean.status = o.status;
    if (o.reason) clean.reason = o.reason.slice(0, 80);
    try {
      writeFileAtomic(this.path, JSON.stringify([...readPushOutcomes(this.path), clean].slice(-KEEP)), 0o600);
    } catch {
      // A failed note must never fail the push.
    }
  }
}

export interface PushSummary {
  ok: boolean;
  text: string;
}

export function summarizePushes(
  outcomes: PushOutcome[],
  now: number,
  ago: (ms: number) => string,
): PushSummary {
  const last = outcomes.at(-1);
  if (!last) return { ok: true, text: "Push: none sent yet" };
  const when = ago(now - last.at);
  const recent = outcomes.slice(-FAILED_IN_A_ROW);
  const failing = recent.length === FAILED_IN_A_ROW && recent.every((o) => o.accepted === 0);
  if (last.accepted > 0) {
    const phones = last.tried === 1 ? "phone" : "phones";
    return {
      ok: true,
      text: `Push: last sent ${when} ago, accepted by ${last.accepted} of ${last.tried} ${phones}`,
    };
  }
  const why = [last.status, last.reason].filter((p) => p !== undefined && p !== "").join(" ");
  const text = `Push: last refused ${when} ago${why ? ` (${why})` : ""}`;
  return { ok: !failing, text: failing ? `${text}. The last ${FAILED_IN_A_ROW} all failed` : text };
}

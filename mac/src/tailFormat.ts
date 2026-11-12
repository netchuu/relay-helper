import { graphemes, type Prompt, type RelayEvent } from "../../protocol/index.ts";

/** One event as `relay tail` prints it. */
export function formatEvent(e: RelayEvent): string {
  const t = new Date(e.ts).toLocaleTimeString();
  switch (e.type) {
    case "session.upsert":
      return `${t} #${e.seq} session ${e.session.id.slice(0, 8)} ${e.session.project} → ${e.session.status}`;
    case "session.background":
      return `${t} #${e.seq} ⧗ ${e.sessionId.slice(0, 8)} ${e.tasks.length ? e.tasks.map((x) => `${x.kind} · ${x.title}`).join(", ") : "nothing in the background"}`;
    case "reply.waiting":
      return `${t} #${e.seq} ⏳ ${e.sessionId.slice(0, 8)} ${e.reason ? `waiting: ${e.reason}` : "nothing waiting"}`;
    case "session.removed":
      return `${t} #${e.seq} session ${e.sessionId.slice(0, 8)} removed`;
    case "turn.done":
      return `${t} #${e.seq} ✅ turn done ${e.turn.sessionId.slice(0, 8)} (${e.turn.stats.toolCalls} tools, ${e.turn.stats.filesEdited.length} files)\n    ${e.turn.summary.split("\n").join("\n    ")}`;
    case "turn.action":
      return `${t} #${e.seq} ▸ ${e.sessionId.slice(0, 8)} ${e.step.title ? `${e.step.tool ?? ""} · ${e.step.title}` : e.step.label}${e.step.failed ? " · Failed" : ""}`;
    case "turn.step":
      return `${t} #${e.seq} · ${e.sessionId.slice(0, 8)} ${e.step.label}`;
    case "turn.message":
      return `${t} #${e.seq} 💬 ${e.sessionId.slice(0, 8)} ${firstLineOf(e.message.text, 100)}`;
    case "turn.started":
      return `${t} #${e.seq} ▶ turn ${e.sessionId.slice(0, 8)}: ${e.prompt.split("\n")[0]?.slice(0, 80) ?? ""}`;
    case "prompt.opened":
      return `${t} #${e.seq} ❓ ${describePrompt(e.prompt)}`;
    case "prompt.closed":
      return `${t} #${e.seq} prompt ${e.promptId} closed by ${e.resolvedBy}`;
    case "presence.changed":
      return `${t} #${e.seq} presence ${e.presence.present ? "here" : "away"} (mode ${e.presence.mode})`;
    case "session.notice":
      return `${t} #${e.seq} [${e.level}] ${e.sessionId.slice(0, 8)} ${e.text}`;
  }
}

/** One open prompt as `relay prompts` and `relay tail` print it. */
export function describePrompt(p: Prompt): string {
  const head = `${p.id}  [${p.kind}] session ${p.sessionId.slice(0, 8)}`;
  switch (p.payload.kind) {
    case "question":
      return `${head}\n${p.payload.questions
        .map(
          (q, i) =>
            `  ${i + 1}. ${q.question}${q.multiSelect ? " (multi)" : ""}: ${q.options.map((o) => o.label).join(" | ")}`,
        )
        .join("\n")}`;
    case "plan":
      return `${head}\n  ${p.payload.plan.split("\n").slice(0, 8).join("\n  ")}`;
    case "permission":
      return `${head}\n  ${p.payload.toolName}: ${p.payload.summary}`;
  }
}

/** The first non-blank line, at most `max` characters as people see them (never half an emoji). */
function firstLineOf(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return graphemes(line).slice(0, max).join("");
}

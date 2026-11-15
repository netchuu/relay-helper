/**
 * What model and effort each session runs, as Claude Code reports them: the `SessionStart` hook's `model`, the
 * `PostModelSwitch` hook's `to_model`, and, when neither came (the helper started after the session), the last model
 * in the transcript. Claude Code's ids ("claude-fable-5-2", "opus[1m]") become what people read ("Fable 5.2").
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 64 * 1024;

/** "claude-fable-5-2" -> "Fable 5.2", "claude-opus-4-7-20260101" -> "Opus 4.7", "opus[1m]" -> "Opus (1M)"; null when empty. */
export function displayModel(id: string | null | undefined): string | null {
  if (typeof id !== "string") return null;
  let rest = id.trim().toLowerCase();
  if (!rest || rest.length > 100) return null;
  let suffix = "";
  const long = /\[(\d+)m\]$/.exec(rest);
  if (long) {
    suffix = ` (${long[1]}M)`;
    rest = rest.slice(0, long.index);
  }
  // Bedrock and Vertex ids: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5@20250929".
  rest = rest
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/^.*?(?=claude-)/, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
  const words = rest.split(/[-\s]+/).filter(Boolean);
  const name = words.filter((w) => /^[a-z]/.test(w));
  const numbers = words.filter((w) => /^\d+$/.test(w));
  if (name.length === 0) return null;
  const label = name.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
  return `${label}${numbers.length ? ` ${numbers.join(".")}` : ""}${suffix}`;
}

/** The model of the last assistant message in the tail of a transcript, or null. Not a documented contract: a fallback. */
export function modelFromTranscript(path: string | null | undefined): string | null {
  if (!path) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const found = [...buf.toString("utf8").matchAll(/"model":"(claude-[^"]{1,80})"/g)].pop();
    return found?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface ModelInfo {
  model?: string;
  effort?: string;
}

/**
 * The model and effort of each open session, in memory: Claude Code reports the model again when a session starts,
 * and its status line carries both (`model.display_name`, `effort.level`) on every refresh. What was typed from the
 * phone is not trusted: only what Claude Code reports is kept.
 */
export class SessionModels {
  private readonly info = new Map<string, ModelInfo>();

  /** Records a model Claude Code reported (an id or alias); false when nothing changed. */
  setModel(sessionId: string, id: unknown): boolean {
    return this.put(sessionId, "model", displayModel(typeof id === "string" ? id : null));
  }

  /** Records the status line's own name for the model ("Opus 4.7"), which beats one made from an id. */
  setModelName(sessionId: string, name: unknown): boolean {
    const shown = typeof name === "string" ? name.trim() : "";
    return this.put(sessionId, "model", shown && shown.length <= 60 ? shown : null);
  }

  /**
   * Records the effort level the status line reported ("high"); false when nothing changed. A status line without
   * one (a model that has no effort levels) clears what was recorded.
   */
  setEffort(sessionId: string, level: unknown): boolean {
    const shown = typeof level === "string" ? level.trim().toLowerCase() : "";
    if (/^[a-z]{2,20}$/.test(shown)) return this.put(sessionId, "effort", shown);
    const before = this.info.get(sessionId);
    if (before?.effort === undefined) return false;
    const { effort: _gone, ...rest } = before;
    this.info.set(sessionId, rest);
    return true;
  }

  private put(sessionId: string, key: keyof ModelInfo, value: string | null): boolean {
    if (!value) return false;
    const before = this.info.get(sessionId);
    if (before?.[key] === value) return false;
    this.info.set(sessionId, { ...before, [key]: value });
    return true;
  }

  has(sessionId: string): boolean {
    return this.info.get(sessionId)?.model !== undefined;
  }

  get(sessionId: string): ModelInfo {
    return this.info.get(sessionId) ?? {};
  }

  forget(sessionId: string): void {
    this.info.delete(sessionId);
  }
}

/** The one the daemon shares between its hooks and `publicSession`. */
export const sessionModels = new SessionModels();

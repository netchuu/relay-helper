/**
 * Removes secrets from any text before it leaves the Mac (WebSocket, push payloads). This is a safety
 * net, not a guarantee: it targets well-known token formats and obvious `key = value` assignments.
 */
const RULES: { kind: string; re: RegExp; keepPrefix?: boolean }[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, keepPrefix: true },
  { kind: "url-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, keepPrefix: true },
  {
    // KEY=value / "apiKey": "value" / password: value, for names that look secret.
    kind: "secret-assignment",
    re: /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    keepPrefix: true,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m: string[]) => {
      if (rule.keepPrefix) {
        const prefix = m[1] ?? "";
        const suffix = rule.kind === "url-credentials" ? (m[2] ?? "") : "";
        return `${prefix}[redacted:${rule.kind}]${suffix}`;
      }
      return `[redacted:${rule.kind}]`;
    });
  }
  return out;
}

/** Redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/**
 * Removes secrets from any text before it leaves the Mac (WebSocket, push payloads). This is a safety
 * net, not a guarantee: it targets well-known token formats and obvious `key = value` assignments.
 */
type Replacer = (...m: string[]) => string;
type Rule = { kind: string; re: RegExp; keepPrefix?: boolean; replace?: Replacer };

const tag = (kind: string) => `[redacted:${kind}]`;
const alreadyRedacted = (v: string) => v.startsWith("[redacted:");
/** A placeholder or reference rather than a value: `$TOKEN`, `${TOKEN}`, `<your-token>`, `{{ token }}`. */
const placeholder = (v: string) => /^(?:\$|<[^>]*>$|\{\{)/.test(v);
const onlyLetters = (v: string) => /^[A-Za-z]+$/.test(v);

/** A word that may stand after a secret-looking name in code: `req.body.password`, `process.env.GITHUB_TOKEN`. */
const codeReference = (v: string) => /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(v);

/**
 * The name before `:` or `=` has to end with the secret word (`MY_API_KEY`, `clientSecret`, `db.password_hash`),
 * so `tokenizer`, `tokens` and `secretName` are not secrets. Only a `_`, `.` or `-` may continue it. The suffix is
 * capped: an unbounded one is quadratic on long runs of the word.
 */
const SECRET_NAME =
  "(?:api[_-]?key|secret|token|(?<![A-Za-z])pass(?:w(?:or)?d|phrase)?|private[_-]?key|access[_-]?key|client[_-]?secret)";

const quotedOrWord = `(?:"([^"\\n]{6,})"|'([^'\\n]{6,})'|(["']?)([^\\s"',;]{8,}))`;

const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "telegram-bot-token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    // `Authorization: Basic …` and the like: the scheme word alone is ordinary prose.
    kind: "authorization",
    re: /(\bAuthorization["']?\s*[:=]\s*["']?(?:Basic|Digest|Negotiate|NTLM|Token|ApiKey)\s+)([^\s"',;]{4,})/gi,
    replace: (_m, prefix = "", v = "") => (alreadyRedacted(v) ? _m : `${prefix}${tag("authorization")}`),
  },
  {
    // Short Bearer tokens count too, but "Bearer authentication" is prose.
    kind: "bearer",
    re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{6,})/g,
    replace: (m, prefix = "", v = "") =>
      alreadyRedacted(v) || (onlyLetters(v) && v.length < 16) ? m : `${prefix}${tag("bearer")}`,
  },
  {
    // `scheme://user:password@host`. The password runs to the LAST `@` before the path, since it may hold `@`.
    kind: "url-credentials",
    re: /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]+:)[^\s/]+(@)/gi,
    keepPrefix: true,
  },
  {
    // A token as the URL's user: `https://ghs_…@github.com/…`. Short names (`git@`) are users.
    kind: "url-credentials",
    re: /(\b[a-z][a-z0-9+.-]{0,20}:\/\/)([A-Za-z0-9._~%+-]{16,})(@)/gi,
    replace: (m, scheme = "", user = "", at = "") =>
      /\d/.test(user) ? `${scheme}${tag("url-credentials")}${at}` : m,
  },
  {
    // `curl -u admin:password`, `--user admin:password`: the user stays, the password goes.
    kind: "cli-password",
    re: /(\b(?:curl|wget|http|https|xh)\b[^\n;&|]{0,300}?\s(?:-u\s*|--(?:proxy-)?user[\s=]\s*)['"]?[^\s:'"]+:)([^\s'"]+)/g,
    replace: (m, prefix = "", v = "") => (alreadyRedacted(v) ? m : `${prefix}${tag("cli-password")}`),
  },
  {
    // `sshpass -p …`, `docker login -u me -p …`: `-p` takes the password, with or without a space.
    kind: "cli-password",
    re: /(\b(?:sshpass|(?:docker|podman|nerdctl)\s+login)\b[^\n;&|]{0,300}?\s-p(?:\s+|(?=['"])|=))('[^']*'|"[^"]*"|[^\s'"][^\s]*)/g,
    replace: (m, prefix = "", v = "") => (alreadyRedacted(v) ? m : `${prefix}${tag("cli-password")}`),
  },
  {
    // `mysql -pSECRET`, `mysql -p'…'`: with a space, `-p` only asks for the password.
    kind: "cli-password",
    re: /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n;&|]{0,300}?\s-p)('[^']*'|"[^"]*"|[^\s'"-][^\s]*)/g,
    replace: (m, prefix = "", v = "") => (alreadyRedacted(v) ? m : `${prefix}${tag("cli-password")}`),
  },
  {
    // `--token X`, `--password=X`, `--api-key X`. After a space the value has to look like a value, not a word:
    // "the --token flag" is prose.
    kind: "cli-secret",
    re: /(--[a-z0-9-]*(?:token|password|passwd|passphrase|secret|api-?key|access-?key|auth)[a-z0-9-]*)(=|\s+)('[^']*'|"[^"]*"|[^\s'"-][^\s]*)/gi,
    replace: (m, flag = "", sep = "", v = "") => {
      const bare = v.replace(/^['"]|['"]$/g, "");
      if (alreadyRedacted(v) || placeholder(bare) || bare.length < 4) return m;
      if (sep !== "=" && (onlyLetters(bare) || bare.length < 6)) return m;
      return `${flag}${sep}${tag("cli-secret")}`;
    },
  },
  {
    // KEY=value / "apiKey": "value" / password: value, for names that look secret and values that look like secrets.
    kind: "secret-assignment",
    // No leading name run: `\b[A-Za-z0-9_.-]*` took quadratic time on long unbroken runs, and the text before the
    // keyword is kept either way.
    re: new RegExp(
      `(${SECRET_NAME}(?:[_.-][A-Za-z0-9_.-]{0,40})?["']?)(\\s*)([:=])(\\s*)${quotedOrWord}`,
      "gi",
    ),
    replace: (m, name = "", before = "", sep = "", after = "", dq = "", sq = "", lead = "", bare = "") => {
      const quoted = dq || sq;
      const v = quoted || bare;
      if (alreadyRedacted(v) || placeholder(v)) return m;
      if (!quoted) {
        // Code and prose, not values: `getItem("token")`, `req.body.password`, `The secret: consistency beats…`.
        if (/^(?:[\w.]+\(|[[{(])/.test(v) || codeReference(v)) return m;
        if (onlyLetters(v) && v.length < 20 && (sep === ":" || before || after)) return m;
      }
      const q = dq ? '"' : sq ? "'" : lead;
      return `${name}${before}${sep}${after}${q}${tag("secret-assignment")}${quoted ? q : ""}`;
    },
  },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m: string[]) => {
      if (rule.replace) return rule.replace(...m);
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

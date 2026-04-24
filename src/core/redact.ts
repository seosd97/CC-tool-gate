const REDACT_PATTERNS: readonly [RegExp, string][] = [
  [/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1[REDACTED]"],
  [/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[REDACTED]"],
  [
    /((?:api[_-]?key|access[_-]?token|secret[_-]?access[_-]?key|auth[_-]?token)\s*[:=]\s*)["']?[^\s"',]+/gi,
    "$1[REDACTED]",
  ],
  [/((?:password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',]+/gi, "$1[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
];

const SENSITIVE_KEY_RE =
  /^(?:password|passwd|pwd|secret|token|apikey|accesskey|accesstoken|secretkey|secretaccesskey|authtoken|authorization|privatekey|sessiontoken|clientsecret)$/i;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_.]/g, "");
  return SENSITIVE_KEY_RE.test(normalized);
}

export function redactString(s: string): string {
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && v != null && typeof v !== "object") {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Best-effort redaction of common secret shapes before audit records leave
 * the pipeline. Tool inputs can legitimately contain bearer tokens, API
 * keys, .env bodies, private keys, and so on; once written they land on
 * local disk and (if `STORAGE_BACKEND` is set) a cloud bucket, so we
 * scrub them here.
 *
 * The defaults are conservative and may not catch every custom secret
 * shape. Operators can add regexes via the `REDACT_PATTERNS` env var.
 */

export interface RedactRule {
  pattern: RegExp;
  replacement: string;
}

export const DEFAULT_REDACT_RULES: readonly RedactRule[] = [
  // "Authorization: Bearer <token>" or "authorization=<token>"
  {
    pattern: /(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi,
    replacement: "$1[REDACTED]",
  },
  // Bare "Bearer <token>" strings
  { pattern: /(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, replacement: "$1[REDACTED]" },
  // api_key=..., apiKey: ..., access-token=..., secret_access_key=...
  {
    pattern:
      /((?:api[_-]?key|access[_-]?token|secret[_-]?access[_-]?key|auth[_-]?token)\s*[:=]\s*)["']?[^\s"',]+/gi,
    replacement: "$1[REDACTED]",
  },
  // password=..., pwd: ...
  {
    pattern: /((?:password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',]+/gi,
    replacement: "$1[REDACTED]",
  },
  // AWS access key ID
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  // PEM-encoded private keys (RSA, EC, OPENSSH, generic)
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
];

/** Apply all rules to a single string. */
export function redactString(
  s: string,
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
): string {
  let out = s;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Recursively redact string leaves of a JSON-ish value. Keys are preserved,
 * non-string leaves (numbers, booleans, null) pass through.
 */
export function redact<T>(
  value: T,
  rules: readonly RedactRule[] = DEFAULT_REDACT_RULES,
): T {
  if (typeof value === "string") return redactString(value, rules) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, rules)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, rules);
    }
    return out as T;
  }
  return value;
}

/**
 * Parse an extra-rules spec from env (comma-separated regex strings). Bad
 * regexes are dropped with a console warning; they're operator-supplied and
 * we'd rather fail open than crash the server.
 */
export function parseExtraRules(
  spec: string,
  onBad?: (pattern: string, err: unknown) => void,
): RedactRule[] {
  const out: RedactRule[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      out.push({ pattern: new RegExp(raw, "gi"), replacement: "[REDACTED]" });
    } catch (err) {
      onBad?.(raw, err);
    }
  }
  return out;
}

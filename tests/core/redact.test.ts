import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REDACT_RULES,
  parseExtraRules,
  redact,
  redactString,
} from "../../src/core/redact";

describe("redactString default rules", () => {
  test("scrubs Authorization Bearer header", () => {
    const s = "Authorization: Bearer abc.def.ghi123";
    expect(redactString(s)).toBe("Authorization: Bearer [REDACTED]");
  });

  test("scrubs bare Bearer token", () => {
    const s = "curl -H 'bearer sk_live_abcdef12345'";
    expect(redactString(s)).toContain("bearer [REDACTED]");
  });

  test("scrubs api_key=, apiKey:, access-token=", () => {
    expect(redactString("api_key=secret123")).toBe("api_key=[REDACTED]");
    expect(redactString("apiKey: secret123")).toBe("apiKey: [REDACTED]");
    expect(redactString("access-token=abcdef")).toBe("access-token=[REDACTED]");
    // The optional opening quote is consumed by the match; only the trailing
    // quote is left behind.
    expect(redactString('secret_access_key="xyz"')).toBe(
      'secret_access_key=[REDACTED]"',
    );
  });

  test("scrubs password assignments", () => {
    expect(redactString("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactString("pwd: hunter2")).toBe("pwd: [REDACTED]");
  });

  test("scrubs AWS access key IDs", () => {
    expect(redactString("AKIAIOSFODNN7EXAMPLE is leaked")).toBe(
      "[REDACTED_AWS_KEY] is leaked",
    );
  });

  test("scrubs PEM private keys", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxyz
-----END RSA PRIVATE KEY-----`;
    expect(redactString(pem)).toBe("[REDACTED_PRIVATE_KEY]");
  });

  test("leaves unrelated content alone", () => {
    const s = "echo hello world";
    expect(redactString(s)).toBe(s);
  });
});

describe("redact (recursive)", () => {
  test("redacts string leaves in nested objects and arrays", () => {
    const input = {
      tool_name: "Bash",
      tool_input: {
        command: "curl -H 'Authorization: Bearer tok.secret.xyz' https://x",
        env: ["api_key=leaked", "USER=me"],
        nested: { body: "password=hunter2&x=y", safe: 42 },
      },
    };
    const out = redact(input);
    expect(out.tool_input.command).toContain("Authorization: Bearer [REDACTED]");
    expect(out.tool_input.env[0]).toBe("api_key=[REDACTED]");
    expect(out.tool_input.env[1]).toBe("USER=me");
    expect(out.tool_input.nested.body).toBe("password=[REDACTED]");
    // non-string leaves pass through
    expect(out.tool_input.nested.safe).toBe(42);
  });

  test("preserves null and primitive leaves", () => {
    expect(redact(null)).toBe(null);
    expect(redact(123)).toBe(123);
    expect(redact(true)).toBe(true);
  });

  test("accepts custom rules and overrides defaults", () => {
    const rules = [{ pattern: /foo/g, replacement: "BAR" }];
    expect(redactString("foo baz AKIAIOSFODNN7EXAMPLE", rules)).toBe(
      "BAR baz AKIAIOSFODNN7EXAMPLE",
    );
  });
});

describe("parseExtraRules", () => {
  test("returns compiled rules for each comma-separated pattern", () => {
    const rules = parseExtraRules("mytoken_[A-Z0-9]+,internal_id=\\d+");
    expect(rules).toHaveLength(2);
    const s = "mytoken_ABC123 and internal_id=42";
    let out = s;
    for (const r of rules) out = out.replace(r.pattern, r.replacement);
    expect(out).toBe("[REDACTED] and [REDACTED]");
  });

  test("drops invalid regexes and calls onBad", () => {
    const bad: string[] = [];
    const rules = parseExtraRules("good_\\d+,[unclosed", (p) => bad.push(p));
    expect(rules).toHaveLength(1);
    expect(bad).toEqual(["[unclosed"]);
  });

  test("empty spec yields no rules", () => {
    expect(parseExtraRules("")).toEqual([]);
    expect(parseExtraRules("  ,  ,")).toEqual([]);
  });
});

describe("DEFAULT_REDACT_RULES exported shape", () => {
  test("is a non-empty readonly array of RedactRule", () => {
    expect(Array.isArray(DEFAULT_REDACT_RULES)).toBe(true);
    expect(DEFAULT_REDACT_RULES.length).toBeGreaterThan(0);
    for (const r of DEFAULT_REDACT_RULES) {
      expect(r.pattern).toBeInstanceOf(RegExp);
      expect(typeof r.replacement).toBe("string");
    }
  });
});

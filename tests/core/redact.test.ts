import { describe, expect, test } from "bun:test";
import { redact, redactString } from "@/core/redact";

describe("redactString", () => {
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
    expect(redactString('secret_access_key="xyz"')).toBe('secret_access_key=[REDACTED]"');
  });

  test("scrubs password assignments", () => {
    expect(redactString("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactString("pwd: hunter2")).toBe("pwd: [REDACTED]");
  });

  test("scrubs AWS access key IDs", () => {
    expect(redactString("AKIAIOSFODNN7EXAMPLE is leaked")).toBe("[REDACTED_AWS_KEY] is leaked");
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
    expect(out.tool_input.nested.safe).toBe(42);
  });

  test("preserves null and primitive leaves", () => {
    expect(redact(null)).toBe(null);
    expect(redact(123)).toBe(123);
    expect(redact(true)).toBe(true);
  });

  test("redacts values under sensitive key names", () => {
    const input = {
      password: "hunter2",
      apiKey: "sk_live_xyz",
      "access-token": "abc",
      api_key: "k1",
      nested: { secret: "shh", clientSecret: "c", user: "me" },
      arr: [{ token: "t1" }, { safe: "ok" }],
      numeric_token: 12345,
    };
    const out = redact(input) as any;
    expect(out.password).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out["access-token"]).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.nested.secret).toBe("[REDACTED]");
    expect(out.nested.clientSecret).toBe("[REDACTED]");
    expect(out.nested.user).toBe("me");
    expect(out.arr[0].token).toBe("[REDACTED]");
    expect(out.arr[1].safe).toBe("ok");
    expect(out.numeric_token).toBe(12345);
  });

  test("does not redact unrelated key names", () => {
    const out = redact({ command: "ls", path: "/tmp", user: "me" }) as any;
    expect(out.command).toBe("ls");
    expect(out.path).toBe("/tmp");
    expect(out.user).toBe("me");
  });
});

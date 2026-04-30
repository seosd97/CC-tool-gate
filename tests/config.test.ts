import { describe, expect, test } from "bun:test";
import { loadConfig } from "@/config";

const baseEnv = {
  AUTH_TOKEN: "tok",
  ANTHROPIC_API_KEY: "sk-test",
  POLICY_SOURCES: "file:///etc/cc-tool-gate/policies",
};

describe("loadConfig", () => {
  test("parses required fields and resolves file:// sources to paths", () => {
    const cfg = loadConfig({
      ...baseEnv,
      POLICY_SOURCES: "file:///etc/cc-tool-gate/policies, file://localhost/var/policies",
    });
    expect(cfg.AUTH_TOKEN).toBe("tok");
    expect(cfg.POLICY_SOURCES).toEqual(["/etc/cc-tool-gate/policies", "/var/policies"]);
    expect(cfg.PORT).toBe(8787);
    expect(cfg.LLM_MODEL).toBe("claude-haiku-4-5");
  });

  test("accepts legacy file://./relative form", () => {
    const cfg = loadConfig({
      ...baseEnv,
      POLICY_SOURCES: "file://./local",
    });
    expect(cfg.POLICY_SOURCES).toEqual(["./local"]);
  });

  test("rejects non-file:// sources", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        POLICY_SOURCES: "https://example.com/policies",
      }),
    ).toThrow(/file:\/\//);
  });

  test("throws on missing required vars", () => {
    expect(() => loadConfig({})).toThrow(/AUTH_TOKEN/);
  });

  test("PORT coerces from string", () => {
    const cfg = loadConfig({ ...baseEnv, PORT: "9999" });
    expect(cfg.PORT).toBe(9999);
  });

  test("CACHE_TTL_MS coerces from string", () => {
    const cfg = loadConfig({ ...baseEnv, CACHE_TTL_MS: "12345" });
    expect(cfg.CACHE_TTL_MS).toBe(12345);
  });

  test("CACHE_MAX coerces from string", () => {
    const cfg = loadConfig({ ...baseEnv, CACHE_MAX: "500" });
    expect(cfg.CACHE_MAX).toBe(500);
  });

  test("LLM_TIMEOUT_MS defaults and coerces from string", () => {
    expect(loadConfig(baseEnv).LLM_TIMEOUT_MS).toBe(15_000);
    expect(loadConfig({ ...baseEnv, LLM_TIMEOUT_MS: "3000" }).LLM_TIMEOUT_MS).toBe(3000);
  });

  test("MAX_BODY_BYTES defaults and coerces from string", () => {
    expect(loadConfig(baseEnv).MAX_BODY_BYTES).toBe(64 * 1024);
    expect(loadConfig({ ...baseEnv, MAX_BODY_BYTES: "1024" }).MAX_BODY_BYTES).toBe(1024);
  });
});

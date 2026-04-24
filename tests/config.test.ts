import { describe, expect, test } from "bun:test";
import { loadConfig } from "@/config";

const baseEnv = {
  AUTH_TOKEN: "tok",
  ANTHROPIC_API_KEY: "sk-test",
  POLICY_SOURCES: "file:///etc/cc-tool-gate/policies",
};

describe("loadConfig", () => {
  test("parses required fields and splits sources", () => {
    const cfg = loadConfig({
      ...baseEnv,
      POLICY_SOURCES: "file:///etc/cc-tool-gate/policies, file://./local",
    });
    expect(cfg.AUTH_TOKEN).toBe("tok");
    expect(cfg.POLICY_SOURCES).toEqual(["file:///etc/cc-tool-gate/policies", "file://./local"]);
    expect(cfg.PORT).toBe(8787);
    expect(cfg.LLM_MODEL).toBe("claude-haiku-4-5");
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
});

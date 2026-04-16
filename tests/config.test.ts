import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const baseEnv = {
  AUTH_TOKEN: "tok",
  ANTHROPIC_API_KEY: "sk-test",
  POLICY_SOURCES: "file:///etc/cc-tool-gate/policies, inline:abcd",
};

describe("loadConfig", () => {
  test("parses required fields and splits sources", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.AUTH_TOKEN).toBe("tok");
    expect(cfg.POLICY_SOURCES).toEqual([
      "file:///etc/cc-tool-gate/policies",
      "inline:abcd",
    ]);
    expect(cfg.PORT).toBe(8787);
    expect(cfg.LLM_MODEL).toBe("claude-haiku-4-5");
    expect(cfg.HOSTNAME.length).toBeGreaterThan(0);
    expect(cfg.r2Enabled).toBe(false);
  });

  test("throws on missing required vars", () => {
    expect(() => loadConfig({})).toThrow(/AUTH_TOKEN/);
  });

  test("r2Enabled when all R2 vars present", () => {
    const cfg = loadConfig({
      ...baseEnv,
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "i",
      R2_SECRET_ACCESS_KEY: "s",
      R2_BUCKET: "b",
    });
    expect(cfg.r2Enabled).toBe(true);
  });

  test("PORT coerces from string", () => {
    const cfg = loadConfig({ ...baseEnv, PORT: "9999" });
    expect(cfg.PORT).toBe(9999);
  });
});

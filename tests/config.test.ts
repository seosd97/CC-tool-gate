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
    expect(cfg.STORAGE_BACKEND).toBe("none");
    expect(cfg.UPLOAD_POLL_MS).toBe(30_000);
  });

  test("throws on missing required vars", () => {
    expect(() => loadConfig({})).toThrow(/AUTH_TOKEN/);
  });

  test("STORAGE_BACKEND=none requires no storage env vars", () => {
    const cfg = loadConfig({ ...baseEnv, STORAGE_BACKEND: "none" });
    expect(cfg.STORAGE_BACKEND).toBe("none");
  });

  test("STORAGE_BACKEND=r2 with all R2 vars present is accepted", () => {
    const cfg = loadConfig({
      ...baseEnv,
      STORAGE_BACKEND: "r2",
      R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      R2_BUCKET: "b",
      R2_ACCESS_KEY_ID: "i",
      R2_SECRET_ACCESS_KEY: "s",
    });
    expect(cfg.STORAGE_BACKEND).toBe("r2");
    expect(cfg.R2_ENDPOINT).toBe("https://acct.r2.cloudflarestorage.com");
  });

  test("STORAGE_BACKEND=r2 with missing R2_* throws listing the missing fields", () => {
    expect(() =>
      loadConfig({ ...baseEnv, STORAGE_BACKEND: "r2" }),
    ).toThrow(
      /STORAGE_BACKEND=r2 requires .*R2_ENDPOINT.*R2_BUCKET.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY/,
    );
  });

  test("STORAGE_BACKEND=r2 missing only some R2_* mentions just those", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        STORAGE_BACKEND: "r2",
        R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        R2_BUCKET: "b",
      }),
    ).toThrow(/R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  });

  test("STORAGE_BACKEND=s3 with all S3 vars present is accepted", () => {
    const cfg = loadConfig({
      ...baseEnv,
      STORAGE_BACKEND: "s3",
      S3_REGION: "us-east-1",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "i",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(cfg.STORAGE_BACKEND).toBe("s3");
    expect(cfg.S3_REGION).toBe("us-east-1");
    expect(cfg.S3_SESSION_TOKEN).toBe("");
    expect(cfg.S3_ENDPOINT).toBe("");
  });

  test("STORAGE_BACKEND=s3 with missing S3_* throws", () => {
    expect(() =>
      loadConfig({ ...baseEnv, STORAGE_BACKEND: "s3" }),
    ).toThrow(
      /STORAGE_BACKEND=s3 requires .*S3_REGION.*S3_BUCKET.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/,
    );
  });

  test("STORAGE_BACKEND=s3 accepts optional sessionToken and endpoint", () => {
    const cfg = loadConfig({
      ...baseEnv,
      STORAGE_BACKEND: "s3",
      S3_REGION: "us-east-1",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "i",
      S3_SECRET_ACCESS_KEY: "s",
      S3_SESSION_TOKEN: "tok",
      S3_ENDPOINT: "http://localhost:4566",
    });
    expect(cfg.S3_SESSION_TOKEN).toBe("tok");
    expect(cfg.S3_ENDPOINT).toBe("http://localhost:4566");
  });

  test("invalid STORAGE_BACKEND value is rejected by zod", () => {
    expect(() =>
      loadConfig({ ...baseEnv, STORAGE_BACKEND: "bogus" }),
    ).toThrow(/STORAGE_BACKEND/);
  });

  test("PORT coerces from string", () => {
    const cfg = loadConfig({ ...baseEnv, PORT: "9999" });
    expect(cfg.PORT).toBe(9999);
  });

  test("UPLOAD_POLL_MS coerces from string", () => {
    const cfg = loadConfig({ ...baseEnv, UPLOAD_POLL_MS: "12345" });
    expect(cfg.UPLOAD_POLL_MS).toBe(12345);
  });
});

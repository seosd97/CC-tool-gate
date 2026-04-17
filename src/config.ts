import { hostname } from "node:os";
import { z } from "zod";

const StorageBackend = z.enum(["r2", "s3", "none"]);
export type StorageBackend = z.infer<typeof StorageBackend>;

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  AUTH_TOKEN: z.string().min(1, "AUTH_TOKEN is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  LLM_MODEL: z.string().default("claude-haiku-4-5"),
  POLICY_SOURCES: z
    .string()
    .min(1, "POLICY_SOURCES is required (comma-separated URIs)"),
  LOGS_DIR: z.string().default("./logs"),
  HOSTNAME: z.string().default(""),

  STORAGE_BACKEND: StorageBackend.default("none"),

  // R2 (read only when STORAGE_BACKEND=r2)
  R2_ENDPOINT: z.string().default(""),
  R2_BUCKET: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),

  // S3 (read only when STORAGE_BACKEND=s3)
  S3_REGION: z.string().default(""),
  S3_BUCKET: z.string().default(""),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_SESSION_TOKEN: z.string().default(""),
  S3_ENDPOINT: z.string().default(""),

  CACHE_TTL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  CACHE_MAX: z.coerce.number().int().positive().default(2_000),
  POLICY_POLL_MS: z.coerce.number().int().positive().default(60_000),
  UPLOAD_POLL_MS: z.coerce.number().int().positive().default(30_000),
});

export type AppConfig = ReturnType<typeof loadConfig>;

const R2_REQUIRED = [
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

const S3_REQUIRED = [
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  if (cfg.STORAGE_BACKEND === "r2") {
    const missing = R2_REQUIRED.filter((k) => !cfg[k]);
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration: STORAGE_BACKEND=r2 requires ${missing.join(", ")}`,
      );
    }
  } else if (cfg.STORAGE_BACKEND === "s3") {
    const missing = S3_REQUIRED.filter((k) => !cfg[k]);
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration: STORAGE_BACKEND=s3 requires ${missing.join(", ")}`,
      );
    }
  }

  const sources = cfg.POLICY_SOURCES.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    ...cfg,
    POLICY_SOURCES: sources,
    HOSTNAME: cfg.HOSTNAME || hostname(),
  };
}

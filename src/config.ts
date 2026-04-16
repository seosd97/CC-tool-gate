import { hostname } from "node:os";
import { z } from "zod";

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

  R2_ACCOUNT_ID: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  R2_BUCKET: z.string().default(""),

  CACHE_TTL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  CACHE_MAX: z.coerce.number().int().positive().default(2_000),
  POLICY_POLL_MS: z.coerce.number().int().positive().default(60_000),
  R2_POLL_MS: z.coerce.number().int().positive().default(30_000),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const sources = cfg.POLICY_SOURCES.split(",").map((s) => s.trim()).filter(Boolean);
  const r2Enabled = !!(
    cfg.R2_ACCOUNT_ID &&
    cfg.R2_ACCESS_KEY_ID &&
    cfg.R2_SECRET_ACCESS_KEY &&
    cfg.R2_BUCKET
  );
  return {
    ...cfg,
    POLICY_SOURCES: sources,
    HOSTNAME: cfg.HOSTNAME || hostname(),
    r2Enabled,
  };
}

import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("127.0.0.1"),
  AUTH_TOKEN: z.string().min(1, "AUTH_TOKEN is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  LLM_MODEL: z.string().default("claude-haiku-4-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  POLICY_SOURCES: z.string().min(1, "POLICY_SOURCES is required (comma-separated URIs)"),
  LOGS_DIR: z.string().default("./logs"),

  CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  CACHE_MAX: z.coerce.number().int().positive().default(2_000),

  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.enum(["auto", "true", "false"]).default("auto"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`Unsupported POLICY_SOURCES scheme: ${uri} (only file:// is supported)`);
  }
  try {
    const u = new URL(uri);
    if (u.host === "" || u.host === "localhost") {
      return decodeURIComponent(u.pathname);
    }
  } catch {}
  return uri.slice("file://".length);
}

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const sources = cfg.POLICY_SOURCES.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(fileUriToPath);
  return { ...cfg, POLICY_SOURCES: sources };
}

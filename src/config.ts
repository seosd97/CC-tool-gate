import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  /** Interface to bind. Defaults to loopback so the gate isn't accidentally
   * reachable from the LAN; set to 0.0.0.0 only if you really mean it. */
  HOST: z.string().default("127.0.0.1"),
  AUTH_TOKEN: z.string().min(1, "AUTH_TOKEN is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  LLM_MODEL: z.string().default("claude-haiku-4-5"),
  POLICY_SOURCES: z.string().min(1, "POLICY_SOURCES is required (comma-separated URIs)"),
  LOGS_DIR: z.string().default("./logs"),

  CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  CACHE_MAX: z.coerce.number().int().positive().default(2_000),

  /** Per-session rate limit; 0 disables rate limiting. */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().nonnegative().default(600),
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
  const sources = cfg.POLICY_SOURCES.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ...cfg, POLICY_SOURCES: sources };
}

import { createMemoryCache } from "./adapters/cache";
import { createJsonlSink } from "./adapters/jsonl";
import { createLlmJudge } from "./adapters/llm";
import { createPolicyRegistry, createSourceProvider } from "./adapters/sources";
import { createApp } from "./api/app";
import { type AppConfig, loadConfig } from "./config";
import { createLogger } from "./core/logger";
import { createRateLimiter } from "./core/ratelimit";
import { DEFAULT_REDACT_RULES } from "./core/redact";

const logger = createLogger();

async function main(): Promise<void> {
  let cfg: AppConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    logger.error("Failed to load configuration", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const cache = createMemoryCache({
    ttlMs: cfg.CACHE_TTL_MS,
    maxEntries: cfg.CACHE_MAX,
  });

  const llm = createLlmJudge({
    apiKey: cfg.ANTHROPIC_API_KEY,
    model: cfg.LLM_MODEL,
    timeoutMs: 15_000,
  });

  const sink = createJsonlSink({ logsDir: cfg.LOGS_DIR });

  const sources = cfg.POLICY_SOURCES.map((uri) => createSourceProvider(uri, logger));
  const registry = createPolicyRegistry({ sources });
  await registry.reload();

  const rateLimiter =
    cfg.RATE_LIMIT_PER_MIN > 0
      ? createRateLimiter({
          windowMs: 60_000,
          maxRequests: cfg.RATE_LIMIT_PER_MIN,
        })
      : undefined;

  const app = createApp({
    authToken: cfg.AUTH_TOKEN,
    llm,
    cache,
    sink,
    getSnapshot: () => registry.snapshot(),
    reload: () => registry.reload(),
    redactRules: DEFAULT_REDACT_RULES,
    rateLimiter,
  });

  const server = Bun.serve({
    port: cfg.PORT,
    hostname: cfg.HOST,
    fetch: app.fetch,
  });

  const policyCount = registry.snapshot().policies.length;
  logger.info("cc-tool-gate started", {
    host: cfg.HOST,
    port: cfg.PORT,
    policies: policyCount,
  });
  if (policyCount === 0) {
    logger.warn("No policies loaded", {
      sources: cfg.POLICY_SOURCES,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    server.stop();
    try {
      await sink.flush?.();
    } catch {
      // Best-effort flush; don't block exit.
    }
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => process.exit(1));
  });
}

main().catch((err: unknown) => {
  logger.error("Unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

import { loadConfig } from "./config";
import { createApp } from "./api/app";
import { createMemoryCache } from "./adapters/cache";
import { createLlmJudge } from "./adapters/llm";
import { createJsonlSink } from "./adapters/jsonl";
import {
  createPolicyRegistry,
  createSourceProvider,
} from "./adapters/sources";
import { DEFAULT_REDACT_RULES } from "./core/redact";
import { createRateLimiter } from "./core/ratelimit";

async function main(): Promise<void> {
  const cfg = loadConfig();

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

  const sources = cfg.POLICY_SOURCES.map((uri) => createSourceProvider(uri));
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
  // eslint-disable-next-line no-console
  console.log(
    `cc-tool-gate listening on ${cfg.HOST}:${cfg.PORT} (policies=${policyCount})`,
  );
  if (policyCount === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `WARNING: 0 policies loaded from POLICY_SOURCES=${cfg.POLICY_SOURCES.join(",")}. The gate will fall back to "allow" for every request that isn't caught by index.yaml hard rules.`,
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

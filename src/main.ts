import { loadConfig } from "./config";
import { createApp } from "./api/app";
import { createMemoryCache } from "./adapters/cache";
import { createLlmJudge } from "./adapters/llm";
import { createJsonlSink } from "./adapters/jsonl";
import { createStorageSink } from "./adapters/storage";
import { createUploadWorker } from "./adapters/upload-worker";
import {
  createPolicyRegistry,
  createSourceProvider,
} from "./adapters/sources";
import { DEFAULT_REDACT_RULES, parseExtraRules } from "./core/redact";
import { createRateLimiter } from "./core/ratelimit";
import type { StorageSink } from "./core/types";

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
  const registry = createPolicyRegistry({
    sources,
    pollMs: cfg.POLICY_POLL_MS,
  });
  await registry.reload();
  registry.start();

  // Local-only mode has no cloud sink; use a no-op that reports success so
  // the worker drains pending/ into uploaded/, where its retention sweep
  // then prunes files older than retainMs like any other backend.
  const storage: StorageSink = createStorageSink(cfg) ?? {
    upload: async () => true,
  };
  const worker = createUploadWorker({
    sink: storage,
    pendingDir: sink.pendingDir(),
    uploadedDir: sink.uploadedDir(),
    deadLetterDir: sink.deadLetterDir(),
    hostname: cfg.HOSTNAME,
    intervalMs: cfg.UPLOAD_POLL_MS,
    maxAttempts: cfg.UPLOAD_MAX_ATTEMPTS,
  });
  worker.start();
  // periodic forced rotation so we don't sit on data forever
  const rotateTimer = setInterval(() => {
    void sink.rotateNow();
  }, 60_000);

  const extraRules = parseExtraRules(cfg.REDACT_PATTERNS, (raw, err) => {
    // eslint-disable-next-line no-console
    console.warn(
      `REDACT_PATTERNS: skipping invalid regex ${JSON.stringify(raw)} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  });
  const redactRules = [...DEFAULT_REDACT_RULES, ...extraRules];

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
    redactRules,
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
    `cc-tool-gate listening on ${cfg.HOST}:${cfg.PORT} (policies=${policyCount}, storage=${cfg.STORAGE_BACKEND})`,
  );
  if (policyCount === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `WARNING: 0 policies loaded from POLICY_SOURCES=${cfg.POLICY_SOURCES.join(",")}. The gate will fall back to "allow" for every request that isn't caught by index.yaml hard rules.`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);

    // 1. Stop accepting new HTTP requests so no new audit writes are queued.
    server.stop();
    // 2. Stop background pollers so they don't race the final flush.
    registry.stop();
    clearInterval(rotateTimer);

    // 3. Flush the active JSONL file so it lands in pending/ for upload.
    try {
      await sink.rotateNow();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("rotateNow on shutdown failed:", err);
    }

    // 4. One last upload sweep, then stop the worker.
    try {
      await worker.tick();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("upload tick on shutdown failed:", err);
    }
    worker.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

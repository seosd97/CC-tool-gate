import { loadConfig } from "./config";
import { createApp } from "./api/app";
import { createMemoryCache } from "./adapters/cache";
import { createLlmJudge } from "./adapters/llm";
import { createJsonlSink } from "./adapters/jsonl";
import { createStorageSink } from "./adapters/storage";
import { createUploadWorker, type UploadWorker } from "./adapters/upload-worker";
import {
  createPolicyRegistry,
  createSourceProvider,
} from "./adapters/sources";
import { DEFAULT_REDACT_RULES, parseExtraRules } from "./core/redact";

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

  const storage = createStorageSink(cfg);
  let worker: UploadWorker | null = null;
  let rotateTimer: ReturnType<typeof setInterval> | null = null;
  if (storage) {
    worker = createUploadWorker({
      sink: storage,
      pendingDir: sink.pendingDir(),
      uploadedDir: sink.uploadedDir(),
      hostname: cfg.HOSTNAME,
      intervalMs: cfg.UPLOAD_POLL_MS,
    });
    worker.start();
    // periodic forced rotation so we don't sit on data forever
    rotateTimer = setInterval(() => {
      void sink.rotateNow();
    }, 60_000);
  }

  const extraRules = parseExtraRules(cfg.REDACT_PATTERNS, (raw, err) => {
    // eslint-disable-next-line no-console
    console.warn(
      `REDACT_PATTERNS: skipping invalid regex ${JSON.stringify(raw)} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  });
  const redactRules = [...DEFAULT_REDACT_RULES, ...extraRules];

  const app = createApp({
    authToken: cfg.AUTH_TOKEN,
    llm,
    cache,
    sink,
    getSnapshot: () => registry.snapshot(),
    reload: () => registry.reload(),
    redactRules,
  });

  const server = Bun.serve({
    port: cfg.PORT,
    fetch: app.fetch,
  });

  // eslint-disable-next-line no-console
  console.log(
    `cc-tool-gate listening on :${cfg.PORT} (policies=${registry.snapshot().policies.length}, storage=${cfg.STORAGE_BACKEND})`,
  );

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
    if (rotateTimer) clearInterval(rotateTimer);

    // 3. Flush the active JSONL file so it lands in pending/ for upload.
    try {
      await sink.rotateNow();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("rotateNow on shutdown failed:", err);
    }

    // 4. One last upload sweep, then stop the worker.
    if (worker) {
      try {
        await worker.tick();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("upload tick on shutdown failed:", err);
      }
      worker.stop();
    }
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

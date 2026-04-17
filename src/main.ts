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

  const sources = cfg.POLICY_SOURCES.map(createSourceProvider);
  const registry = createPolicyRegistry({
    sources,
    pollMs: cfg.POLICY_POLL_MS,
  });
  await registry.reload();
  registry.start();

  const storage = createStorageSink(cfg);
  if (storage) {
    const worker = createUploadWorker({
      sink: storage,
      pendingDir: sink.pendingDir(),
      uploadedDir: sink.uploadedDir(),
      hostname: cfg.HOSTNAME,
      intervalMs: cfg.UPLOAD_POLL_MS,
    });
    worker.start();
    // periodic forced rotation so we don't sit on data forever
    setInterval(() => {
      void sink.rotateNow();
    }, 60_000);
  }

  const app = createApp({
    authToken: cfg.AUTH_TOKEN,
    llm,
    cache,
    sink,
    getSnapshot: () => registry.snapshot(),
    reload: () => registry.reload(),
  });

  Bun.serve({
    port: cfg.PORT,
    fetch: app.fetch,
  });

  // eslint-disable-next-line no-console
  console.log(
    `cc-tool-gate listening on :${cfg.PORT} (policies=${registry.snapshot().policies.length}, storage=${cfg.STORAGE_BACKEND})`,
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

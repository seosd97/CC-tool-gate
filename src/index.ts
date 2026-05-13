import { createJsonlSink } from "@/adapters/audit-log";
import { createLlmJudge } from "@/adapters/llm";
import { createPolicyStore } from "@/adapters/sources";
import { createApp } from "@/api/app";
import { type AppConfig, loadConfig } from "@/config";
import { createMemoryCache } from "@/core/cache";
import { getErrorMessage } from "@/lib/errors";
import { log, setLogLevel } from "@/lib/logger";

let cfg: AppConfig;
try {
  cfg = loadConfig();
} catch (err) {
  log.error({ error: getErrorMessage(err) }, "Failed to load configuration");
  process.exit(1);
}

setLogLevel(cfg.LOG_LEVEL);

const cache = createMemoryCache({ ttlMs: cfg.CACHE_TTL_MS, maxEntries: cfg.CACHE_MAX });

const llm = createLlmJudge({
  apiKey: cfg.ANTHROPIC_API_KEY,
  model: cfg.LLM_MODEL,
  timeoutMs: cfg.LLM_TIMEOUT_MS,
});

const sink = createJsonlSink({ logsDir: cfg.LOGS_DIR });

const store = createPolicyStore(cfg.POLICY_SOURCES);
await store.reload();

const app = createApp({
  authToken: cfg.AUTH_TOKEN,
  llm,
  cache,
  sink,
  getSnapshot: () => store.snapshot(),
  reload: () => store.reload(),
  maxBodyBytes: cfg.MAX_BODY_BYTES,
});

const server = Bun.serve({
  port: cfg.PORT,
  hostname: cfg.HOST,
  fetch: app.fetch,
});

const policyCount = store.snapshot().policies.length;
log.info(
  { host: server.hostname, port: server.port, policies: policyCount },
  "cc-tool-gate started",
);
if (policyCount === 0) {
  log.warn({ sources: cfg.POLICY_SOURCES }, "No policies loaded");
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "Shutting down");
  try {
    await server.stop(true);
  } catch (err) {
    log.warn({ error: getErrorMessage(err) }, "Server stop reported error");
  }
  try {
    await sink.flush?.();
  } catch {}
  log.info("Shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});

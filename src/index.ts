import { createJsonlSink } from "@/adapters/audit-log";
import { createLlmJudge } from "@/adapters/llm";
import { createPolicyStore } from "@/adapters/sources";
import { createApp } from "@/api/app";
import { type AppConfig, loadConfig } from "@/config";
import { createMemoryCache } from "@/core/cache";

const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg, ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg, ...meta })),
};

let cfg: AppConfig;
try {
  cfg = loadConfig();
} catch (err) {
  log.error("Failed to load configuration", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

const dirs = cfg.POLICY_SOURCES.map((uri) => {
  if (!uri.startsWith("file://")) {
    throw new Error(`Unsupported POLICY_SOURCES scheme: ${uri} (only file:// is supported)`);
  }
  return uri.replace(/^file:\/\//, "");
});

const cache = createMemoryCache({ ttlMs: cfg.CACHE_TTL_MS, maxEntries: cfg.CACHE_MAX });

const llm = createLlmJudge({
  apiKey: cfg.ANTHROPIC_API_KEY,
  model: cfg.LLM_MODEL,
  timeoutMs: 15_000,
});

const sink = createJsonlSink({ logsDir: cfg.LOGS_DIR });

const store = createPolicyStore(dirs);
await store.reload();

const app = createApp({
  authToken: cfg.AUTH_TOKEN,
  llm,
  cache,
  sink,
  getSnapshot: () => store.snapshot(),
  reload: () => store.reload(),
});

const policyCount = store.snapshot().policies.length;
log.info("cc-tool-gate started", { host: cfg.HOST, port: cfg.PORT, policies: policyCount });
if (policyCount === 0) {
  log.warn("No policies loaded", { sources: cfg.POLICY_SOURCES });
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down", { signal });
  try {
    await sink.flush?.();
  } catch {
    // Best-effort flush
  }
  log.info("Shutdown complete");
  process.exit(0);
};

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});

export default {
  port: cfg.PORT,
  hostname: cfg.HOST,
  fetch: app.fetch,
};

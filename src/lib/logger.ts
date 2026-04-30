import pino from "pino";

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

// Bootstrap level: if LOG_LEVEL is set to something pino accepts, honor it so
// that errors during loadConfig() itself are visible at the requested level.
// Otherwise default to "info". Once loadConfig succeeds, index.ts should call
// setLogLevel with the validated config value.
const bootstrapLevel = (() => {
  const raw = process.env.LOG_LEVEL;
  return raw && VALID_LEVELS.has(raw) ? raw : "info";
})();

export const log = pino({ level: bootstrapLevel });

export function setLogLevel(level: string): void {
  log.level = level;
}

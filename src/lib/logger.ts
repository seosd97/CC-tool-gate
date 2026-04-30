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

// Pretty-print decision is bootstrap-only. pino transports are fixed at
// instance construction, so we cannot flip this at runtime.
const bootstrapPretty = (() => {
  const explicit = process.env.LOG_PRETTY;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return Boolean(process.stdout.isTTY);
})();

const transport = bootstrapPretty
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    }
  : undefined;

export const log = pino({ level: bootstrapLevel, transport });

export function setLogLevel(level: string): void {
  log.level = level;
}

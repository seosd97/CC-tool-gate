import pino from "pino";

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

// Read pre-config so loadConfig errors honor LOG_LEVEL; setLogLevel below
// applies the validated value once loadConfig succeeds.
const bootstrapLevel = (() => {
  const raw = process.env.LOG_LEVEL;
  return raw && VALID_LEVELS.has(raw) ? raw : "info";
})();

// Bootstrap-only: pino transports are fixed at instance creation.
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

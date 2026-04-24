type Level = "info" | "warn" | "error";

function format(level: Level, msg: string, meta?: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => console.log(format("info", msg, meta)),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(format("warn", msg, meta)),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(format("error", msg, meta)),
};

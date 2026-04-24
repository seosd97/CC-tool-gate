import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRecord, AuditSink } from "@/core/gate";

export interface JsonlSinkOptions {
  logsDir: string;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface JsonlSinkHandle extends AuditSink {
  /** Path the next write will land in, based on the current date. */
  currentPath(): string;
}

/**
 * Daily-rotated JSONL audit sink. Each record is a line in
 * `${logsDir}/audit-YYYY-MM-DD.jsonl` (UTC). No gzip, no upload pipeline —
 * operator rotates/cleans via cron or logrotate.
 */
export function createJsonlSink(opts: JsonlSinkOptions): JsonlSinkHandle {
  const now = opts.now ?? (() => new Date());

  let ensured: Promise<void> | null = null;
  const ensureDir = (): Promise<void> => {
    if (!ensured) ensured = mkdir(opts.logsDir, { recursive: true }).then(() => {});
    return ensured;
  };

  const pathFor = (d: Date): string => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return join(opts.logsDir, `audit-${yyyy}-${mm}-${dd}.jsonl`);
  };

  // Serialize writes so concurrent appends don't interleave mid-line.
  let writeChain: Promise<unknown> = Promise.resolve();

  return {
    async write(record: AuditRecord) {
      const line = `${JSON.stringify(record)}\n`;
      writeChain = writeChain
        .then(async () => {
          await ensureDir();
          await appendFile(pathFor(now()), line);
        })
        .catch(() => {});
      await writeChain;
    },
    currentPath: () => pathFor(now()),
    async flush(): Promise<void> {
      await writeChain;
    },
  };
}

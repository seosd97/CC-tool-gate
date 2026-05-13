import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRecord, AuditSink } from "@/core/contracts";

export interface JsonlSinkOptions {
  logsDir: string;
  now?: () => Date;
}

export interface JsonlSinkHandle extends AuditSink {
  currentPath(): string;
}

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

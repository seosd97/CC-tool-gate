import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { AuditRecord, AuditSink } from "../core/types";

export interface JsonlSinkOptions {
  logsDir: string;
  /** Rotate when file exceeds this many bytes. */
  maxBytes?: number;
  /** Rotate when file age exceeds this many ms. */
  maxAgeMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

export interface JsonlSinkHandle extends AuditSink {
  /** Force rotation if there is anything to rotate. Returns the gz file path or null. */
  rotateNow(): Promise<string | null>;
  /** Returns the current open file path. */
  currentPath(): string;
  pendingDir(): string;
  uploadedDir(): string;
  deadLetterDir(): string;
}

export function createJsonlSink(opts: JsonlSinkOptions): JsonlSinkHandle {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxAgeMs = opts.maxAgeMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());

  const current = join(opts.logsDir, "current.jsonl");
  const pending = join(opts.logsDir, "pending");
  const uploaded = join(opts.logsDir, "uploaded");
  const deadLetter = join(opts.logsDir, "dead-letter");

  // Ensure dirs eagerly (non-blocking await chain via in-flight promise).
  let ensured: Promise<void> | null = null;
  const ensureDirs = (): Promise<void> => {
    if (!ensured) {
      ensured = (async () => {
        await mkdir(opts.logsDir, { recursive: true });
        await mkdir(pending, { recursive: true });
        await mkdir(uploaded, { recursive: true });
        await mkdir(deadLetter, { recursive: true });
      })();
    }
    return ensured;
  };

  let firstWriteAt: number | null = null;
  let writeChain: Promise<unknown> = Promise.resolve();

  const rotate = async (): Promise<string | null> => {
    await ensureDirs();
    let info;
    try {
      info = await stat(current);
    } catch {
      return null;
    }
    if (info.size === 0) return null;

    const ts = now();
    const rand = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
    const base = `${ts}-${rand}.jsonl`;
    const tmpPath = join(pending, base);
    await rename(current, tmpPath);
    firstWriteAt = null;

    // gzip in place
    const data = await Bun.file(tmpPath).arrayBuffer();
    const gz = gzipSync(new Uint8Array(data));
    const gzPath = `${tmpPath}.gz`;
    await Bun.write(gzPath, gz);
    await unlink(tmpPath);
    return gzPath;
  };

  const append = async (line: string): Promise<void> => {
    await ensureDirs();
    if (firstWriteAt == null) firstWriteAt = now();
    await appendFile(current, line);

    let size = 0;
    try {
      size = (await stat(current)).size;
    } catch {
      size = 0;
    }
    const aged = now() - (firstWriteAt ?? now()) >= maxAgeMs;
    if (size >= maxBytes || aged) {
      await rotate();
    }
  };

  /**
   * Rotate through the writeChain so we never race `append`'s internal
   * rotation. Without this, the external 60s timer in main.ts would call
   * rotate() while append() was also rotating — causing stat/rename to
   * ENOENT-throw and producing unhandled rejections.
   */
  const rotateChained = async (): Promise<string | null> => {
    let result: string | null = null;
    writeChain = writeChain
      .then(async () => {
        result = await rotate();
      })
      .catch(() => {});
    await writeChain;
    return result;
  };

  return {
    async write(record: AuditRecord) {
      const line = JSON.stringify(record) + "\n";
      writeChain = writeChain.then(() => append(line)).catch(() => {});
      await writeChain;
    },
    rotateNow: rotateChained,
    currentPath: () => current,
    pendingDir: () => pending,
    uploadedDir: () => uploaded,
    deadLetterDir: () => deadLetter,
  };
}

/** Helper used by the R2 worker. Returns *.gz files in pending/. */
export async function listPendingGz(pendingDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith(".jsonl.gz"))
    .map((n) => join(pendingDir, n))
    .sort();
}

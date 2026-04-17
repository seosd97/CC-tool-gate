import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StorageSink } from "../core/types";
import { listPendingGz } from "./jsonl";

export interface UploadWorkerOptions {
  sink: StorageSink;
  pendingDir: string;
  uploadedDir: string;
  /** Where to quarantine files that fail more than `maxAttempts` times. */
  deadLetterDir: string;
  hostname: string;
  /** Poll interval in ms. Default 30s. */
  intervalMs?: number;
  /** Delete uploaded files older than this. Default 7 days. */
  retainMs?: number;
  /** Move a file to dead-letter/ after this many failed upload attempts.
   * Default 5. Counts are in-memory and reset on process restart, so the
   * true ceiling is `maxAttempts * number_of_process_lifetimes`. */
  maxAttempts?: number;
  /** Called when a file is moved to dead-letter. Defaults to console.warn. */
  onDeadLetter?: (path: string, attempts: number) => void;
  now?: () => number;
}

export interface UploadWorker {
  start(): void;
  stop(): void;
  /** Run one upload+prune pass synchronously (used by tests). */
  tick(): Promise<{ uploaded: number; pruned: number; deadLettered: number }>;
}

/**
 * Rotated audit files are named `${ms}-${hex4}.jsonl.gz` (see jsonl.ts).
 * If we can parse the ms prefix we use that date, so files that sat in
 * pending/ across a day boundary (e.g. because R2 was down) still land in
 * the partition matching when the data was generated, not when we finally
 * uploaded it.
 */
const ROTATED_FILENAME_RE = /^(\d+)-[0-9a-f]+\.jsonl\.gz$/;

export function partitionDateFromFilename(filePath: string): Date | null {
  const m = ROTATED_FILENAME_RE.exec(basename(filePath));
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** Build the storage key for a rotated audit log file. Exposed for tests. */
export function uploadKey(hostname: string, filePath: string, fallback: Date): string {
  const d = partitionDateFromFilename(filePath) ?? fallback;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `decisions/dt=${yyyy}-${mm}-${dd}/host=${hostname}/${basename(filePath)}`;
}

export function createUploadWorker(opts: UploadWorkerOptions): UploadWorker {
  const interval = opts.intervalMs ?? 30_000;
  const retain = opts.retainMs ?? 7 * 24 * 3600 * 1000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const now = opts.now ?? (() => Date.now());
  const onDeadLetter =
    opts.onDeadLetter ??
    ((path, attempts) => {
      // eslint-disable-next-line no-console
      console.warn(
        `upload-worker: moving ${basename(path)} to dead-letter after ${attempts} failed attempts`,
      );
    });

  // Per-basename failure counter. In-memory on purpose — see maxAttempts
  // comment above. Cleared on success or DLQ move.
  const attempts = new Map<string, number>();

  const quarantine = async (path: string, count: number): Promise<void> => {
    await mkdir(opts.deadLetterDir, { recursive: true });
    const dest = join(opts.deadLetterDir, basename(path));
    await rename(path, dest);
    attempts.delete(basename(path));
    onDeadLetter(path, count);
  };

  /** Returns "uploaded" | "failed" | "dead-lettered" so tick can count. */
  const uploadOne = async (
    path: string,
  ): Promise<"uploaded" | "failed" | "dead-lettered"> => {
    const base = basename(path);
    const key = uploadKey(opts.hostname, path, new Date(now()));
    const ok = await opts.sink.upload(path, key, "application/gzip");
    if (ok) {
      const dest = join(opts.uploadedDir, base);
      await rename(path, dest);
      attempts.delete(base);
      return "uploaded";
    }
    const next = (attempts.get(base) ?? 0) + 1;
    if (next >= maxAttempts) {
      await quarantine(path, next);
      return "dead-lettered";
    }
    attempts.set(base, next);
    return "failed";
  };

  const prune = async (): Promise<number> => {
    let entries: string[];
    try {
      entries = await readdir(opts.uploadedDir);
    } catch {
      return 0;
    }
    let removed = 0;
    const cutoff = now() - retain;
    for (const name of entries) {
      const p = join(opts.uploadedDir, name);
      try {
        const info = await stat(p);
        if (info.mtimeMs < cutoff) {
          await unlink(p);
          removed++;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  };

  const tick = async (): Promise<{
    uploaded: number;
    pruned: number;
    deadLettered: number;
  }> => {
    const pending = await listPendingGz(opts.pendingDir);
    let uploaded = 0;
    let deadLettered = 0;
    for (const p of pending) {
      let outcome: "uploaded" | "failed" | "dead-lettered";
      try {
        outcome = await uploadOne(p);
      } catch {
        // A thrown error from the sink counts as a failure for attempt
        // tracking — same DLQ rules as a returned `false`.
        const base = basename(p);
        const next = (attempts.get(base) ?? 0) + 1;
        if (next >= maxAttempts) {
          await quarantine(p, next);
          outcome = "dead-lettered";
        } else {
          attempts.set(base, next);
          outcome = "failed";
        }
      }
      if (outcome === "uploaded") uploaded++;
      else if (outcome === "dead-lettered") deadLettered++;
    }
    const pruned = await prune();
    return { uploaded, pruned, deadLettered };
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, interval);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}

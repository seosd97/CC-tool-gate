import { readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StorageSink } from "../core/types";
import { listPendingGz } from "./jsonl";

export interface UploadWorkerOptions {
  sink: StorageSink;
  pendingDir: string;
  uploadedDir: string;
  hostname: string;
  /** Poll interval in ms. Default 30s. */
  intervalMs?: number;
  /** Delete uploaded files older than this. Default 7 days. */
  retainMs?: number;
  now?: () => number;
}

export interface UploadWorker {
  start(): void;
  stop(): void;
  /** Run one upload+prune pass synchronously (used by tests). */
  tick(): Promise<{ uploaded: number; pruned: number }>;
}

/**
 * Rotated audit files are named `${ms}-${hex4}.jsonl.gz` (see jsonl.ts).
 * If we can parse the ms prefix we use that date, so files that sat in
 * pending/ across a day boundary (e.g. because R2 was down) still land in
 * the partition matching when the data was generated, not when we finally
 * uploaded it.
 */
const ROTATED_FILENAME_RE = /^(\d+)-[0-9a-f]+\.jsonl\.gz$/;

// Epoch ms for 2001-01-01 — anything below this is obviously not a real
// rotation timestamp; treat it as "unparseable" and fall back.
const MIN_PLAUSIBLE_MS = 978307200000;

export function partitionDateFromFilename(filePath: string): Date | null {
  const m = ROTATED_FILENAME_RE.exec(basename(filePath));
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms) || ms < MIN_PLAUSIBLE_MS) return null;
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
  const now = opts.now ?? (() => Date.now());

  const uploadOne = async (path: string): Promise<boolean> => {
    const key = uploadKey(opts.hostname, path, new Date(now()));
    const ok = await opts.sink.upload(path, key, "application/gzip");
    if (!ok) {
      // Best-effort: leave file in pending/ for next pass.
      return false;
    }
    const dest = join(opts.uploadedDir, basename(path));
    await rename(path, dest);
    return true;
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

  const tick = async (): Promise<{ uploaded: number; pruned: number }> => {
    const pending = await listPendingGz(opts.pendingDir);
    let uploaded = 0;
    for (const p of pending) {
      const ok = await uploadOne(p).catch(() => false);
      if (ok) uploaded++;
    }
    const pruned = await prune();
    return { uploaded, pruned };
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

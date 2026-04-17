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

/** Build the storage key for a rotated audit log file. Exposed for tests. */
export function uploadKey(hostname: string, filePath: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
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

import { AwsClient } from "aws4fetch";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { listPendingGz } from "./jsonl";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  hostname: string;
  /** Inject fetch for tests. */
  fetchImpl?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
}

export interface R2WorkerOptions {
  pendingDir: string;
  uploadedDir: string;
  config: R2Config;
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Delete uploaded files older than this. */
  retainMs?: number;
  now?: () => number;
}

export interface R2Worker {
  start(): void;
  stop(): void;
  /** Run one upload pass synchronously (used by tests). */
  tick(): Promise<{ uploaded: number; pruned: number }>;
}

function r2Endpoint(cfg: R2Config): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
}

function r2Key(hostname: string, filePath: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `decisions/dt=${yyyy}-${mm}-${dd}/host=${hostname}/${basename(filePath)}`;
}

export function createR2Worker(opts: R2WorkerOptions): R2Worker {
  const interval = opts.intervalMs ?? 30_000;
  const retain = opts.retainMs ?? 7 * 24 * 3600 * 1000;
  const now = opts.now ?? (() => Date.now());

  const aws = new AwsClient({
    accessKeyId: opts.config.accessKeyId,
    secretAccessKey: opts.config.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const fetchImpl = opts.config.fetchImpl ?? fetch;
  const endpoint = r2Endpoint(opts.config);

  const uploadOne = async (path: string): Promise<boolean> => {
    const data = await Bun.file(path).arrayBuffer();
    const key = r2Key(opts.config.hostname, path, new Date(now()));
    const url = `${endpoint}/${key}`;
    const signed = await aws.sign(url, {
      method: "PUT",
      body: new Uint8Array(data),
      headers: { "content-type": "application/gzip" },
    });
    const res = await fetchImpl(signed);
    if (!res.ok) {
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

export { r2Key };

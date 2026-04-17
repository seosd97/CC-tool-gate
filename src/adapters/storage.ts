import type { AppConfig } from "../config";
import type { StorageSink } from "../core/types";
import { createR2Sink } from "./r2";
import { createS3Sink } from "./s3";

/**
 * Build a StorageSink from the parsed app config. Returns `null` when
 * STORAGE_BACKEND=none — callers treat that as "local-only audit logs".
 *
 * Required-field validation lives in `loadConfig`, so by the time we get
 * here the relevant fields for the chosen backend are guaranteed non-empty.
 */
export function createStorageSink(cfg: AppConfig): StorageSink | null {
  switch (cfg.STORAGE_BACKEND) {
    case "r2":
      return createR2Sink({
        endpoint: cfg.R2_ENDPOINT,
        bucket: cfg.R2_BUCKET,
        accessKeyId: cfg.R2_ACCESS_KEY_ID,
        secretAccessKey: cfg.R2_SECRET_ACCESS_KEY,
      });
    case "s3":
      return createS3Sink({
        region: cfg.S3_REGION,
        bucket: cfg.S3_BUCKET,
        accessKeyId: cfg.S3_ACCESS_KEY_ID,
        secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
        sessionToken: cfg.S3_SESSION_TOKEN || undefined,
        endpoint: cfg.S3_ENDPOINT || undefined,
      });
    case "none":
      return null;
  }
}

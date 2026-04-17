import { AwsClient } from "aws4fetch";
import type { StorageSink } from "../core/types";

export interface R2Config {
  /** Full URL like https://abc.r2.cloudflarestorage.com (no bucket, no trailing slash). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Inject fetch for tests. */
  fetchImpl?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
}

/** Build the path-style URL R2 uses. Exposed for tests. */
export function r2Url(cfg: Pick<R2Config, "endpoint" | "bucket">, key: string): string {
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  return `${endpoint}/${cfg.bucket}/${key}`;
}

export function createR2Sink(cfg: R2Config): StorageSink {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const fetchImpl = cfg.fetchImpl ?? fetch;

  return {
    async upload(localPath: string, key: string, contentType: string): Promise<boolean> {
      const data = await Bun.file(localPath).arrayBuffer();
      const url = r2Url(cfg, key);
      const signed = await aws.sign(url, {
        method: "PUT",
        body: new Uint8Array(data),
        headers: { "content-type": contentType },
      });
      const res = await fetchImpl(signed);
      return res.ok;
    },
  };
}

import { AwsClient } from "aws4fetch";
import type { StorageSink } from "../core/types";

export interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional, for AWS STS temporary credentials. */
  sessionToken?: string;
  /** Optional, for non-AWS S3 (LocalStack, MinIO, ...). */
  endpoint?: string;
  /** Inject fetch for tests. */
  fetchImpl?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Build the upload URL for S3.
 *
 * - With `endpoint`: path-style `${endpoint}/${bucket}/${key}` — for
 *   LocalStack, MinIO, or any S3-compatible service.
 * - Without `endpoint`: AWS virtual-hosted style
 *   `https://${bucket}.s3.${region}.amazonaws.com/${key}`.
 *
 * Exposed for tests.
 */
export function s3Url(
  cfg: Pick<S3Config, "endpoint" | "bucket" | "region">,
  key: string,
): string {
  if (cfg.endpoint) {
    const endpoint = cfg.endpoint.replace(/\/+$/, "");
    return `${endpoint}/${cfg.bucket}/${key}`;
  }
  return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`;
}

export function createS3Sink(cfg: S3Config): StorageSink {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    sessionToken: cfg.sessionToken,
    service: "s3",
    region: cfg.region,
  });
  const fetchImpl = cfg.fetchImpl ?? fetch;

  return {
    async upload(localPath: string, key: string, contentType: string): Promise<boolean> {
      const data = await Bun.file(localPath).arrayBuffer();
      const url = s3Url(cfg, key);
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

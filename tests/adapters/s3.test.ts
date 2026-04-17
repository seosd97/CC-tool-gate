import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createS3Sink, s3Url } from "../../src/adapters/s3";

describe("s3Url", () => {
  test("AWS virtual-hosted URL when no endpoint is set", () => {
    const url = s3Url({ bucket: "my-bucket", region: "us-east-1" }, "x/y/z.gz");
    expect(url).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/x/y/z.gz");
  });

  test("path-style URL when endpoint is set (LocalStack/MinIO)", () => {
    const url = s3Url(
      { bucket: "my-bucket", region: "us-east-1", endpoint: "http://localhost:4566" },
      "x/y/z.gz",
    );
    expect(url).toBe("http://localhost:4566/my-bucket/x/y/z.gz");
  });

  test("strips trailing slash from endpoint", () => {
    const url = s3Url(
      { bucket: "b", region: "us-east-1", endpoint: "http://localhost:4566/" },
      "k",
    );
    expect(url).toBe("http://localhost:4566/b/k");
  });
});

describe("createS3Sink", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-s3-sink-"));
    file = join(dir, "1.jsonl.gz");
    await writeFile(file, "fake-gz-bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("uses virtual-hosted host when no endpoint is set", async () => {
    const calls: { url: string }[] = [];
    const fakeFetch = async (input: Request | string | URL): Promise<Response> => {
      const req = input as Request;
      calls.push({ url: req.url });
      return new Response("", { status: 200 });
    };

    const sink = createS3Sink({
      region: "us-west-2",
      bucket: "my-bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetchImpl: fakeFetch,
    });

    const ok = await sink.upload(file, "decisions/dt=2026-04-17/host=h/1.jsonl.gz", "application/gzip");
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.host).toBe("my-bucket.s3.us-west-2.amazonaws.com");
    expect(u.pathname).toBe("/decisions/dt=2026-04-17/host=h/1.jsonl.gz");
  });

  test("uses path-style URL when endpoint is provided", async () => {
    const calls: { url: string }[] = [];
    const fakeFetch = async (input: Request | string | URL): Promise<Response> => {
      const req = input as Request;
      calls.push({ url: req.url });
      return new Response("", { status: 200 });
    };

    const sink = createS3Sink({
      region: "us-east-1",
      bucket: "my-bucket",
      accessKeyId: "id",
      secretAccessKey: "secret",
      endpoint: "http://localhost:4566",
      fetchImpl: fakeFetch,
    });

    const ok = await sink.upload(file, "k", "application/gzip");
    expect(ok).toBe(true);
    const u = new URL(calls[0]!.url);
    expect(u.host).toBe("localhost:4566");
    expect(u.pathname).toBe("/my-bucket/k");
  });

  test("includes session token header when sessionToken is set", async () => {
    let captured: Headers | null = null;
    const fakeFetch = async (input: Request | string | URL): Promise<Response> => {
      const req = input as Request;
      captured = req.headers;
      return new Response("", { status: 200 });
    };

    const sink = createS3Sink({
      region: "us-east-1",
      bucket: "b",
      accessKeyId: "id",
      secretAccessKey: "secret",
      sessionToken: "session-abc",
      fetchImpl: fakeFetch,
    });

    const ok = await sink.upload(file, "k", "application/gzip");
    expect(ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.get("x-amz-security-token")).toBe("session-abc");
  });

  test("does not set session token header when sessionToken is absent", async () => {
    let captured: Headers | null = null;
    const fakeFetch = async (input: Request | string | URL): Promise<Response> => {
      const req = input as Request;
      captured = req.headers;
      return new Response("", { status: 200 });
    };

    const sink = createS3Sink({
      region: "us-east-1",
      bucket: "b",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetchImpl: fakeFetch,
    });

    await sink.upload(file, "k", "application/gzip");
    expect(captured).not.toBeNull();
    expect(captured!.get("x-amz-security-token")).toBeNull();
  });

  test("returns false on non-2xx response", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("nope", { status: 503 });
    const sink = createS3Sink({
      region: "us-east-1",
      bucket: "b",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetchImpl: fakeFetch,
    });
    const ok = await sink.upload(file, "k", "application/gzip");
    expect(ok).toBe(false);
  });
});

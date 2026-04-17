import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createR2Sink, r2Url } from "../../src/adapters/r2";

describe("r2Url", () => {
  test("path-style URL with explicit endpoint", () => {
    const url = r2Url(
      { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "bk" },
      "decisions/dt=2026-04-17/host=h/1.jsonl.gz",
    );
    expect(url).toBe(
      "https://acct.r2.cloudflarestorage.com/bk/decisions/dt=2026-04-17/host=h/1.jsonl.gz",
    );
  });

  test("strips trailing slash from endpoint", () => {
    const url = r2Url(
      { endpoint: "https://acct.r2.cloudflarestorage.com/", bucket: "bk" },
      "k",
    );
    expect(url).toBe("https://acct.r2.cloudflarestorage.com/bk/k");
  });
});

describe("createR2Sink", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-r2-sink-"));
    file = join(dir, "1.jsonl.gz");
    await writeFile(file, "fake-gz-bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("signs and PUTs to the path-style R2 URL on success", async () => {
    const calls: { url: string; method: string }[] = [];
    const fakeFetch = async (input: Request | string | URL): Promise<Response> => {
      const req = input as Request;
      calls.push({ url: req.url, method: req.method });
      return new Response("", { status: 200 });
    };

    const sink = createR2Sink({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "bk",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetchImpl: fakeFetch,
    });

    const ok = await sink.upload(file, "decisions/dt=2026-04-17/host=h/1.jsonl.gz", "application/gzip");
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      "https://acct.r2.cloudflarestorage.com/bk/decisions/dt=2026-04-17/host=h/1.jsonl.gz",
    );
  });

  test("returns false on non-2xx response", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("nope", { status: 500 });
    const sink = createR2Sink({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "bk",
      accessKeyId: "id",
      secretAccessKey: "secret",
      fetchImpl: fakeFetch,
    });
    const ok = await sink.upload(file, "k", "application/gzip");
    expect(ok).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createR2Worker, r2Key } from "../../src/adapters/r2";

describe("r2Key", () => {
  test("uses UTC date and basename", () => {
    const key = r2Key("host1", "/x/y/12345-abcd.jsonl.gz", new Date("2026-04-17T03:00:00Z"));
    expect(key).toBe("decisions/dt=2026-04-17/host=host1/12345-abcd.jsonl.gz");
  });
});

describe("R2 worker", () => {
  let dir: string;
  let pending: string;
  let uploaded: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-r2-"));
    pending = join(dir, "pending");
    uploaded = join(dir, "uploaded");
    await mkdir(pending, { recursive: true });
    await mkdir(uploaded, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("uploads pending files and moves them to uploaded/", async () => {
    await writeFile(join(pending, "1.jsonl.gz"), "fake-gz-bytes");
    await writeFile(join(pending, "2.jsonl.gz"), "more");
    const calls: string[] = [];
    const fakeFetch =async (input: any) => {
      calls.push(typeof input === "string" ? input : input.url);
      return new Response("", { status: 200 });
    };

    const worker = createR2Worker({
      pendingDir: pending,
      uploadedDir: uploaded,
      config: {
        accountId: "acct",
        accessKeyId: "id",
        secretAccessKey: "secret",
        bucket: "bk",
        hostname: "host1",
        fetchImpl: fakeFetch,
      },
    });

    const result = await worker.tick();
    expect(result.uploaded).toBe(2);
    const remaining = await readdir(pending);
    expect(remaining).toHaveLength(0);
    const moved = await readdir(uploaded);
    expect(moved.sort()).toEqual(["1.jsonl.gz", "2.jsonl.gz"]);
    expect(calls.every((u) => u.startsWith("https://acct.r2.cloudflarestorage.com/bk/"))).toBe(true);
  });

  test("leaves files in pending on non-2xx response", async () => {
    await writeFile(join(pending, "1.jsonl.gz"), "x");
    const fakeFetch =async () => new Response("nope", { status: 500 });
    const worker = createR2Worker({
      pendingDir: pending,
      uploadedDir: uploaded,
      config: {
        accountId: "a",
        accessKeyId: "i",
        secretAccessKey: "s",
        bucket: "b",
        hostname: "h",
        fetchImpl: fakeFetch,
      },
    });
    const result = await worker.tick();
    expect(result.uploaded).toBe(0);
    const remaining = await readdir(pending);
    expect(remaining).toEqual(["1.jsonl.gz"]);
  });

  test("prunes uploaded files older than retainMs", async () => {
    const oldFile = join(uploaded, "old.jsonl.gz");
    await writeFile(oldFile, "old");
    const ancient = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await utimes(oldFile, ancient, ancient);
    await writeFile(join(uploaded, "fresh.jsonl.gz"), "new");

    const worker = createR2Worker({
      pendingDir: pending,
      uploadedDir: uploaded,
      config: {
        accountId: "a",
        accessKeyId: "i",
        secretAccessKey: "s",
        bucket: "b",
        hostname: "h",
        fetchImpl: async () => new Response("", { status: 200 }),
      },
      retainMs: 7 * 24 * 3600 * 1000,
    });
    const result = await worker.tick();
    expect(result.pruned).toBe(1);
    const left = (await readdir(uploaded)).sort();
    expect(left).toEqual(["fresh.jsonl.gz"]);
  });
});

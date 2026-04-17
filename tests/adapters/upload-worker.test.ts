import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUploadWorker,
  partitionDateFromFilename,
  uploadKey,
} from "../../src/adapters/upload-worker";
import type { StorageSink } from "../../src/core/types";

interface FakeSink extends StorageSink {
  uploads: { localPath: string; key: string; contentType: string }[];
}

function createFakeSink(opts: { failAll?: boolean } = {}): FakeSink {
  const uploads: FakeSink["uploads"] = [];
  return {
    uploads,
    async upload(localPath, key, contentType) {
      uploads.push({ localPath, key, contentType });
      return !opts.failAll;
    },
  };
}

describe("partitionDateFromFilename", () => {
  test("parses ms prefix from rotated filename", () => {
    const d = partitionDateFromFilename(
      "/x/y/1776412800000-abcd.jsonl.gz",
    );
    expect(d?.toISOString()).toBe("2026-04-17T08:00:00.000Z");
  });

  test("returns null for non-rotated filenames", () => {
    expect(partitionDateFromFilename("/x/y/hello.jsonl.gz")).toBeNull();
    expect(partitionDateFromFilename("/x/y/current.jsonl")).toBeNull();
  });

  test("rejects implausibly small ms (pre-2001)", () => {
    // `12345` would map to 1970-01-01 — definitely not a real rotation ts.
    expect(partitionDateFromFilename("/x/y/12345-abcd.jsonl.gz")).toBeNull();
  });
});

describe("uploadKey", () => {
  test("derives date from filename ms prefix, not current time", () => {
    const key = uploadKey(
      "host1",
      "/x/y/1776412800000-abcd.jsonl.gz",
      new Date("2099-01-01T00:00:00Z"),
    );
    // Date must come from the filename (2026-04-17), not the fallback.
    expect(key).toBe(
      "decisions/dt=2026-04-17/host=host1/1776412800000-abcd.jsonl.gz",
    );
  });

  test("falls back to supplied date when filename is unparseable", () => {
    const key = uploadKey(
      "host1",
      "/x/y/hand-dropped.jsonl.gz",
      new Date("2026-04-17T03:00:00Z"),
    );
    expect(key).toBe(
      "decisions/dt=2026-04-17/host=host1/hand-dropped.jsonl.gz",
    );
  });
});

describe("upload worker", () => {
  let dir: string;
  let pending: string;
  let uploaded: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-uw-"));
    pending = join(dir, "pending");
    uploaded = join(dir, "uploaded");
    await mkdir(pending, { recursive: true });
    await mkdir(uploaded, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("uploads pending files via the sink and moves them to uploaded/", async () => {
    await writeFile(join(pending, "1.jsonl.gz"), "fake-gz-bytes");
    await writeFile(join(pending, "2.jsonl.gz"), "more");
    const sink = createFakeSink();

    const worker = createUploadWorker({
      sink,
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "host1",
      now: () => new Date("2026-04-17T03:00:00Z").getTime(),
    });

    const result = await worker.tick();
    expect(result.uploaded).toBe(2);
    expect(result.pruned).toBe(0);

    const remaining = await readdir(pending);
    expect(remaining).toHaveLength(0);
    const moved = (await readdir(uploaded)).sort();
    expect(moved).toEqual(["1.jsonl.gz", "2.jsonl.gz"]);

    expect(sink.uploads).toHaveLength(2);
    expect(sink.uploads.every((u) => u.contentType === "application/gzip")).toBe(true);
    expect(sink.uploads.map((u) => u.key).sort()).toEqual([
      "decisions/dt=2026-04-17/host=host1/1.jsonl.gz",
      "decisions/dt=2026-04-17/host=host1/2.jsonl.gz",
    ]);
  });

  test("partitions by filename date even when upload runs on a later day", async () => {
    // The file was rotated on 2026-04-15 but sat in pending/ (e.g. R2 was
    // down) and only uploads now, two days later. It should still land in
    // the dt=2026-04-15 partition to match when the data was actually
    // generated.
    const rotatedMs = new Date("2026-04-15T23:59:00Z").getTime();
    const filename = `${rotatedMs}-beef.jsonl.gz`;
    await writeFile(join(pending, filename), "fake-gz-bytes");
    const sink = createFakeSink();

    const worker = createUploadWorker({
      sink,
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "host1",
      now: () => new Date("2026-04-17T05:00:00Z").getTime(),
    });

    const result = await worker.tick();
    expect(result.uploaded).toBe(1);
    expect(sink.uploads[0]!.key).toBe(
      `decisions/dt=2026-04-15/host=host1/${filename}`,
    );
  });

  test("leaves files in pending when the sink reports failure", async () => {
    await writeFile(join(pending, "1.jsonl.gz"), "x");
    const sink = createFakeSink({ failAll: true });

    const worker = createUploadWorker({
      sink,
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "h",
    });

    const result = await worker.tick();
    expect(result.uploaded).toBe(0);
    const remaining = await readdir(pending);
    expect(remaining).toEqual(["1.jsonl.gz"]);
    expect(sink.uploads).toHaveLength(1);
  });

  test("treats sink throw as a failure and keeps the file in pending", async () => {
    await writeFile(join(pending, "1.jsonl.gz"), "x");
    const sink: StorageSink = {
      async upload() {
        throw new Error("network bork");
      },
    };

    const worker = createUploadWorker({
      sink,
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "h",
    });

    const result = await worker.tick();
    expect(result.uploaded).toBe(0);
    expect(await readdir(pending)).toEqual(["1.jsonl.gz"]);
  });

  test("prunes uploaded files older than retainMs", async () => {
    const oldFile = join(uploaded, "old.jsonl.gz");
    await writeFile(oldFile, "old");
    const ancient = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await utimes(oldFile, ancient, ancient);
    await writeFile(join(uploaded, "fresh.jsonl.gz"), "new");

    const worker = createUploadWorker({
      sink: createFakeSink(),
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "h",
      retainMs: 7 * 24 * 3600 * 1000,
    });

    const result = await worker.tick();
    expect(result.pruned).toBe(1);
    const left = (await readdir(uploaded)).sort();
    expect(left).toEqual(["fresh.jsonl.gz"]);
  });

  test("tick returns counts for both upload and prune in one pass", async () => {
    await writeFile(join(pending, "a.jsonl.gz"), "a");
    await writeFile(join(pending, "b.jsonl.gz"), "b");
    const oldFile = join(uploaded, "old.jsonl.gz");
    await writeFile(oldFile, "old");
    const ancient = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await utimes(oldFile, ancient, ancient);

    const worker = createUploadWorker({
      sink: createFakeSink(),
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "h",
      retainMs: 7 * 24 * 3600 * 1000,
    });

    const result = await worker.tick();
    expect(result).toEqual({ uploaded: 2, pruned: 1 });
  });

  test("ignores non-.jsonl.gz files in pending", async () => {
    await writeFile(join(pending, "good.jsonl.gz"), "g");
    await writeFile(join(pending, "ignored.txt"), "x");
    const sink = createFakeSink();

    const worker = createUploadWorker({
      sink,
      pendingDir: pending,
      uploadedDir: uploaded,
      hostname: "h",
    });

    const result = await worker.tick();
    expect(result.uploaded).toBe(1);
    expect(sink.uploads.map((u) => u.localPath.endsWith("good.jsonl.gz"))).toEqual([true]);
    expect((await readdir(pending)).sort()).toEqual(["ignored.txt"]);
  });
});

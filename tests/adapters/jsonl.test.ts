import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSink, listPendingGz } from "../../src/adapters/jsonl";
import type { AuditRecord } from "../../src/core/types";

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  ts: new Date(0).toISOString(),
  session_id: "s",
  cwd: "/c",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  decision: "allow",
  reason: "ok",
  source: "llm",
  matched_policies: [],
  cache_hit: false,
  latency_ms: 1,
  ...over,
});

describe("jsonl sink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-jsonl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("appends JSONL lines", async () => {
    const sink = createJsonlSink({ logsDir: dir, maxBytes: 1_000_000, maxAgeMs: 60_000 });
    await sink.write(rec());
    await sink.write(rec({ tool_name: "Read" }));
    const text = await readFile(join(dir, "current.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tool_name).toBe("Bash");
    expect(JSON.parse(lines[1]!).tool_name).toBe("Read");
  });

  test("rotates by size and gzips into pending/", async () => {
    const sink = createJsonlSink({ logsDir: dir, maxBytes: 50, maxAgeMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      await sink.write(rec({ session_id: `s${i}` }));
    }
    const pending = await listPendingGz(sink.pendingDir());
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const decoded = gunzipSync(new Uint8Array(await Bun.file(pending[0]!).arrayBuffer())).toString();
    expect(decoded).toContain('"session_id":"s0"');
  });

  test("rotateNow returns null when current is empty", async () => {
    const sink = createJsonlSink({ logsDir: dir });
    const out = await sink.rotateNow();
    expect(out).toBeNull();
  });

  test("rotates by age", async () => {
    let t = 1000;
    const sink = createJsonlSink({
      logsDir: dir,
      maxBytes: 1_000_000,
      maxAgeMs: 100,
      now: () => t,
    });
    await sink.write(rec());
    t += 200;
    await sink.write(rec()); // triggers age-based rotation
    const pending = await listPendingGz(sink.pendingDir());
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });
});

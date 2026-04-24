import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSink } from "@/adapters/audit-log";
import type { AuditRecord } from "@/core/gate";

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

  test("appends JSONL lines to today's file", async () => {
    const sink = createJsonlSink({
      logsDir: dir,
      now: () => new Date(Date.UTC(2026, 3, 22, 10, 0, 0)),
    });
    await sink.write(rec());
    await sink.write(rec({ tool_name: "Read" }));
    const text = await readFile(join(dir, "audit-2026-04-22.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tool_name).toBe("Bash");
    expect(JSON.parse(lines[1]!).tool_name).toBe("Read");
  });

  test("rotates by UTC date", async () => {
    let d = new Date(Date.UTC(2026, 3, 22, 23, 59, 0));
    const sink = createJsonlSink({ logsDir: dir, now: () => d });
    await sink.write(rec({ session_id: "a" }));
    d = new Date(Date.UTC(2026, 3, 23, 0, 1, 0));
    await sink.write(rec({ session_id: "b" }));

    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(["audit-2026-04-22.jsonl", "audit-2026-04-23.jsonl"]);

    const day1 = await readFile(join(dir, "audit-2026-04-22.jsonl"), "utf8");
    const day2 = await readFile(join(dir, "audit-2026-04-23.jsonl"), "utf8");
    expect(day1).toContain('"session_id":"a"');
    expect(day2).toContain('"session_id":"b"');
  });

  test("concurrent writes serialize without losing or interleaving lines", async () => {
    const sink = createJsonlSink({
      logsDir: dir,
      now: () => new Date(Date.UTC(2026, 3, 22)),
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => sink.write(rec({ session_id: `s${i}` }))),
    );
    const text = await readFile(join(dir, "audit-2026-04-22.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(40);
    const seen = new Set(lines.map((l) => JSON.parse(l).session_id));
    for (let i = 0; i < 40; i++) expect(seen.has(`s${i}`)).toBe(true);
  });

  test("currentPath reflects the logging clock", () => {
    const sink = createJsonlSink({
      logsDir: dir,
      now: () => new Date(Date.UTC(2026, 0, 1)),
    });
    expect(sink.currentPath()).toBe(join(dir, "audit-2026-01-01.jsonl"));
  });
});

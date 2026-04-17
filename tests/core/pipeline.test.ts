import { beforeEach, describe, expect, test } from "bun:test";
import { createPipeline, makeCacheKey } from "../../src/core/pipeline";
import type {
  AuditRecord,
  AuditSink,
  DecisionCache,
  DecisionResult,
  IndexConfig,
  LlmJudge,
  Policy,
  PreToolUseRequest,
} from "../../src/core/types";

function fakeCache(): DecisionCache & { _store: Map<string, DecisionResult> } {
  const store = new Map<string, DecisionResult>();
  return {
    _store: store,
    get: (k) => store.get(k),
    set: (k, v) => void store.set(k, v),
    clear: () => store.clear(),
    size: () => store.size,
  };
}

function fakeSink(): AuditSink & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    write: async (r) => {
      records.push(r);
    },
  };
}

function fakeLlm(impl: LlmJudge["judge"]): LlmJudge {
  return { judge: impl };
}

const baseIndex: IndexConfig = {
  hard_deny: { tool_names: [], patterns: [] },
  hard_allow: { tool_names: [], patterns: [] },
};

const policy = (over: Partial<Policy> = {}): Policy => ({
  name: "default",
  description: "",
  triggers: { tool_names: ["Bash"], patterns: [".*"] },
  default_decision: "ask",
  body: "body",
  source: "x",
  ...over,
});

const req = (over: Partial<PreToolUseRequest> = {}): PreToolUseRequest => ({
  session_id: "s",
  cwd: "/c",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo hi" },
  ...over,
});

describe("makeCacheKey", () => {
  test("is stable across key order", () => {
    const a = makeCacheKey(req({ tool_input: { a: 1, b: { x: 1, y: 2 } } }));
    const b = makeCacheKey(req({ tool_input: { b: { y: 2, x: 1 }, a: 1 } }));
    expect(a).toBe(b);
  });
});

describe("pipeline", () => {
  let cache: ReturnType<typeof fakeCache>;
  let sink: ReturnType<typeof fakeSink>;

  beforeEach(() => {
    cache = fakeCache();
    sink = fakeSink();
  });

  test("hard_deny short-circuits", async () => {
    const p = createPipeline({
      llm: fakeLlm(async () => ({ decision: "allow", reason: "no" })),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy()],
        index: { ...baseIndex, hard_deny: { tool_names: [], patterns: ["rm -rf"] } },
      }),
    });
    const r = await p.decide(req({ tool_input: { command: "rm -rf /" } }));
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("hard_deny");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.cache_hit).toBe(false);
  });

  test("hard_allow short-circuits", async () => {
    const p = createPipeline({
      llm: fakeLlm(async () => {
        throw new Error("should not be called");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy()],
        index: { ...baseIndex, hard_allow: { tool_names: ["Read"], patterns: [] } },
      }),
    });
    const r = await p.decide(req({ tool_name: "Read", tool_input: { file_path: "ok.txt" } }));
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("hard_allow");
  });

  test("calls LLM when policy matches and caches result", async () => {
    let calls = 0;
    const p = createPipeline({
      llm: fakeLlm(async () => {
        calls++;
        return { decision: "deny", reason: "blocked by llm" };
      }),
      cache,
      sink,
      getSnapshot: () => ({ policies: [policy()], index: baseIndex }),
    });

    const r1 = await p.decide(req());
    expect(r1.decision).toBe("deny");
    expect(r1.source).toBe("llm");

    const r2 = await p.decide(req());
    expect(r2.source).toBe("cache");
    expect(r2.decision).toBe("deny");
    expect(calls).toBe(1);
    expect(sink.records).toHaveLength(2);
    expect(sink.records[1]!.cache_hit).toBe(true);
  });

  test("falls back to policy default_decision when LLM throws", async () => {
    const p = createPipeline({
      llm: fakeLlm(async () => {
        throw new Error("boom");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy({ default_decision: "deny" })],
        index: baseIndex,
      }),
    });
    const r = await p.decide(req());
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("fallback");
    expect(r.reason).toContain("boom");
  });

  test("no matching policy returns allow with note", async () => {
    const p = createPipeline({
      llm: fakeLlm(async () => {
        throw new Error("nope");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy({ triggers: { tool_names: ["Edit"], patterns: [] } })],
        index: baseIndex,
      }),
    });
    const r = await p.decide(req({ tool_name: "Bash" }));
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("fallback");
    expect(r.matched_policies).toEqual([]);
  });

  test("audit records contain latency and timestamp", async () => {
    const p = createPipeline({
      llm: fakeLlm(async () => ({ decision: "ask", reason: "uncertain" })),
      cache,
      sink,
      getSnapshot: () => ({ policies: [policy()], index: baseIndex }),
      now: () => new Date("2026-04-17T00:00:00Z"),
    });
    await p.decide(req());
    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0]!;
    expect(rec.ts).toBe("2026-04-17T00:00:00.000Z");
    expect(rec.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rec.matched_policies).toEqual(["default"]);
  });
});

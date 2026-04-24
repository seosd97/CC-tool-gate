import { beforeEach, describe, expect, test } from "bun:test";
import type { AuditRecord, AuditSink, DecisionCache, DecisionResult, LlmJudge } from "@/core/gate";
import { createGate, makeCacheKey } from "@/core/gate";
import type { CompiledStaticRules, Policy, PreToolUseRequest } from "@/core/policy";

function fakeCache(): DecisionCache {
  const store = new Map<string, DecisionResult>();
  return {
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

const emptyRules: CompiledStaticRules = {
  deny: { tool_names: [], patterns: [] },
  allow: { tool_names: [], patterns: [] },
};

const policy = (over: Partial<Policy> = {}): Policy => ({
  name: "default",
  description: "",
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
  test("identical tool_input produces identical keys", () => {
    const a = makeCacheKey(req({ tool_input: { a: 1, b: 2 } }));
    const b = makeCacheKey(req({ tool_input: { a: 1, b: 2 } }));
    expect(a).toBe(b);
  });

  test("different tool_input produces different keys", () => {
    const a = makeCacheKey(req({ tool_input: { command: "ls" } }));
    const b = makeCacheKey(req({ tool_input: { command: "pwd" } }));
    expect(a).not.toBe(b);
  });
});

describe("gate", () => {
  let cache: ReturnType<typeof fakeCache>;
  let sink: ReturnType<typeof fakeSink>;

  beforeEach(() => {
    cache = fakeCache();
    sink = fakeSink();
  });

  test("static deny by pattern short-circuits", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => ({ decision: "allow", reason: "no" })),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy()],
        rules: { ...emptyRules, deny: { tool_names: [], patterns: [/rm -rf/i] } },
      }),
    });
    const r = await gate.decide(req({ tool_input: { command: "rm -rf /" } }));
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("static_deny");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.cache_hit).toBe(false);
  });

  test("static deny by tool_name short-circuits", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => ({ decision: "allow", reason: "no" })),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy()],
        rules: { ...emptyRules, deny: { tool_names: ["BashWebSearch"], patterns: [] } },
      }),
    });
    const r = await gate.decide(req({ tool_name: "BashWebSearch" }));
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("static_deny");
  });

  test("static allow by tool_name short-circuits", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => {
        throw new Error("should not be called");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy()],
        rules: { ...emptyRules, allow: { tool_names: ["Read"], patterns: [] } },
      }),
    });
    const r = await gate.decide(req({ tool_name: "Read", tool_input: { file_path: "ok.txt" } }));
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("static_allow");
  });

  test("static allow by pattern short-circuits", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => {
        throw new Error("should not be called");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy()],
        rules: { ...emptyRules, allow: { tool_names: [], patterns: [/^echo /i] } },
      }),
    });
    const r = await gate.decide(req({ tool_input: { command: "echo hello" } }));
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("static_allow");
  });

  test("calls LLM with all policies and caches result", async () => {
    let calls = 0;
    const gate = createGate({
      llm: fakeLlm(async () => {
        calls++;
        return { decision: "deny", reason: "blocked by llm" };
      }),
      cache,
      sink,
      getSnapshot: () => ({ policies: [policy()], rules: emptyRules }),
    });

    const r1 = await gate.decide(req());
    expect(r1.decision).toBe("deny");
    expect(r1.source).toBe("llm");

    const r2 = await gate.decide(req());
    expect(r2.source).toBe("cache");
    expect(r2.decision).toBe("deny");
    expect(calls).toBe(1);
    expect(sink.records).toHaveLength(2);
    expect(sink.records[1]?.cache_hit).toBe(true);
  });

  test("falls back to policy default_decision when LLM throws", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => {
        throw new Error("boom");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy({ default_decision: "deny" })],
        rules: emptyRules,
      }),
    });
    const r = await gate.decide(req());
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("fallback");
    expect(r.reason).toContain("boom");
  });

  test("no policies loaded returns allow with note", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => {
        throw new Error("nope");
      }),
      cache,
      sink,
      getSnapshot: () => ({ policies: [], rules: emptyRules }),
    });
    const r = await gate.decide(req());
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("fallback");
    expect(r.matched_policies).toEqual([]);
  });

  test("audit records contain latency and timestamp", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => ({ decision: "ask", reason: "uncertain" })),
      cache,
      sink,
      getSnapshot: () => ({ policies: [policy()], rules: emptyRules }),
      now: () => new Date("2026-04-17T00:00:00Z"),
    });
    await gate.decide(req());
    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0]!;
    expect(rec.ts).toBe("2026-04-17T00:00:00.000Z");
    expect(rec.latency_ms).toBeGreaterThanOrEqual(0);
    expect(rec.matched_policies).toEqual(["default"]);
  });

  test("audit records redact secrets in tool_input and reason", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => ({
        decision: "deny",
        reason: "refused call to Authorization: Bearer sk_live_leaked",
      })),
      cache,
      sink,
      getSnapshot: () => ({ policies: [policy()], rules: emptyRules }),
    });
    await gate.decide(
      req({
        tool_input: {
          command: "curl -H 'Authorization: Bearer tok.secret.xyz' https://x",
        },
      }),
    );
    const rec = sink.records[0]!;
    const cmd = (rec.tool_input as { command: string }).command;
    expect(cmd).toContain("Authorization: Bearer [REDACTED]");
    expect(cmd).not.toContain("tok.secret.xyz");
    expect(rec.reason).toContain("Authorization: Bearer [REDACTED]");
    expect(rec.reason).not.toContain("sk_live_leaked");
  });

  test("sends all policies to LLM and returns all names", async () => {
    let receivedPolicies: Policy[] = [];
    const gate = createGate({
      llm: fakeLlm(async ({ policies }) => {
        receivedPolicies = policies;
        return { decision: "deny", reason: "blocked" };
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [
          policy({ name: "env-protect", body: "guard .env" }),
          policy({ name: "secrets-guard", body: "guard secrets" }),
          policy({ name: "network-rule", body: "guard network" }),
        ],
        rules: emptyRules,
      }),
    });
    const r = await gate.decide(req());
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("llm");
    expect(r.matched_policies).toEqual(["env-protect", "secrets-guard", "network-rule"]);
    expect(receivedPolicies).toHaveLength(3);
    expect(receivedPolicies.map((p) => p.name)).toEqual([
      "env-protect",
      "secrets-guard",
      "network-rule",
    ]);
  });

  test("fallback uses first policy default_decision with multiple policies", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => {
        throw new Error("timeout");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [
          policy({ name: "strict", default_decision: "deny" }),
          policy({ name: "lenient", default_decision: "allow" }),
        ],
        rules: emptyRules,
      }),
    });
    const r = await gate.decide(req());
    expect(r.decision).toBe("deny");
    expect(r.source).toBe("fallback");
    expect(r.matched_policies).toEqual(["strict", "lenient"]);
  });

  test("fallback defaults to ask when no default_decision set", async () => {
    const gate = createGate({
      llm: fakeLlm(async () => {
        throw new Error("fail");
      }),
      cache,
      sink,
      getSnapshot: () => ({
        policies: [policy({ name: "no-default" })],
        rules: emptyRules,
      }),
    });
    const r = await gate.decide(req());
    expect(r.decision).toBe("ask");
    expect(r.source).toBe("fallback");
  });
});

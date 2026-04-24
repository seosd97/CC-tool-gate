import type { PermissionDecision, Policy, PreToolUseRequest, StaticRules } from "@/core/policy";
import { redact, redactString } from "@/core/redact";

export interface DecisionResult {
  decision: PermissionDecision;
  reason: string;
  source: "static_deny" | "static_allow" | "cache" | "llm" | "fallback";
  matched_policies: string[];
}

export interface AuditRecord {
  ts: string;
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  decision: PermissionDecision;
  reason: string;
  source: DecisionResult["source"];
  matched_policies: string[];
  cache_hit: boolean;
  latency_ms: number;
}

export interface DecisionCache {
  get(key: string): DecisionResult | undefined;
  set(key: string, value: DecisionResult): void;
  clear(): void;
  size(): number;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
  flush?(): Promise<void>;
}

export interface LlmJudge {
  judge(input: { request: PreToolUseRequest; policies: Policy[] }): Promise<{
    decision: PermissionDecision;
    reason: string;
  }>;
}

export interface GateDeps {
  llm: LlmJudge;
  cache: DecisionCache;
  sink: AuditSink;
  getSnapshot: () => { policies: Policy[]; rules: StaticRules };
  now?: () => Date;
}

export function makeCacheKey(req: PreToolUseRequest): string {
  return `${req.tool_name}|${JSON.stringify(req.tool_input)}`;
}

function flattenToolInput(toolInput: Record<string, unknown>): string {
  const parts: string[] = [];
  const visit = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x);
    }
  };
  visit(toolInput);
  return parts.join("\n");
}

function checkStaticRules(req: PreToolUseRequest, rules: StaticRules): DecisionResult | null {
  const haystack = flattenToolInput(req.tool_input);

  if (
    rules.deny.tool_names.includes(req.tool_name) ||
    rules.deny.patterns.some((p) => new RegExp(p, "i").test(haystack))
  ) {
    return {
      decision: "deny",
      reason: "Matched static deny rule",
      source: "static_deny",
      matched_policies: [],
    };
  }

  if (
    rules.allow.tool_names.includes(req.tool_name) ||
    rules.allow.patterns.some((p) => new RegExp(p, "i").test(haystack))
  ) {
    return {
      decision: "allow",
      reason: "Matched static allow rule",
      source: "static_allow",
      matched_policies: [],
    };
  }
  return null;
}

export function createGate(deps: GateDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async decide(req: PreToolUseRequest): Promise<DecisionResult> {
      const t0 = performance.now();
      const { policies, rules } = deps.getSnapshot();

      const staticResult = checkStaticRules(req, rules);
      if (staticResult) {
        await writeAudit(deps.sink, req, staticResult, false, t0, now);
        return staticResult;
      }

      const key = makeCacheKey(req);
      const cached = deps.cache.get(key);
      if (cached) {
        const result: DecisionResult = { ...cached, source: "cache" };
        await writeAudit(deps.sink, req, result, true, t0, now);
        return result;
      }

      if (policies.length === 0) {
        const result: DecisionResult = {
          decision: "allow",
          reason: "No policies loaded; defaulting to allow",
          source: "fallback",
          matched_policies: [],
        };
        await writeAudit(deps.sink, req, result, false, t0, now);
        return result;
      }

      let result: DecisionResult;
      try {
        const llmResult = await deps.llm.judge({ request: req, policies });
        result = {
          decision: llmResult.decision,
          reason: llmResult.reason,
          source: "llm",
          matched_policies: policies.map((p) => p.name),
        };
        deps.cache.set(key, result);
      } catch (err) {
        const fallback = policies[0]?.default_decision ?? "ask";
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          decision: fallback,
          reason: `LLM call failed (${msg}); using policy default_decision`,
          source: "fallback",
          matched_policies: policies.map((p) => p.name),
        };
      }

      await writeAudit(deps.sink, req, result, false, t0, now);
      return result;
    },
  };
}

async function writeAudit(
  sink: AuditSink,
  req: PreToolUseRequest,
  result: DecisionResult,
  cacheHit: boolean,
  t0: number,
  now: () => Date,
): Promise<void> {
  const record: AuditRecord = {
    ts: now().toISOString(),
    session_id: req.session_id,
    cwd: req.cwd,
    tool_name: req.tool_name,
    tool_input: redact(req.tool_input),
    decision: result.decision,
    reason: redactString(result.reason),
    source: result.source,
    matched_policies: result.matched_policies,
    cache_hit: cacheHit,
    latency_ms: Math.round(performance.now() - t0),
  };
  try {
    await sink.write(record);
  } catch {
    // Audit failure must not affect decisions.
  }
}

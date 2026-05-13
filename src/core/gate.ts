import type {
  AuditRecord,
  AuditSink,
  DecisionCache,
  DecisionResult,
  LlmJudge,
} from "@/core/contracts";
import type { CompiledStaticRules, PolicySnapshot, PreToolUseRequest } from "@/core/policy";
import { getErrorMessage } from "@/lib/errors";
import { redact, redactString } from "@/lib/redact";

export interface GateDeps {
  llm: LlmJudge;
  cache: DecisionCache;
  sink: AuditSink;
  getSnapshot: () => PolicySnapshot;
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

function checkStaticRules(
  req: PreToolUseRequest,
  rules: CompiledStaticRules,
): DecisionResult | null {
  const haystack = flattenToolInput(req.tool_input);

  if (
    rules.deny.tool_names.includes(req.tool_name) ||
    rules.deny.patterns.some((rx) => rx.test(haystack))
  ) {
    return {
      decision: "deny",
      reason: "Matched static deny rule",
      source: "static_deny",
      matchedPolicies: [],
    };
  }

  if (
    rules.allow.tool_names.includes(req.tool_name) ||
    rules.allow.patterns.some((rx) => rx.test(haystack))
  ) {
    return {
      decision: "allow",
      reason: "Matched static allow rule",
      source: "static_allow",
      matchedPolicies: [],
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
          matchedPolicies: [],
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
          matchedPolicies: policies.map((p) => p.name),
        };
        deps.cache.set(key, result);
      } catch (err) {
        const fallback = policies[0]?.default_decision ?? "ask";
        result = {
          decision: fallback,
          reason: `LLM call failed (${getErrorMessage(err)}); using policy default_decision`,
          source: "fallback",
          matchedPolicies: policies.map((p) => p.name),
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
    sessionId: req.session_id,
    cwd: req.cwd,
    toolName: req.tool_name,
    toolInput: redact(req.tool_input),
    decision: result.decision,
    reason: redactString(result.reason),
    source: result.source,
    matchedPolicies: result.matchedPolicies,
    cacheHit,
    latencyMs: Math.round(performance.now() - t0),
  };
  try {
    await sink.write(record);
  } catch {
    // Audit failure must not affect decisions.
  }
}

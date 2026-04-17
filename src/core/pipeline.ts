import {
  type AuditRecord,
  type AuditSink,
  type DecisionCache,
  type DecisionResult,
  type IndexConfig,
  type LlmJudge,
  type Policy,
  type PreToolUseRequest,
} from "./types";
import { anyPatternMatches, matchPolicies, toolInputHaystack } from "./policy";
import {
  DEFAULT_REDACT_RULES,
  redact,
  redactString,
  type RedactRule,
} from "./redact";
import type { RateLimiter } from "./ratelimit";

export interface PipelineDeps {
  llm: LlmJudge;
  cache: DecisionCache;
  sink: AuditSink;
  /** Returns the latest set of policies + index. May change on reload. */
  getSnapshot: () => { policies: Policy[]; index: IndexConfig };
  /** Override for tests; defaults to Date.now / new Date(). */
  now?: () => Date;
  /** Extra rules merged onto DEFAULT_REDACT_RULES before audit write. */
  redactRules?: readonly RedactRule[];
  /** Optional per-session_id rate limiter. Skipped when absent. */
  rateLimiter?: RateLimiter;
}

/** Stable cache key: tool name + sorted JSON of tool_input. */
export function makeCacheKey(req: PreToolUseRequest): string {
  return `${req.tool_name}|${stableStringify(req.tool_input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function checkHardRules(
  req: PreToolUseRequest,
  index: IndexConfig,
): DecisionResult | null {
  const haystack = toolInputHaystack(req.tool_input);

  const dToolHit =
    index.hard_deny.tool_names.length > 0 &&
    index.hard_deny.tool_names.includes(req.tool_name);
  const dPatHit =
    index.hard_deny.patterns.length > 0 &&
    anyPatternMatches(index.hard_deny.patterns, haystack);
  if (dToolHit || dPatHit) {
    return {
      decision: "deny",
      reason: "Matched hard_deny rule in index.yaml",
      source: "hard_deny",
      matched_policies: [],
    };
  }

  const aToolHit =
    index.hard_allow.tool_names.length > 0 &&
    index.hard_allow.tool_names.includes(req.tool_name);
  const aPatHit =
    index.hard_allow.patterns.length > 0 &&
    anyPatternMatches(index.hard_allow.patterns, haystack);
  if (aToolHit || aPatHit) {
    return {
      decision: "allow",
      reason: "Matched hard_allow rule in index.yaml",
      source: "hard_allow",
      matched_policies: [],
    };
  }
  return null;
}

export function createPipeline(deps: PipelineDeps) {
  const now = deps.now ?? (() => new Date());
  const rules = deps.redactRules ?? DEFAULT_REDACT_RULES;

  return {
    async decide(req: PreToolUseRequest): Promise<DecisionResult> {
      const t0 = performance.now();
      const { policies, index } = deps.getSnapshot();

      // 0. rate limit (before even reading policies — the point is to cap
      // work during a flood)
      if (deps.rateLimiter) {
        const rl = deps.rateLimiter.check(req.session_id);
        if (!rl.allowed) {
          const result: DecisionResult = {
            decision: "deny",
            reason: `Rate limit exceeded for session; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
            source: "rate_limit",
            matched_policies: [],
          };
          await audit(deps.sink, req, result, false, t0, now, rules);
          return result;
        }
      }

      // 1. hard rules
      const hard = checkHardRules(req, index);
      if (hard) {
        await audit(deps.sink, req, hard, false, t0, now, rules);
        return hard;
      }

      // 2. cache
      const key = makeCacheKey(req);
      const cached = deps.cache.get(key);
      if (cached) {
        const result: DecisionResult = { ...cached, source: "cache" };
        await audit(deps.sink, req, result, true, t0, now, rules);
        return result;
      }

      // 3. match policies
      const matched = matchPolicies(req, policies);
      if (matched.length === 0) {
        // No policy applies and no hard rule: default to allow with note.
        const result: DecisionResult = {
          decision: "allow",
          reason: "No policy matched; defaulting to allow",
          source: "fallback",
          matched_policies: [],
        };
        await audit(deps.sink, req, result, false, t0, now, rules);
        return result;
      }

      // 4. LLM judge
      let result: DecisionResult;
      try {
        const llm = await deps.llm.judge({ request: req, policies: matched });
        result = {
          decision: llm.decision,
          reason: llm.reason,
          source: "llm",
          matched_policies: matched.map((p) => p.name),
        };
        deps.cache.set(key, result);
      } catch (err) {
        const fallback = matched[0]?.default_decision ?? "ask";
        result = {
          decision: fallback,
          reason: `LLM call failed (${stringifyError(err)}); using policy default_decision`,
          source: "fallback",
          matched_policies: matched.map((p) => p.name),
        };
      }

      await audit(deps.sink, req, result, false, t0, now, rules);
      return result;
    },
  };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function audit(
  sink: AuditSink,
  req: PreToolUseRequest,
  result: DecisionResult,
  cacheHit: boolean,
  t0: number,
  now: () => Date,
  rules: readonly RedactRule[],
): Promise<void> {
  const record: AuditRecord = {
    ts: now().toISOString(),
    session_id: req.session_id,
    cwd: req.cwd,
    tool_name: req.tool_name,
    tool_input: redact(req.tool_input, rules),
    decision: result.decision,
    reason: redactString(result.reason, rules),
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

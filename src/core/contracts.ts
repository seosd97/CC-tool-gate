import type { PermissionDecision, Policy, PreToolUseRequest } from "@/core/policy";

export interface DecisionResult {
  decision: PermissionDecision;
  reason: string;
  source: "static_deny" | "static_allow" | "cache" | "llm" | "fallback";
  matchedPolicies: string[];
}

export interface AuditRecord {
  ts: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  decision: PermissionDecision;
  reason: string;
  source: DecisionResult["source"];
  matchedPolicies: string[];
  cacheHit: boolean;
  latencyMs: number;
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

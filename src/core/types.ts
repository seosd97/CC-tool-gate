import { z } from "zod";

export const PermissionDecision = z.enum(["allow", "deny", "ask"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PreToolUseRequest = z.object({
  session_id: z.string(),
  cwd: z.string(),
  hook_event_name: z.literal("PreToolUse"),
  permission_mode: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
});
export type PreToolUseRequest = z.infer<typeof PreToolUseRequest>;

export const PreToolUseResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PreToolUse"),
    permissionDecision: PermissionDecision,
    permissionDecisionReason: z.string(),
  }),
});
export type PreToolUseResponse = z.infer<typeof PreToolUseResponse>;

export const PolicyFrontmatter = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  triggers: z
    .object({
      tool_names: z.array(z.string()).default([]),
      patterns: z.array(z.string()).default([]),
    })
    .default({ tool_names: [], patterns: [] }),
  default_decision: PermissionDecision.default("ask"),
});
export type PolicyFrontmatter = z.infer<typeof PolicyFrontmatter>;

export interface Policy {
  name: string;
  description: string;
  triggers: {
    tool_names: string[];
    patterns: string[];
  };
  default_decision: PermissionDecision;
  body: string;
  source: string;
}

export const IndexConfig = z.object({
  hard_deny: z
    .object({
      tool_names: z.array(z.string()).default([]),
      patterns: z.array(z.string()).default([]),
    })
    .default({ tool_names: [], patterns: [] }),
  hard_allow: z
    .object({
      tool_names: z.array(z.string()).default([]),
      patterns: z.array(z.string()).default([]),
    })
    .default({ tool_names: [], patterns: [] }),
});
export type IndexConfig = z.infer<typeof IndexConfig>;

export const LlmDecision = z.object({
  decision: PermissionDecision,
  reason: z.string(),
});
export type LlmDecision = z.infer<typeof LlmDecision>;

export interface DecisionResult {
  decision: PermissionDecision;
  reason: string;
  source: "hard_deny" | "hard_allow" | "cache" | "llm" | "fallback";
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

// ----- Interfaces (implemented in adapters/) -----

export interface LlmJudge {
  judge(input: {
    request: PreToolUseRequest;
    policies: Policy[];
  }): Promise<LlmDecision>;
}

export interface DecisionCache {
  get(key: string): DecisionResult | undefined;
  set(key: string, value: DecisionResult): void;
  size(): number;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

export interface SourceProvider {
  /** Returns parsed policies and (optionally) an index.yaml. Polled by the registry. */
  load(): Promise<{ policies: Policy[]; index?: IndexConfig }>;
  uri: string;
}

export interface StorageSink {
  /**
   * Upload one local file to the backend at the given key. Returns true on
   * success (any 2xx), false on a recoverable failure (caller leaves the file
   * in pending/ for the next pass). May throw on truly unexpected errors.
   */
  upload(localPath: string, key: string, contentType: string): Promise<boolean>;
}

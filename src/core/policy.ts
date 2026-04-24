import matter from "gray-matter";
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

export const PolicyFrontmatter = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  default_decision: PermissionDecision.default("ask"),
});
export type PolicyFrontmatter = z.infer<typeof PolicyFrontmatter>;

export interface Policy {
  name: string;
  description: string;
  default_decision: PermissionDecision;
  body: string;
  source: string;
}

export const StaticRules = z.object({
  deny: z
    .object({
      tool_names: z.array(z.string()).default([]),
      patterns: z.array(z.string()).default([]),
    })
    .default({ tool_names: [], patterns: [] }),
  allow: z
    .object({
      tool_names: z.array(z.string()).default([]),
      patterns: z.array(z.string()).default([]),
    })
    .default({ tool_names: [], patterns: [] }),
});
export type StaticRules = z.infer<typeof StaticRules>;

function validatePatterns(patterns: readonly string[], context: string): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    try {
      new RegExp(p, "i");
      out.push(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${context}: dropping invalid regex ${JSON.stringify(p)} (${msg})`);
    }
  }
  return out;
}

export function parsePolicy(source: string, raw: string): Policy | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const fm = PolicyFrontmatter.safeParse(parsed.data);
  if (!fm.success) return null;
  return {
    name: fm.data.name,
    description: fm.data.description,
    default_decision: fm.data.default_decision,
    body: parsed.content.trim(),
    source,
  };
}

export function sanitizeStaticRules(rules: StaticRules, source: string): StaticRules {
  return {
    deny: {
      tool_names: rules.deny.tool_names,
      patterns: validatePatterns(rules.deny.patterns, `${source} deny`),
    },
    allow: {
      tool_names: rules.allow.tool_names,
      patterns: validatePatterns(rules.allow.patterns, `${source} allow`),
    },
  };
}

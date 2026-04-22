import matter from "gray-matter";
import { type Policy, PolicyFrontmatter, type PreToolUseRequest } from "./types";

/**
 * Drop patterns that aren't valid JS regex, warning the operator for each.
 * Invalid patterns used to silently fall back to substring matching, which
 * quietly weakened hard_deny rules — an operator typo could turn a strict
 * deny into a no-op. Now we refuse to load them.
 */
export function validatePatterns(patterns: readonly string[], context: string): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    try {
      new RegExp(p, "i");
      out.push(p);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`${context}: dropping invalid regex ${JSON.stringify(p)} (${msg})`);
    }
  }
  return out;
}

/**
 * Parse a single Skill-style markdown file into a Policy. Returns null if the
 * frontmatter is missing or invalid (caller logs and skips).
 */
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
    triggers: {
      tool_names: fm.data.triggers.tool_names,
      patterns: validatePatterns(fm.data.triggers.patterns, `policy ${source}`),
    },
    default_decision: fm.data.default_decision,
    body: parsed.content.trim(),
    source,
  };
}

/**
 * Merge layers of policies: later layers override earlier by `name`. Useful for
 * combining multiple SourceProviders.
 */
export function mergePolicies(layers: Policy[][]): Policy[] {
  const out = new Map<string, Policy>();
  for (const layer of layers) {
    for (const p of layer) out.set(p.name, p);
  }
  return Array.from(out.values());
}

/**
 * Stringify the relevant parts of a tool_input for pattern matching. We
 * concatenate string-leaf values; non-string leaves are JSON-stringified.
 */
export function toolInputHaystack(toolInput: Record<string, unknown>): string {
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

/**
 * Patterns are validated at load time (see `validatePatterns`), so by the
 * time we reach here every string compiles. Cached per array reference —
 * arrays are treated as immutable once parsed.
 */
const compiledCache = new WeakMap<readonly string[], RegExp[]>();

function compilePatterns(patterns: readonly string[]): RegExp[] {
  let cached = compiledCache.get(patterns);
  if (cached) return cached;
  cached = patterns.map((p) => new RegExp(p, "i"));
  compiledCache.set(patterns, cached);
  return cached;
}

/** True if any pattern matches the haystack (regex, case-insensitive). */
export function anyPatternMatches(patterns: readonly string[], haystack: string): boolean {
  if (patterns.length === 0) return false;
  const compiled = compilePatterns(patterns);
  for (const rx of compiled) {
    if (rx.test(haystack)) return true;
  }
  return false;
}

/**
 * Match a request against policies. A policy matches if either:
 *  - tool_names is empty OR contains the request tool, AND
 *  - patterns is empty OR any pattern matches the tool_input haystack.
 *
 * Policies with both lists empty match nothing (avoids accidental catch-all).
 */
export function matchPolicies(req: PreToolUseRequest, policies: Policy[]): Policy[] {
  const haystack = toolInputHaystack(req.tool_input);
  const out: Policy[] = [];
  for (const p of policies) {
    const hasTool = p.triggers.tool_names.length > 0;
    const hasPat = p.triggers.patterns.length > 0;
    if (!hasTool && !hasPat) continue;

    const toolOk = !hasTool || p.triggers.tool_names.includes(req.tool_name);
    if (!toolOk) continue;

    const patOk = !hasPat || anyPatternMatches(p.triggers.patterns, haystack);
    if (!patOk) continue;

    out.push(p);
  }
  return out;
}

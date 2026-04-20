import matter from "gray-matter";
import { PolicyFrontmatter, type Policy, type PreToolUseRequest } from "./types";

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
    triggers: fm.data.triggers,
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
 * Precompiled form: `null` means the source string was not a valid regex and
 * callers must fall back to a case-insensitive substring match.
 *
 * Cached per `patterns` array reference. Policy and IndexConfig arrays are
 * treated as immutable once parsed, so this is safe; if you ever mutate a
 * patterns array in place, throw away the old reference instead.
 */
const compiledCache = new WeakMap<readonly string[], (RegExp | null)[]>();

function compilePatterns(patterns: readonly string[]): (RegExp | null)[] {
  let cached = compiledCache.get(patterns);
  if (cached) return cached;
  cached = patterns.map((p) => {
    try {
      return new RegExp(p, "i");
    } catch {
      return null;
    }
  });
  compiledCache.set(patterns, cached);
  return cached;
}

/** True if any pattern matches the haystack (regex, case-insensitive). */
export function anyPatternMatches(
  patterns: readonly string[],
  haystack: string,
): boolean {
  if (patterns.length === 0) return false;
  const compiled = compilePatterns(patterns);
  let lowered: string | null = null;
  for (let i = 0; i < patterns.length; i++) {
    const rx = compiled[i];
    if (rx) {
      if (rx.test(haystack)) return true;
    } else {
      // Invalid regex: fall back to substring match (case-insensitive).
      if (lowered === null) lowered = haystack.toLowerCase();
      if (lowered.includes(patterns[i]!.toLowerCase())) return true;
    }
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

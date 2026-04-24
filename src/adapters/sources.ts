import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type CompiledStaticRules,
  type Policy,
  parsePolicy,
  StaticRules,
  sanitizeStaticRules,
  type ValidationWarning,
} from "@/core/policy";
import { log } from "@/lib/logger";

const INDEX_FILES = new Set(["index.yaml", "index.yml"]);

export interface LoadResult {
  policies: Policy[];
  rules?: CompiledStaticRules;
}

export async function loadPoliciesFromDir(
  dir: string,
  onWarn?: (w: ValidationWarning) => void,
): Promise<LoadResult> {
  const policies: Policy[] = [];
  let rules: CompiledStaticRules | undefined;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("Policy directory unreadable", { dir, error: msg });
    return { policies: [], rules };
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    if (INDEX_FILES.has(name)) {
      const raw = await readFile(full, "utf8");
      const parsed = StaticRules.safeParse(parseYaml(raw));
      if (parsed.success) {
        const warnings: ValidationWarning[] = [];
        rules = sanitizeStaticRules(parsed.data, full, warnings);
        for (const w of warnings) {
          if (onWarn) onWarn(w);
          else
            log.warn("Dropping invalid regex", {
              context: w.context,
              pattern: w.pattern,
              error: w.error,
            });
        }
      }
      continue;
    }
    if (extname(name).toLowerCase() !== ".md") continue;
    const raw = await readFile(full, "utf8");
    const policy = parsePolicy(full, raw);
    if (policy) policies.push(policy);
  }
  return { policies, rules };
}

export interface PolicyStore {
  snapshot(): { policies: Policy[]; rules: CompiledStaticRules };
  reload(): Promise<void>;
}

const EMPTY_RULES: CompiledStaticRules = {
  deny: { tool_names: [], patterns: [] },
  allow: { tool_names: [], patterns: [] },
};

export function createPolicyStore(dirs: string[]): PolicyStore {
  let policies: Policy[] = [];
  let rules: CompiledStaticRules = EMPTY_RULES;

  return {
    snapshot: () => ({ policies, rules }),
    async reload() {
      const allPolicies: Policy[] = [];
      let nextRules: CompiledStaticRules | undefined;
      for (const dir of dirs) {
        try {
          const { policies: ps, rules: r } = await loadPoliciesFromDir(dir, (w) => {
            log.warn("Dropping invalid regex", {
              context: w.context,
              pattern: w.pattern,
              error: w.error,
            });
          });
          allPolicies.push(...ps);
          if (r) nextRules = r;
        } catch {
          // keep last good for this dir
        }
      }
      policies = allPolicies;
      if (nextRules) rules = nextRules;
    },
  };
}

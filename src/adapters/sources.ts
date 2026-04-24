import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Policy, parsePolicy, StaticRules, sanitizeStaticRules } from "@/core/policy";

const INDEX_FILES = new Set(["index.yaml", "index.yml"]);

export async function loadPoliciesFromDir(
  dir: string,
): Promise<{ policies: Policy[]; rules?: StaticRules }> {
  const policies: Policy[] = [];
  let rules: StaticRules | undefined;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    console.warn(
      `Policy directory unreadable: ${dir}`,
      err instanceof Error ? err.message : String(err),
    );
    return { policies: [], rules };
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    if (INDEX_FILES.has(name)) {
      const raw = await readFile(full, "utf8");
      const parsed = StaticRules.safeParse(parseYaml(raw));
      if (parsed.success) rules = sanitizeStaticRules(parsed.data, full);
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
  snapshot(): { policies: Policy[]; rules: StaticRules };
  reload(): Promise<void>;
}

const EMPTY_RULES: StaticRules = {
  deny: { tool_names: [], patterns: [] },
  allow: { tool_names: [], patterns: [] },
};

export function createPolicyStore(dirs: string[]): PolicyStore {
  let policies: Policy[] = [];
  let rules: StaticRules = EMPTY_RULES;

  return {
    snapshot: () => ({ policies, rules }),
    async reload() {
      const allPolicies: Policy[] = [];
      let nextRules: StaticRules | undefined;
      for (const dir of dirs) {
        try {
          const { policies: ps, rules: r } = await loadPoliciesFromDir(dir);
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

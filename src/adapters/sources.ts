import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergePolicies, parsePolicy, validatePatterns } from "../core/policy";
import {
  IndexConfig,
  type Policy,
  type SourceProvider,
} from "../core/types";

const INDEX_FILES = new Set(["index.yaml", "index.yml"]);

/** Drop invalid regexes from a parsed IndexConfig before handing it to the pipeline. */
function sanitizeIndex(index: IndexConfig, source: string): IndexConfig {
  return {
    hard_deny: {
      tool_names: index.hard_deny.tool_names,
      patterns: validatePatterns(index.hard_deny.patterns, `${source} hard_deny`),
    },
    hard_allow: {
      tool_names: index.hard_allow.tool_names,
      patterns: validatePatterns(index.hard_allow.patterns, `${source} hard_allow`),
    },
  };
}

/**
 * Only `file://` is supported. Remote (https://) and base64 (inline:) sources
 * were dropped along with the upload pipeline — for a personal-use gate,
 * a directory checked into your deploy is the right shape.
 */
export function createSourceProvider(uri: string): SourceProvider {
  if (uri.startsWith("file://")) return fileSource(uri);
  throw new Error(`Unsupported POLICY_SOURCES scheme: ${uri} (only file:// is supported)`);
}

function fileSource(uri: string): SourceProvider {
  const dir = uri.replace(/^file:\/\//, "");
  return {
    uri,
    async load() {
      const policies: Policy[] = [];
      let index: IndexConfig | undefined;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return { policies: [], index };
      }
      for (const name of entries.sort()) {
        const full = join(dir, name);
        if (INDEX_FILES.has(name)) {
          const raw = await readFile(full, "utf8");
          const parsed = IndexConfig.safeParse(parseYaml(raw));
          if (parsed.success) index = sanitizeIndex(parsed.data, `${uri}#${name}`);
          continue;
        }
        if (extname(name).toLowerCase() !== ".md") continue;
        const raw = await readFile(full, "utf8");
        const policy = parsePolicy(`${uri}#${name}`, raw);
        if (policy) policies.push(policy);
      }
      return { policies, index };
    },
  };
}

export interface PolicyRegistry {
  /** Atomic snapshot for the pipeline. */
  snapshot(): { policies: Policy[]; index: IndexConfig };
  /** Reload all sources now. */
  reload(): Promise<void>;
}

export interface RegistryOptions {
  sources: SourceProvider[];
}

const EMPTY_INDEX: IndexConfig = {
  hard_deny: { tool_names: [], patterns: [] },
  hard_allow: { tool_names: [], patterns: [] },
};

export function createPolicyRegistry(opts: RegistryOptions): PolicyRegistry {
  let policies: Policy[] = [];
  let index: IndexConfig = EMPTY_INDEX;

  const reload = async (): Promise<void> => {
    const layers: Policy[][] = [];
    let nextIndex: IndexConfig | undefined;
    for (const s of opts.sources) {
      try {
        const { policies: ps, index: ix } = await s.load();
        layers.push(ps);
        if (ix) nextIndex = ix; // later wins
      } catch {
        // keep last good for this source by skipping
      }
    }
    policies = mergePolicies(layers);
    if (nextIndex) index = nextIndex;
  };

  return {
    snapshot: () => ({ policies, index }),
    reload,
  };
}

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergePolicies, parsePolicy } from "../core/policy";
import {
  IndexConfig,
  type Policy,
  type SourceProvider,
} from "../core/types";

const INDEX_FILES = new Set(["index.yaml", "index.yml"]);

/** Default per-fetch timeout for the HTTP source. */
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface SourceProviderOptions {
  /** Per-fetch timeout for http(s) sources. Defaults to 10s. */
  timeoutMs?: number;
}

/** Dispatch a URI like file:// / https:// / inline: to the right loader. */
export function createSourceProvider(
  uri: string,
  opts: SourceProviderOptions = {},
): SourceProvider {
  if (uri.startsWith("file://")) return fileSource(uri);
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return httpSource(uri, opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  }
  if (uri.startsWith("inline:")) return inlineSource(uri);
  throw new Error(`Unsupported POLICY_SOURCES scheme: ${uri}`);
}

/** fetch wrapper that aborts after timeoutMs. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`fetch timed out after ${timeoutMs}ms: ${url}`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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
          if (parsed.success) index = parsed.data;
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

interface HttpEntry {
  name: string;
  url: string;
}

/**
 * https:// loader. Expects the URL to either:
 *  - point at an index.json listing files: { policies: [{name, url}], index?: string }
 *  - or a single .md file (loaded as one policy)
 */
function httpSource(uri: string, timeoutMs: number): SourceProvider {
  let etag: string | null = null;
  let cached: { policies: Policy[]; index?: IndexConfig } = { policies: [] };

  return {
    uri,
    async load() {
      const headers: Record<string, string> = {};
      if (etag) headers["if-none-match"] = etag;
      const res = await fetchWithTimeout(uri, { headers }, timeoutMs);
      if (res.status === 304) return cached;
      if (!res.ok) throw new Error(`HTTP source ${uri}: ${res.status}`);
      const newEtag = res.headers.get("etag");
      const text = await res.text();

      if (uri.endsWith(".md")) {
        const policy = parsePolicy(uri, text);
        cached = { policies: policy ? [policy] : [] };
      } else {
        const manifest = JSON.parse(text) as {
          policies?: HttpEntry[];
          index?: string;
        };
        const policies: Policy[] = [];
        for (const entry of manifest.policies ?? []) {
          const r = await fetchWithTimeout(entry.url, {}, timeoutMs);
          if (!r.ok) continue;
          const body = await r.text();
          const p = parsePolicy(entry.url, body);
          if (p) policies.push(p);
        }
        let index: IndexConfig | undefined;
        if (manifest.index) {
          const r = await fetchWithTimeout(manifest.index, {}, timeoutMs);
          if (r.ok) {
            const parsed = IndexConfig.safeParse(parseYaml(await r.text()));
            if (parsed.success) index = parsed.data;
          }
        }
        cached = { policies, index };
      }
      etag = newEtag;
      return cached;
    },
  };
}

function inlineSource(uri: string): SourceProvider {
  const b64 = uri.slice("inline:".length);
  return {
    uri,
    async load() {
      const text = Buffer.from(b64, "base64").toString("utf8");
      const policy = parsePolicy(uri, text);
      return { policies: policy ? [policy] : [] };
    },
  };
}

export interface PolicyRegistry {
  /** Atomic snapshot for the pipeline. */
  snapshot(): { policies: Policy[]; index: IndexConfig };
  /** Reload all sources now. */
  reload(): Promise<void>;
  /** Begin polling. */
  start(): void;
  stop(): void;
}

export interface RegistryOptions {
  sources: SourceProvider[];
  pollMs?: number;
  fallbackIndex?: IndexConfig;
}

const EMPTY_INDEX: IndexConfig = {
  hard_deny: { tool_names: [], patterns: [] },
  hard_allow: { tool_names: [], patterns: [] },
};

export function createPolicyRegistry(opts: RegistryOptions): PolicyRegistry {
  const interval = opts.pollMs ?? 60_000;
  let policies: Policy[] = [];
  let index: IndexConfig = opts.fallbackIndex ?? EMPTY_INDEX;
  let timer: ReturnType<typeof setInterval> | null = null;

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
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void reload();
      }, interval);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

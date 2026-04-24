import type { DecisionCache, DecisionResult } from "@/core/gate";

interface Entry {
  value: DecisionResult;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export function createMemoryCache(opts: MemoryCacheOptions): DecisionCache {
  const map = new Map<string, Entry>();
  const now = opts.now ?? (() => Date.now());

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, expiresAt: now() + opts.ttlMs });
      while (map.size > opts.maxEntries) {
        const oldest = map.keys().next().value as string | undefined;
        if (!oldest) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

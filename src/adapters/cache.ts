import type { DecisionCache, DecisionResult } from "../core/types";

interface Entry {
  value: DecisionResult;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  /** TTL in milliseconds. */
  ttlMs: number;
  /** Maximum number of entries (LRU eviction). */
  maxEntries: number;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Simple LRU+TTL cache backed by a Map (insertion order = LRU order).
 */
export function createMemoryCache(opts: MemoryCacheOptions): DecisionCache {
  const map = new Map<string, Entry>();
  const now = opts.now ?? (() => Date.now());

  const evict = (): void => {
    while (map.size > opts.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) break;
      map.delete(oldest);
    }
  };

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      // refresh LRU position
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, expiresAt: now() + opts.ttlMs });
      evict();
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

import type { DecisionCache, DecisionResult } from "@/core/gate";

interface Entry {
  value: DecisionResult;
  expiresAt: number;
}

export function createMemoryCache(
  ttlMs: number,
  maxEntries: number,
  now?: () => number,
): DecisionCache {
  const map = new Map<string, Entry>();
  const _now = now ?? (() => Date.now());

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= _now()) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, expiresAt: _now() + ttlMs });
      while (map.size > maxEntries) {
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

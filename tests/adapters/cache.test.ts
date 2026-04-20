import { describe, expect, test } from "bun:test";
import { createMemoryCache } from "../../src/adapters/cache";
import type { DecisionResult } from "../../src/core/types";

const v = (decision: DecisionResult["decision"]): DecisionResult => ({
  decision,
  reason: "x",
  source: "llm",
  matched_policies: [],
});

describe("memory cache", () => {
  test("get returns set value", () => {
    const c = createMemoryCache({ ttlMs: 1000, maxEntries: 5 });
    c.set("k", v("allow"));
    expect(c.get("k")?.decision).toBe("allow");
  });

  test("expires after ttl", () => {
    let t = 0;
    const c = createMemoryCache({ ttlMs: 100, maxEntries: 5, now: () => t });
    c.set("k", v("deny"));
    t = 99;
    expect(c.get("k")?.decision).toBe("deny");
    t = 101;
    expect(c.get("k")).toBeUndefined();
  });

  test("evicts least recently used", () => {
    const c = createMemoryCache({ ttlMs: 10_000, maxEntries: 2 });
    c.set("a", v("allow"));
    c.set("b", v("deny"));
    // touch a so b is now LRU
    c.get("a");
    c.set("c", v("ask"));
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")?.decision).toBe("allow");
    expect(c.get("c")?.decision).toBe("ask");
    expect(c.size()).toBe(2);
  });

  test("clear drops all entries", () => {
    const c = createMemoryCache({ ttlMs: 10_000, maxEntries: 5 });
    c.set("a", v("allow"));
    c.set("b", v("deny"));
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });
});

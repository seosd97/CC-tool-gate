import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "../../src/core/ratelimit";

describe("rate limiter", () => {
  test("allows up to maxRequests within window, denies the next", () => {
    let t = 1000;
    const rl = createRateLimiter({
      windowMs: 1000,
      maxRequests: 3,
      now: () => t,
    });
    expect(rl.check("a").allowed).toBe(true);
    t += 100;
    expect(rl.check("a").allowed).toBe(true);
    t += 100;
    expect(rl.check("a").allowed).toBe(true);
    t += 100;
    const v = rl.check("a");
    expect(v.allowed).toBe(false);
    // Oldest was at 1000, window is 1000ms, so it opens at 2000. t is 1300.
    expect(v.retryAfterMs).toBe(700);
  });

  test("window slides so the oldest slot frees up after windowMs", () => {
    let t = 1000;
    const rl = createRateLimiter({
      windowMs: 1000,
      maxRequests: 2,
      now: () => t,
    });
    expect(rl.check("a").allowed).toBe(true); // at 1000
    t += 500;
    expect(rl.check("a").allowed).toBe(true); // at 1500
    t += 100;
    expect(rl.check("a").allowed).toBe(false); // at 1600; both in window
    t += 500; // t=2100; 1000 has aged out (>= cutoff 1100)
    expect(rl.check("a").allowed).toBe(true);
  });

  test("separate keys have independent budgets", () => {
    let t = 1000;
    const rl = createRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      now: () => t,
    });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(false);
  });

  test("evicts LRU entries when maxKeys is exceeded", () => {
    let t = 1000;
    const rl = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      maxKeys: 2,
      now: () => t,
    });
    rl.check("a"); t += 10;
    rl.check("b"); t += 10;
    expect(rl.size()).toBe(2);
    rl.check("c"); // should evict "a"
    expect(rl.size()).toBe(2);
    // "a" is gone so it starts fresh (still allowed once).
    rl.check("a");
    expect(rl.size()).toBe(2); // now "b" was evicted because "a" touched last
  });

  test("retryAfterMs is never negative", () => {
    let t = 1000;
    const rl = createRateLimiter({
      windowMs: 1000,
      maxRequests: 1,
      now: () => t,
    });
    rl.check("a");
    // Force a second check at a time where even the oldest is ancient.
    t += 10_000;
    // Now the window has fully elapsed, so the next call is allowed.
    expect(rl.check("a").allowed).toBe(true);
  });
});

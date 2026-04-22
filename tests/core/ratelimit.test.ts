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
    expect(rl.check().allowed).toBe(true);
    t += 100;
    expect(rl.check().allowed).toBe(true);
    t += 100;
    expect(rl.check().allowed).toBe(true);
    t += 100;
    const v = rl.check();
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
    expect(rl.check().allowed).toBe(true); // at 1000
    t += 500;
    expect(rl.check().allowed).toBe(true); // at 1500
    t += 100;
    expect(rl.check().allowed).toBe(false); // at 1600; both in window
    t += 500; // t=2100; 1000 has aged out (>= cutoff 1100)
    expect(rl.check().allowed).toBe(true);
  });
});

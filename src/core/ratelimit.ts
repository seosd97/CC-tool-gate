/**
 * Global sliding-window rate limiter. The gate's sole purpose here is to cap
 * LLM cost during a runaway loop — per-session accounting was dropped because
 * a single process typically handles one agent at a time and the extra
 * bookkeeping wasn't buying anything.
 */

export interface RateLimiterOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Max requests within the window. */
  maxRequests: number;
  /** Override clock for tests. */
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Ms until the oldest in-window slot expires; 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(): RateLimitVerdict;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { windowMs, maxRequests } = opts;
  const now = opts.now ?? (() => Date.now());
  let log: number[] = [];

  return {
    check(): RateLimitVerdict {
      const t = now();
      const cutoff = t - windowMs;
      let drop = 0;
      while (drop < log.length && log[drop]! < cutoff) drop++;
      if (drop > 0) log = log.slice(drop);

      if (log.length >= maxRequests) {
        return { allowed: false, retryAfterMs: log[0]! + windowMs - t };
      }
      log.push(t);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

/**
 * Per-session sliding-window rate limiter. Prevents a buggy or runaway hook
 * client from driving a DoS through the LLM judge.
 *
 * Storage is an in-memory LRU: each session_id maps to a list of recent
 * request timestamps trimmed to the active window. Buckets are touched on
 * every check so inactive sessions naturally age out once `maxKeys` is
 * exceeded.
 */

export interface RateLimiterOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Max requests per key within the window. */
  maxRequests: number;
  /** LRU cap on active keys. Default 10_000. */
  maxKeys?: number;
  /** Override clock for tests. */
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Ms until the oldest in-window slot expires; 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
  size(): number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { windowMs, maxRequests } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, number[]>();

  return {
    check(key: string): RateLimitVerdict {
      const t = now();
      const cutoff = t - windowMs;

      let log = buckets.get(key);
      if (log) {
        // LRU touch: re-insert at the tail.
        buckets.delete(key);
      } else {
        log = [];
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      // Drop timestamps older than the window.
      let drop = 0;
      while (drop < log.length && log[drop]! < cutoff) drop++;
      if (drop > 0) log = log.slice(drop);
      buckets.set(key, log);

      if (log.length >= maxRequests) {
        return {
          allowed: false,
          retryAfterMs: log[0]! + windowMs - t,
        };
      }
      log.push(t);
      return { allowed: true, retryAfterMs: 0 };
    },
    size: () => buckets.size,
  };
}

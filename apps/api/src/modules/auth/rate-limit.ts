/**
 * Fixed-window rate limiter kept in process memory (no dependency). Enough for one API instance;
 * with several instances each keeps its own counters, so a shared store (e.g. Redis) is needed
 * before scaling out (tracked in docs/development/operational-gaps.md).
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for the Retry-After header). */
  retryAfterSeconds: number;
}

const MAX_TRACKED_KEYS = 50_000;

export function createRateLimiter(rule: RateLimitRule, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();

  function prune(at: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  }

  return {
    consume(key: string): RateLimitResult {
      const at = now();
      if (windows.size >= MAX_TRACKED_KEYS) prune(at);

      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        window = { count: 0, resetAt: at + rule.windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return {
        allowed: window.count <= rule.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - at) / 1000)),
      };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

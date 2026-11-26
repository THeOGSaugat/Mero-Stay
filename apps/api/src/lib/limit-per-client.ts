import type { RequestHandler } from "express";
import { createRateLimiter, type RateLimitRule } from "../modules/auth/rate-limit.js";
import { clientIp, rateLimitKeyForIp } from "./client-ip.js";
import { AppError } from "./errors.js";

/**
 * A per-client, per-path limit (CLAUDE.md §4) for endpoints without a session or with a costly
 * effect: payment starts and gateway callbacks (ADR 0017), admin setup links (ADR 0018). The client
 * is resolved through the trusted proxies (ADR 0014; IPv6 per /64).
 */
export function limitPerClient(rule: RateLimitRule): RequestHandler {
  const limiter = createRateLimiter(rule);
  return (req, res, next) => {
    const result = limiter.consume(`${req.path}|${rateLimitKeyForIp(clientIp(req))}`);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      next(
        new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later.", {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
      return;
    }
    next();
  };
}

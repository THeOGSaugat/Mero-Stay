import type { RateLimitRule } from "./rate-limit.js";

/** Everything the auth module needs from configuration (built from env in server.ts). */
export interface AuthConfig {
  /** ≥ 32 characters. Signs CSRF tokens. Rotating it invalidates CSRF tokens (clients re-fetch /auth/me). */
  sessionSecret: string;
  /** Absolute session lifetime. */
  sessionTtlMs: number;
  /** Send the cookie only over HTTPS (and use the __Host- prefix). Required in production. */
  cookieSecure: boolean;
  rateLimits: {
    /** Login attempts per email address. */
    loginPerEmail: RateLimitRule;
    /** Login attempts per client IP. */
    loginPerIp: RateLimitRule;
    /** Registrations per client IP. */
    registerPerIp: RateLimitRule;
  };
}

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMITS: AuthConfig["rateLimits"] = {
  loginPerEmail: { limit: 10, windowMs: 15 * MINUTE },
  loginPerIp: { limit: 30, windowMs: 15 * MINUTE },
  registerPerIp: { limit: 5, windowMs: 60 * MINUTE },
};

export const DEFAULT_SESSION_TTL_HOURS = 168; // 7 days

/** `__Host-` prefix: the browser only accepts it with Secure, Path=/ and no Domain (cookie tossing defence). */
export function sessionCookieName(config: Pick<AuthConfig, "cookieSecure">): string {
  return config.cookieSecure ? "__Host-merostay_session" : "merostay_session";
}

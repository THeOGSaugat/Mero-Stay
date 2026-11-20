import type { AuthConfig } from "../modules/auth/auth.config.js";

/**
 * Auth settings for tests. The secret is a fixed, obviously fake test value (never used outside
 * tests). Rate limits are high so suites can register many users; tests that check rate limiting
 * pass their own low limits.
 */
export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  const generous = { limit: 10_000, windowMs: 60_000 };
  return {
    sessionSecret: "test-only-session-secret-not-for-production-use-0123456789",
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    cookieSecure: false,
    rateLimits: { loginPerEmail: generous, loginPerIp: generous, registerPerIp: generous },
    ...overrides,
  };
}

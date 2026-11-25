import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { authConfigFromEnv, parseEnv } from "../../config/env.js";
import type { AppError } from "../../lib/errors.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { sessionCookieName } from "./auth.config.js";
import { createAuthMiddleware } from "./auth.middleware.js";
import type { AuthService } from "./auth.service.js";
import { emailSchema } from "./auth.schemas.js";
import {
  PASSWORD_HASH_PARAMS,
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "./password.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  csrfTokenFor,
  generateSessionToken,
  hashSessionToken,
  isValidCsrfToken,
  parseCookies,
} from "./tokens.js";

describe("password hashing (Argon2id, node:crypto)", () => {
  it("produces a PHC string with the documented OWASP parameters and a random salt", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(a).not.toBe(b); // different salts
    expect(PASSWORD_HASH_PARAMS).toMatchObject({ memoryKiB: 19_456, passes: 2, parallelism: 1 });
  });

  it("verifies the right password and rejects wrong ones", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  it("treats Unicode-equivalent passwords the same (NFC)", async () => {
    const composed = "Caf\u00E9 in Kathmandu!"; // é as a single code point
    const decomposed = "Cafe\u0301 in Kathmandu!"; // e + combining acute accent
    expect(composed).not.toBe(decomposed); // different bytes...
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC")); // ...same text
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it("never matches a malformed or tampered hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    for (const bad of [
      "",
      "plaintext",
      hash.replace("argon2id", "argon2i"),
      hash.replace("m=19456", "m=99999999"), // absurd memory: refused, not attempted
      hash.slice(0, -4),
    ]) {
      expect(await verifyPassword("correct horse battery staple", bad)).toBe(false);
    }
  });

  it("has a real dummy hash for unknown accounts (timing equalization), created once", async () => {
    const dummy = await dummyPasswordHash();
    expect(dummy).toMatch(/^\$argon2id\$/);
    expect(await dummyPasswordHash()).toBe(dummy);
    expect(await verifyPassword("anything", dummy)).toBe(false);
  });
});

describe("session and CSRF tokens", () => {
  it("session tokens are 256-bit random and stored only as SHA-256 hex", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it("CSRF tokens are bound to the session and the secret", () => {
    const secret = "x".repeat(40);
    const sessionA = hashSessionToken(generateSessionToken());
    const sessionB = hashSessionToken(generateSessionToken());
    const token = csrfTokenFor(secret, sessionA);

    expect(isValidCsrfToken(secret, sessionA, token)).toBe(true);
    expect(isValidCsrfToken(secret, sessionB, token)).toBe(false); // another session
    expect(isValidCsrfToken("y".repeat(40), sessionA, token)).toBe(false); // another secret
    expect(isValidCsrfToken(secret, sessionA, `${token}x`)).toBe(false);
    expect(isValidCsrfToken(secret, sessionA, "")).toBe(false);
  });

  it("parses Cookie headers defensively", () => {
    const cookies = parseCookies(
      'a=1; merostay_session=abc%2Fdef; b="quoted"; a=2; broken=%E0%A4%A',
    );
    expect(cookies.get("a")).toBe("1"); // first wins
    expect(cookies.get("merostay_session")).toBe("abc/def");
    expect(cookies.get("b")).toBe("quoted");
    expect(cookies.has("broken")).toBe(false);
    expect(parseCookies(undefined).size).toBe(0);
  });

  it("uses the __Host- cookie prefix only with Secure cookies", () => {
    expect(sessionCookieName({ cookieSecure: true })).toBe("__Host-merostay_session");
    expect(sessionCookieName({ cookieSecure: false })).toBe("merostay_session");
  });
});

describe("email normalization", () => {
  it("trims and lower-cases so one inbox is one account", () => {
    expect(emailSchema.parse("  Ram.Bahadur@Example.COM ")).toBe("ram.bahadur@example.com");
    expect(emailSchema.safeParse("not an email").success).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows `limit` requests per window per key, then reports when to retry", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 }, () => now);
    expect([1, 2, 3].map(() => limiter.consume("ip-1").allowed)).toEqual([true, true, true]);
    const blocked = limiter.consume("ip-1");
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.consume("ip-2").allowed).toBe(true); // keys are independent

    now = 30_000;
    expect(limiter.consume("ip-1").retryAfterSeconds).toBe(30);
    now = 60_000;
    expect(limiter.consume("ip-1").allowed).toBe(true); // new window
  });
});

describe("auth configuration from the environment", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost/db" };

  it("refuses to start the server without SESSION_SECRET (empty counts as missing)", () => {
    expect(() => authConfigFromEnv(parseEnv(base))).toThrow(/SESSION_SECRET: is required/);
    expect(() => authConfigFromEnv(parseEnv({ ...base, SESSION_SECRET: "" }))).toThrow(
      /is required/,
    );
  });

  it("rejects a short secret without echoing it", () => {
    let message = "";
    try {
      parseEnv({ ...base, SESSION_SECRET: "too-short-secret" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/SESSION_SECRET: must be at least 32 characters/);
    expect(message).not.toContain("too-short-secret");
  });

  it("defaults: 7-day sessions, Secure cookies only in production", () => {
    const secret = "s".repeat(48);
    const dev = authConfigFromEnv(parseEnv({ ...base, SESSION_SECRET: secret }));
    expect(dev).toMatchObject({ sessionTtlMs: 7 * 24 * 3_600_000, cookieSecure: false });
    const prod = authConfigFromEnv(
      parseEnv({
        ...base,
        NODE_ENV: "production",
        DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`,
        SESSION_SECRET: secret,
        TRUST_PROXY_HOPS: "1",
        TRUST_PROXY_ADDRESSES: "loopback",
      }),
    );
    expect(prod.cookieSecure).toBe(true);
  });

  it("forbids insecure cookies in production", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "production",
        DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`,
        SESSION_SECRET: "s".repeat(48),
        SESSION_COOKIE_SECURE: "false",
      }),
    ).toThrow(/SESSION_COOKIE_SECURE: cannot be false in production/);
  });

  it("ignores the removed ALLOW_UNAUTHENTICATED_TRIPS_API variable entirely", () => {
    const env = parseEnv({
      ...base,
      SESSION_SECRET: "s".repeat(48),
      ALLOW_UNAUTHENTICATED_TRIPS_API: "true",
    });
    expect(Object.keys(env)).not.toContain("ALLOW_UNAUTHENTICATED_TRIPS_API");
  });
});

describe("requireAuth / requireCsrf middleware", () => {
  const config = testAuthConfig();
  const fakeService = { resolveSession: vi.fn() } as unknown as AuthService;
  const mw = createAuthMiddleware(fakeService, config);
  const tokenHash = hashSessionToken(generateSessionToken());
  const auth = {
    user: { id: "u1" },
    session: { id: "s1", tokenHash, expiresAt: new Date(Date.now() + 60_000) },
  } as Request["auth"];

  function run(
    handler: (req: Request, res: Response, next: NextFunction) => void,
    req: Partial<Request>,
  ) {
    const next = vi.fn();
    handler(
      {
        get: (name: string) =>
          (req.headers as Record<string, string> | undefined)?.[name.toLowerCase()],
        ...req,
      } as Request,
      {} as Response,
      next,
    );
    return next.mock.calls[0]?.[0] as AppError | undefined;
  }

  it("requireAuth: 401 without a session, passes with one", () => {
    expect(run(mw.requireAuth, {})).toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(run(mw.requireAuth, { auth })).toBeUndefined();
  });

  it("requireCsrf: safe methods pass; unsafe methods need the session's token", () => {
    expect(run(mw.requireCsrf, { method: "GET", auth })).toBeUndefined();
    expect(run(mw.requireCsrf, { method: "POST", auth, headers: {} })).toMatchObject({
      statusCode: 403,
      code: "CSRF_TOKEN_INVALID",
    });
    expect(
      run(mw.requireCsrf, { method: "DELETE", auth, headers: { "x-csrf-token": "forged" } }),
    ).toMatchObject({ statusCode: 403 });
    const good = csrfTokenFor(config.sessionSecret, tokenHash);
    expect(
      run(mw.requireCsrf, { method: "PATCH", auth, headers: { "x-csrf-token": good } }),
    ).toBeUndefined();
  });

  it("requireCsrf fails closed when no session is attached", () => {
    const good = csrfTokenFor(config.sessionSecret, tokenHash);
    expect(
      run(mw.requireCsrf, { method: "POST", headers: { "x-csrf-token": good } }),
    ).toMatchObject({ statusCode: 403 });
  });
});

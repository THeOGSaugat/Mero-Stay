import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { clientIp, rateLimitKeyForIp } from "../../lib/client-ip.js";
import { AppError } from "../../lib/errors.js";
import type { AuthConfig } from "./auth.config.js";
import type { AuthMiddleware } from "./auth.middleware.js";
import type { PublicUser } from "./auth.repository.js";
import { loginBodySchema, registerBodySchema } from "./auth.schemas.js";
import type { AuthService, IssuedSession } from "./auth.service.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

/** Explicit fields only: a password hash can never be serialized by accident. */
export function serializeUser(user: PublicUser) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function enforce(limiter: RateLimiter, key: string, res: Response): void {
  const result = limiter.consume(key);
  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    throw new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later.", {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
}

export function createAuthController(
  service: AuthService,
  middleware: AuthMiddleware,
  config: AuthConfig,
  now: () => Date,
) {
  const limiters = {
    loginPerEmail: createRateLimiter(config.rateLimits.loginPerEmail, () => now().getTime()),
    loginPerIp: createRateLimiter(config.rateLimits.loginPerIp, () => now().getTime()),
    registerPerIp: createRateLimiter(config.rateLimits.registerPerIp, () => now().getTime()),
  };

  const cookieOptions = (expiresAt?: Date): CookieOptions => ({
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {}),
  });

  function respondWithSession(res: Response, status: number, issued: IssuedSession): void {
    res.cookie(middleware.cookieName, issued.token, cookieOptions(issued.expiresAt));
    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({
      data: {
        user: serializeUser(issued.user),
        csrfToken: issued.csrfToken,
        sessionExpiresAt: issued.expiresAt.toISOString(),
      },
    });
  }

  /**
   * The client's bucket: its IP as resolved through the trusted proxies (ADR 0014), IPv6 by /64.
   * Each action has its own limiter, so the effective key is (action, client).
   */
  const clientKey = (req: Request) => rateLimitKeyForIp(clientIp(req));

  const register: RequestHandler = async (req, res) => {
    enforce(limiters.registerPerIp, clientKey(req), res);
    const body = registerBodySchema.parse(req.body ?? {});
    respondWithSession(res, 201, await service.register(body));
  };

  const login: RequestHandler = async (req, res) => {
    enforce(limiters.loginPerIp, clientKey(req), res);
    const body = loginBodySchema.parse(req.body ?? {});
    enforce(limiters.loginPerEmail, body.email, res);
    respondWithSession(res, 200, await service.login(body, req.auth?.session.id));
  };

  const logout: RequestHandler = async (req, res) => {
    if (req.auth) await service.logout(req.auth.session.id);
    res.clearCookie(middleware.cookieName, cookieOptions());
    res.status(204).end();
  };

  const me: RequestHandler = (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Log in to continue.");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      data: {
        user: serializeUser(req.auth.user),
        csrfToken: service.csrfToken(req.auth),
        sessionExpiresAt: req.auth.session.expiresAt.toISOString(),
      },
    });
  };

  return { register, login, logout, me };
}

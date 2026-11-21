import type { RequestHandler } from "express";
import type { UserRole } from "../../generated/prisma/enums.js";
import { AppError } from "../../lib/errors.js";
import { sessionCookieName, type AuthConfig } from "./auth.config.js";
import type { AuthService } from "./auth.service.js";
import { isValidCsrfToken, parseCookies } from "./tokens.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createAuthMiddleware(service: AuthService, config: AuthConfig) {
  const cookieName = sessionCookieName(config);

  /**
   * Reads the session cookie and sets req.auth when it belongs to a valid, active session.
   * Runs once per request: routers that each guard themselves do not repeat the lookup.
   */
  const loadSession: RequestHandler = async (req, _res, next) => {
    if (req.auth) {
      next();
      return;
    }
    const token = parseCookies(req.headers.cookie).get(cookieName);
    if (token) {
      const context = await service.resolveSession(token);
      if (context) req.auth = context;
    }
    next();
  };

  /** 401 unless a valid session was loaded. */
  const requireAuth: RequestHandler = (req, _res, next) => {
    next(req.auth ? undefined : new AppError(401, "UNAUTHENTICATED", "Log in to continue."));
  };

  /**
   * CSRF defence for cookie-authenticated, state-changing requests: the X-CSRF-Token header must
   * equal HMAC(SESSION_SECRET, session). A cross-site page can make the browser send the cookie,
   * but cannot read the token, so it cannot forge the header. Safe methods are exempt.
   */
  const requireCsrf: RequestHandler = (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const presented = req.get("x-csrf-token");
    const ok =
      req.auth !== undefined &&
      typeof presented === "string" &&
      isValidCsrfToken(config.sessionSecret, req.auth.session.tokenHash, presented);
    next(
      ok
        ? undefined
        : new AppError(403, "CSRF_TOKEN_INVALID", "Missing or invalid X-CSRF-Token header."),
    );
  };

  /**
   * Login/registration accept only application/json. HTML forms cannot send JSON cross-site
   * without a CORS preflight (which this API never approves), which blocks login CSRF.
   */
  const requireJson: RequestHandler = (req, _res, next) => {
    next(
      req.is("application/json")
        ? undefined
        : new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json."),
    );
  };

  /**
   * 403 unless the session user has one of `roles`. The role comes from the users row loaded with
   * the session on this request, so a role change takes effect immediately. Run after requireAuth.
   */
  const requireRole =
    (...roles: readonly UserRole[]): RequestHandler =>
    (req, _res, next) => {
      const role = req.auth?.user.role;
      next(
        role !== undefined && roles.includes(role)
          ? undefined
          : new AppError(403, "FORBIDDEN", "Your account cannot use this endpoint."),
      );
    };

  return { loadSession, requireAuth, requireCsrf, requireRole, requireJson, cookieName };
}

export type AuthMiddleware = ReturnType<typeof createAuthMiddleware>;

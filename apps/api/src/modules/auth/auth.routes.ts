import { Router } from "express";
import type { AuthConfig } from "./auth.config.js";
import { createAuthController } from "./auth.controller.js";
import type { AuthMiddleware } from "./auth.middleware.js";
import type { AuthService } from "./auth.service.js";

/** /api/v1/auth: register, login, logout, me. */
export function createAuthRouter(deps: {
  service: AuthService;
  middleware: AuthMiddleware;
  config: AuthConfig;
  now: () => Date;
}): Router {
  const { middleware: mw } = deps;
  const controller = createAuthController(deps.service, mw, deps.config, deps.now);
  const router = Router();

  router.post("/auth/register", mw.requireJson, controller.register);
  // loadSession first so a login replaces (and revokes) any session the browser still holds.
  router.post("/auth/login", mw.requireJson, mw.loadSession, controller.login);
  router.post("/auth/logout", mw.loadSession, mw.requireAuth, mw.requireCsrf, controller.logout);
  router.get("/auth/me", mw.loadSession, mw.requireAuth, controller.me);
  return router;
}

import { Router } from "express";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import { createPaymentsController } from "./payments.controller.js";
import type { PaymentsService } from "./payments.service.js";

export interface PaymentsRouterDeps {
  service: PaymentsService;
  auth: AuthMiddleware;
}

/**
 * Customer payment endpoints, mounted under /api/v1 (ADR 0007). Guarded on their own (session,
 * 401; CSRF on writes, 403) so they stay safe whatever order routers are mounted in. Ownership is
 * enforced in the service: another user's trip or payment is a 404.
 */
export function createPaymentsRouter({ service, auth }: PaymentsRouterDeps): Router {
  const controller = createPaymentsController(service);
  const router = Router();
  const guard = [auth.loadSession, auth.requireAuth, auth.requireCsrf];

  router.get("/trips/:id/payments", guard, controller.list);
  router.post("/trips/:id/payments/intent", guard, controller.createIntent);
  router.post("/trips/:id/payments/:paymentId/confirm", guard, controller.confirm);
  return router;
}

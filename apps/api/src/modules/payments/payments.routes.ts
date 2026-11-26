import { Router } from "express";
import { limitPerClient as limitPerClientWith } from "../../lib/limit-per-client.js";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import { createPaymentsController } from "./payments.controller.js";
import type { PaymentsService } from "./payments.service.js";

export interface PaymentsRouterDeps {
  service: PaymentsService;
  auth: AuthMiddleware;
}

/** Per-client limit on payment starts and gateway callbacks (CLAUDE.md §4). */
const PAYMENT_LIMIT = { limit: 30, windowMs: 60_000 };
const limitPerClient = () => limitPerClientWith(PAYMENT_LIMIT);

/**
 * Payment endpoints, mounted under /api/v1 (ADR 0007, ADR 0017).
 *
 * - Customer endpoints: session (401) and CSRF on writes (403); another user's trip or payment is
 *   a 404 (the service scopes by owner).
 * - Gateway callbacks: no session (the customer may return in a fresh browser tab, and nothing in
 *   the request is trusted: eSewa's signature and status API, or Khalti's lookup, decide).
 */
export function createPaymentsRouter({ service, auth }: PaymentsRouterDeps): Router {
  const controller = createPaymentsController(service);
  const router = Router();
  const guard = [auth.loadSession, auth.requireAuth, auth.requireCsrf];
  const limit = limitPerClient();

  router.get("/trips/:id/payments", guard, controller.list);
  router.post("/trips/:id/payments/intent", guard, limit, controller.createIntent);
  router.post("/trips/:id/payments/:paymentId/refresh", guard, limit, controller.refresh);
  router.post("/trips/:id/payments/:paymentId/confirm", guard, controller.confirm);
  router.post("/payment-callbacks/:gateway", limit, controller.callback);
  return router;
}

import { Router } from "express";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import { createTripsController } from "./trips.controller.js";
import type { TripsService } from "./trips.service.js";

export interface TripsRouterDeps {
  service: TripsService;
  auth: AuthMiddleware;
}

/**
 * Trip and booking-item endpoints, mounted under /api/v1. ALWAYS authenticated (ADR 0006):
 * a valid session (401 otherwise) and, for state-changing requests, a valid CSRF token (403).
 * Ownership is enforced inside the service: another user's trip is a 404.
 */
export function createTripsRouter({ service, auth }: TripsRouterDeps): Router {
  const controller = createTripsController(service);
  const router = Router();

  router.use("/trips", auth.loadSession, auth.requireAuth, auth.requireCsrf);

  router.get("/trips", controller.list);
  router.post("/trips", controller.create);
  router.get("/trips/:id", controller.get);
  router.post("/trips/:id/items", controller.addItem);
  router.patch("/trips/:id/items/:itemId", controller.updateItem);
  router.delete("/trips/:id/items/:itemId", controller.removeItem);
  router.post("/trips/:id/quote", controller.quote);
  router.post("/trips/:id/confirm", controller.confirm);
  return router;
}

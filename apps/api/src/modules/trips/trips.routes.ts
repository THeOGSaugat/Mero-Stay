import { Router, type RequestHandler } from "express";
import { AppError } from "../../lib/errors.js";
import { createTripsController } from "./trips.controller.js";
import type { TripsService } from "./trips.service.js";

export interface TripsRouterDeps {
  service: TripsService;
  /**
   * Trip endpoints have NO authentication yet (a later phase) and take a temporary `userId`.
   * They are enabled by default only outside production (ADR 0005).
   */
  unauthenticatedAccessEnabled: boolean;
}

/** Trip and booking-item endpoints. Mounted under /api/v1. */
export function createTripsRouter({
  service,
  unauthenticatedAccessEnabled,
}: TripsRouterDeps): Router {
  const controller = createTripsController(service);
  const router = Router();

  const guard: RequestHandler = (_req, _res, next) => {
    if (!unauthenticatedAccessEnabled) {
      next(
        new AppError(
          403,
          "TRIPS_API_DISABLED",
          "Trip endpoints are disabled until authentication is available.",
        ),
      );
      return;
    }
    next();
  };
  router.use("/trips", guard);

  router.post("/trips", controller.create);
  router.get("/trips/:id", controller.get);
  router.post("/trips/:id/items", controller.addItem);
  router.patch("/trips/:id/items/:itemId", controller.updateItem);
  router.delete("/trips/:id/items/:itemId", controller.removeItem);
  router.post("/trips/:id/quote", controller.quote);
  router.post("/trips/:id/confirm", controller.confirm);
  return router;
}

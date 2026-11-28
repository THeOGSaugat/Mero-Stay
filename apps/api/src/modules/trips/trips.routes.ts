import { Router } from "express";
import { auditContextOf } from "../audit/audit.js";
import { currentUser } from "../auth/auth-context.js";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import {
  cancelItemBodySchema,
  serializeCancellationPreview,
  type CancellationsService,
} from "../cancellations/cancellations.service.js";
import { tripItemParamsSchema } from "./trips.schemas.js";
import { serializeTrip } from "./trips.serializers.js";
import { createTripsController } from "./trips.controller.js";
import type { TripsService } from "./trips.service.js";

export interface TripsRouterDeps {
  service: TripsService;
  cancellations: CancellationsService;
  auth: AuthMiddleware;
}

/**
 * Trip and booking-item endpoints, mounted under /api/v1. ALWAYS authenticated (ADR 0006):
 * a valid session (401 otherwise) and, for state-changing requests, a valid CSRF token (403).
 * Ownership is enforced inside the service: another user's trip is a 404.
 */
export function createTripsRouter({ service, cancellations, auth }: TripsRouterDeps): Router {
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

  // Customer cancellations (Phase 14, ADR 0020): preview what cancelling now gives back, then cancel.
  router.get("/trips/:id/items/:itemId/cancellation", async (req, res) => {
    const { id, itemId } = tripItemParamsSchema.parse(req.params);
    res.json(
      serializeCancellationPreview(await cancellations.preview(id, currentUser(req).id, itemId)),
    );
  });
  router.post("/trips/:id/items/:itemId/cancel", async (req, res) => {
    const { id, itemId } = tripItemParamsSchema.parse(req.params);
    const body = cancelItemBodySchema.parse(req.body ?? {});
    const ownerId = currentUser(req).id;
    await cancellations.cancel(auditContextOf(req), id, ownerId, itemId, body);
    res.json(serializeTrip(await service.getTrip(id, ownerId)));
  });
  return router;
}

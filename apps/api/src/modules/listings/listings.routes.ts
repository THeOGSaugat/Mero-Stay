import { Router } from "express";
import { createListingsController, type ListingsControllerDeps } from "./listings.controller.js";

/** Read-only, vertical-agnostic search endpoints. Mounted under /api/v1. */
export function createListingsRouter(deps: ListingsControllerDeps): Router {
  const controller = createListingsController(deps);
  const router = Router();
  router.get("/listing-types", controller.listTypes);
  router.get("/listings", controller.search);
  router.get("/listings/:id", controller.detail);
  return router;
}

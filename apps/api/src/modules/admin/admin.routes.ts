import { Router, type RequestHandler } from "express";
import { idParamsSchema } from "../../lib/validation.js";
import { currentUser } from "../auth/auth-context.js";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import { settleAtPropertyBodySchema } from "../payments/payments.schemas.js";
import { serializeInvoices, serializeSettlement } from "../payments/payments.serializers.js";
import type { PaymentsService } from "../payments/payments.service.js";

export interface AdminRouterDeps {
  payments: PaymentsService;
  auth: AuthMiddleware;
}

/**
 * Internal endpoints for MeroStay staff, mounted under /api/v1/admin (ADR 0007).
 *
 * Admin = the session user's role is ADMIN, re-read from the database on every request (a demoted
 * or suspended admin loses access immediately). No API can grant ADMIN: registration always
 * creates CUSTOMER accounts; an operator promotes a user directly in the database. The role is
 * checked before any data is read, so a non-admin gets the same 403 for every URL and learns
 * nothing about which trips exist. Each admin write is logged with the admin's user id.
 */
export function createAdminRouter({ payments, auth }: AdminRouterDeps): Router {
  const router = Router();
  router.use(
    "/admin",
    auth.loadSession,
    auth.requireAuth,
    auth.requireRole("ADMIN"),
    auth.requireCsrf,
  );

  const settleAtProperty: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { itemIds } = settleAtPropertyBodySchema.parse(req.body ?? {});
    const items = await payments.settleAtProperty(id, itemIds);
    req.log.info(
      {
        audit: "admin.settle_at_property",
        adminUserId: currentUser(req).id,
        tripId: id,
        settledItemIds: items.filter((item) => item.changed).map((item) => item.id),
      },
      "admin recorded pay-at-property settlement",
    );
    res.json(serializeSettlement(id, items));
  };

  const listInvoices: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(serializeInvoices(await payments.listTripInvoices(id)));
  };

  router.post("/admin/trips/:id/payments/at-property/settle", settleAtProperty);
  router.get("/admin/trips/:id/invoices", listInvoices);
  return router;
}

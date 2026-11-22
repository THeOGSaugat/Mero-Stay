import { Router } from "express";
import { idParamsSchema } from "../../lib/validation.js";
import { auditContextOf } from "../audit/audit.js";
import {
  auditLogQuerySchema,
  serializeAuditLog,
  type AuditLogService,
} from "../audit/audit-log.service.js";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import { serializeInvoicePage, serializePayoutSummary } from "../finance/finance.serializers.js";
import {
  adminInvoicesQuerySchema,
  adminPayoutsQuerySchema,
  type FinanceService,
} from "../finance/finance.service.js";
import { settleAtPropertyBodySchema } from "../payments/payments.schemas.js";
import { serializeInvoices, serializeSettlement } from "../payments/payments.serializers.js";
import type { PaymentsService } from "../payments/payments.service.js";
import {
  adminProvidersQuerySchema,
  verificationDecisionBodySchema,
  verificationDecisionParamsSchema,
} from "../providers/providers.schemas.js";
import {
  serializeAdminProvider,
  serializeAdminProviderList,
} from "../providers/providers.serializers.js";
import type { ProvidersService } from "../providers/providers.service.js";

export interface AdminRouterDeps {
  auth: AuthMiddleware;
  payments: PaymentsService;
  providers: ProvidersService;
  finance: FinanceService;
  auditLog: AuditLogService;
}

/**
 * Internal endpoints for MeroStay staff, mounted under /api/v1/admin (ADR 0007/0008).
 *
 * Admin = the session user's role is ADMIN, re-read from the database on every request. No API can
 * grant ADMIN: registration creates CUSTOMER accounts, onboarding creates PARTNER accounts, and an
 * operator promotes a user in the database. The role is checked before any data is read, so
 * everyone else gets the same 403 for every URL. Admins can read across providers; their WRITES
 * (settlement, verification decisions) each write one audit row in the same transaction.
 */
export function createAdminRouter({
  auth,
  payments,
  providers,
  finance,
  auditLog,
}: AdminRouterDeps): Router {
  const router = Router();
  router.use(
    "/admin",
    auth.loadSession,
    auth.requireAuth,
    auth.requireRole("ADMIN"),
    auth.requireCsrf,
  );

  // ------------------------------------------------------------------ trips (Phase 5)
  router.post("/admin/trips/:id/payments/at-property/settle", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { itemIds } = settleAtPropertyBodySchema.parse(req.body ?? {});
    const items = await payments.settleAtProperty(auditContextOf(req), id, itemIds);
    res.json(serializeSettlement(id, items));
  });

  router.get("/admin/trips/:id/invoices", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(serializeInvoices(await payments.listTripInvoices(id)));
  });

  // ------------------------------------------------------------------ providers
  router.get("/admin/providers", async (req, res) => {
    const query = adminProvidersQuerySchema.parse(req.query);
    const { providers: rows, total, page } = await providers.adminListProviders(query);
    res.json(serializeAdminProviderList(rows, total, page));
  });

  router.get("/admin/providers/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json({ data: serializeAdminProvider(await providers.adminGetProvider(id)) });
  });

  router.post("/admin/providers/:id/verification/:decision", async (req, res) => {
    const { id, decision } = verificationDecisionParamsSchema.parse(req.params);
    const { reason } = verificationDecisionBodySchema.parse(req.body ?? {});
    const provider = await providers.adminDecide(auditContextOf(req), id, decision, reason);
    res.json({ data: serializeAdminProvider(provider) });
  });

  // ------------------------------------------------------------------ finance (read-only)
  router.get("/admin/invoices", async (req, res) => {
    const query = adminInvoicesQuerySchema.parse(req.query);
    const { invoices, total } = await finance.listInvoices(query, query.providerId);
    res.json(serializeInvoicePage(invoices, total, query));
  });

  router.get("/admin/payouts", async (req, res) => {
    const query = adminPayoutsQuerySchema.parse(req.query);
    const { rows, total } = await finance.payoutSummary(query, query.providerId);
    res.json(serializePayoutSummary(rows, total, query));
  });

  // ------------------------------------------------------------------ audit log
  router.get("/admin/audit-log", async (req, res) => {
    const query = auditLogQuerySchema.parse(req.query);
    const { rows, total } = await auditLog.list(query);
    res.json(serializeAuditLog(rows, total, query));
  });

  return router;
}

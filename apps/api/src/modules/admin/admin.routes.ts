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
import { serializePolicy } from "../cancellation-policies/cancellation-policies.serializers.js";
import type { CancellationPoliciesService } from "../cancellation-policies/cancellation-policies.service.js";
import { sendDocumentFile } from "../providers/document-download.js";
import {
  adminDocumentParamsSchema,
  adminProvidersQuerySchema,
  verificationDecisionBodySchema,
  verificationDecisionParamsSchema,
} from "../providers/providers.schemas.js";
import {
  serializeAdminProvider,
  serializeAdminProviderList,
} from "../providers/providers.serializers.js";
import { listAllProviderTypeRules, type ProvidersService } from "../providers/providers.service.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  createRefundRequestSchema,
  reconciliationsQuerySchema,
  refundRequestsQuerySchema,
  resolveReconciliationSchema,
  type RefundsService,
} from "../refunds/refunds.service.js";
import {
  serializeReconciliation,
  serializeReconciliationPage,
  serializeRefundRequest,
  serializeRefundRequestPage,
} from "../refunds/refunds.serializers.js";

export interface AdminRouterDeps {
  prisma: PrismaClient;
  auth: AuthMiddleware;
  payments: PaymentsService;
  providers: ProvidersService;
  finance: FinanceService;
  auditLog: AuditLogService;
  policies: CancellationPoliciesService;
  refunds: RefundsService;
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
  prisma,
  auth,
  payments,
  providers,
  finance,
  auditLog,
  policies,
  refunds,
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

  // ------------------------------------------------------------------ provider types (read-only)
  router.get("/admin/provider-types", async (_req, res) => {
    res.json({ data: await listAllProviderTypeRules(prisma) });
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

  // A provider's verification document file (ADR 0016): admins only, each view audited.
  router.get("/admin/providers/:id/documents/:documentId/file", async (req, res) => {
    const { id, documentId } = adminDocumentParamsSchema.parse(req.params);
    const { doc, body } = await providers.adminReadDocumentFile(
      auditContextOf(req),
      id,
      documentId,
    );
    sendDocumentFile(res, doc, body);
  });

  // A provider's cancellation policies and default (ADR 0015): read-only.
  router.get("/admin/providers/:id/cancellation-policies", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { defaultPolicyId, policies: rows } = await policies.adminListForProvider(id);
    res.json({
      data: {
        defaultPolicyId,
        policies: rows.map(({ policy, usage }) => serializePolicy(policy, usage)),
      },
    });
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

  // ------------------------------------------------------------------ late payments (gap 8, ADR 0017)
  router.get("/admin/payment-reconciliations", async (req, res) => {
    const query = reconciliationsQuerySchema.parse(req.query);
    const { rows, total } = await refunds.listReconciliations(query);
    res.json(serializeReconciliationPage(rows, total, query));
  });

  router.post("/admin/payment-reconciliations/:id/resolve", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { note } = resolveReconciliationSchema.parse(req.body ?? {});
    const row = await refunds.resolveReconciliation(auditContextOf(req), id, note);
    res.json({ data: serializeReconciliation(row) });
  });

  // ------------------------------------------------------------------ refund requests (shape only)
  router.get("/admin/refund-requests", async (req, res) => {
    const query = refundRequestsQuerySchema.parse(req.query);
    const { rows, total } = await refunds.listRefundRequests(query);
    res.json(serializeRefundRequestPage(rows, total, query, refunds.refundCapability));
  });

  router.post("/admin/refund-requests", async (req, res) => {
    const input = createRefundRequestSchema.parse(req.body ?? {});
    const row = await refunds.createRefundRequest(auditContextOf(req), input);
    res.status(201).json({ data: serializeRefundRequest(row, refunds.refundCapability) });
  });

  // ------------------------------------------------------------------ audit log
  router.get("/admin/audit-log", async (req, res) => {
    const query = auditLogQuerySchema.parse(req.query);
    const { rows, total } = await auditLog.list(query);
    res.json(serializeAuditLog(rows, total, query));
  });

  return router;
}

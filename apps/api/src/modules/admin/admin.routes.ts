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

import {
  adminIdParamsSchema,
  createAdminSchema,
  serializeAdmin,
  serializeSetupLink,
  type AdminAccountsService,
} from "../admin-accounts/admin-accounts.service.js";
import {
  reasonSchema,
  rejectListingSchema,
  reviewQuerySchema,
  type ModerationService,
} from "../moderation/moderation.service.js";
import {
  serializeReviewEntry,
  serializeReviewPage,
  serializeVoid,
} from "../moderation/moderation.serializers.js";
import {
  generatePayoutsSchema,
  markFailedSchema,
  markPaidSchema,
  payoutsListQuerySchema,
  type PayoutsService,
} from "../payouts/payouts.service.js";
import {
  serializePayout,
  serializePayoutChanges,
  serializePayoutDetail,
  serializePayoutPage,
} from "../payouts/payouts.serializers.js";

export interface AdminRouterDeps {
  prisma: PrismaClient;
  auth: AuthMiddleware;
  payments: PaymentsService;
  providers: ProvidersService;
  finance: FinanceService;
  auditLog: AuditLogService;
  policies: CancellationPoliciesService;
  refunds: RefundsService;
  payouts: PayoutsService;
  adminAccounts: AdminAccountsService;
  moderation: ModerationService;
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
  payouts,
  adminAccounts,
  moderation,
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

  // ------------------------------------------------------------------ payout batches (gap 16, ADR 0018)
  router.post("/admin/payout-batches/generate", async (req, res) => {
    const { period } = generatePayoutsSchema.parse(req.body ?? {});
    res.json(serializePayoutChanges(await payouts.generate(auditContextOf(req), period)));
  });

  router.get("/admin/payout-batches", async (req, res) => {
    const query = payoutsListQuerySchema.parse(req.query);
    const { rows, total } = await payouts.list(query);
    res.json(serializePayoutPage(rows, total, query));
  });

  router.get("/admin/payout-batches/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { payout, items } = await payouts.get(id);
    res.json(serializePayoutDetail(payout, items));
  });

  router.post("/admin/payout-batches/:id/schedule", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { payout, changed } = await payouts.schedule(auditContextOf(req), id);
    res.json({ data: { changed, payout: serializePayout(payout) } });
  });

  router.post("/admin/payout-batches/:id/mark-paid", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { bankReference } = markPaidSchema.parse(req.body ?? {});
    const { payout, changed } = await payouts.markPaid(auditContextOf(req), id, bankReference);
    res.json({ data: { changed, payout: serializePayout(payout) } });
  });

  router.post("/admin/payout-batches/:id/mark-failed", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { reason } = markFailedSchema.parse(req.body ?? {});
    const { payout, changed } = await payouts.markFailed(auditContextOf(req), id, reason);
    res.json({ data: { changed, payout: serializePayout(payout) } });
  });

  router.post("/admin/providers/:id/payout-account/verify", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const result = await moderation.verifyPayoutAccount(auditContextOf(req), id);
    res.json({
      data: {
        changed: result.changed,
        payoutAccountLabel: result.label,
        verifiedAt: result.verifiedAt.toISOString(),
      },
    });
  });

  // ------------------------------------------------------------------ admin accounts (gap 9)
  router.get("/admin/admins", async (_req, res) => {
    res.json({ data: (await adminAccounts.list()).map(serializeAdmin) });
  });

  router.post("/admin/admins", async (req, res) => {
    const input = createAdminSchema.parse(req.body ?? {});
    const { admin, link } = await adminAccounts.create(auditContextOf(req), input);
    res.setHeader("Cache-Control", "no-store");
    res
      .status(201)
      .json({ data: { admin: serializeAdmin(admin), setupLink: serializeSetupLink(link) } });
  });

  router.post("/admin/admins/:id/setup-link", async (req, res) => {
    const { id } = adminIdParamsSchema.parse(req.params);
    const link = await adminAccounts.newSetupLink(auditContextOf(req), id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { setupLink: serializeSetupLink(link) } });
  });

  router.post("/admin/admins/:id/suspend", async (req, res) => {
    const { id } = adminIdParamsSchema.parse(req.params);
    const { admin, changed } = await adminAccounts.setStatus(auditContextOf(req), id, "SUSPENDED");
    res.json({ data: { changed, admin: serializeAdmin(admin) } });
  });

  router.post("/admin/admins/:id/reactivate", async (req, res) => {
    const { id } = adminIdParamsSchema.parse(req.params);
    const { admin, changed } = await adminAccounts.setStatus(auditContextOf(req), id, "ACTIVE");
    res.json({ data: { changed, admin: serializeAdmin(admin) } });
  });

  // ------------------------------------------------------------------ listing review (gap 15)
  router.get("/admin/listings", async (req, res) => {
    const query = reviewQuerySchema.parse(req.query);
    const { entries, total } = await moderation.listForReview(query);
    res.json(serializeReviewPage(entries, total, query));
  });

  router.get("/admin/listings/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json({ data: serializeReviewEntry(await moderation.getForReview(id)) });
  });

  router.post("/admin/listings/:id/approve", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { changed } = await moderation.approveListing(auditContextOf(req), id);
    res.json({
      data: { changed, listing: serializeReviewEntry(await moderation.getForReview(id)) },
    });
  });

  router.post("/admin/listings/:id/reject", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { reason } = rejectListingSchema.parse(req.body ?? {});
    const { changed } = await moderation.rejectListing(auditContextOf(req), id, reason);
    res.json({
      data: { changed, listing: serializeReviewEntry(await moderation.getForReview(id)) },
    });
  });

  // ------------------------------------------------------------------ voids and corrections (gap 13)
  router.post("/admin/booking-items/:id/void", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { reason } = reasonSchema.parse(req.body ?? {});
    res.json(serializeVoid(await moderation.voidItem(auditContextOf(req), id, reason)));
  });

  router.post("/admin/trips/:id/void", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { reason } = reasonSchema.parse(req.body ?? {});
    res.json(serializeVoid(await moderation.voidTrip(auditContextOf(req), id, reason)));
  });

  router.post("/admin/booking-items/:id/settlement/reverse", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { reason } = reasonSchema.parse(req.body ?? {});
    const result = await moderation.reverseSettlement(auditContextOf(req), id, reason);
    res.json({ data: result });
  });

  return router;
}

import { raw, Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { idempotencyKeyOf, type IdempotentResult } from "../../lib/idempotency.js";
import { idParamsSchema, uuidSchema } from "../../lib/validation.js";
import { auditContextOf } from "../audit/audit.js";
import { currentUser } from "../auth/auth-context.js";
import type { AuthMiddleware } from "../auth/auth.middleware.js";
import {
  providerBookingsQuerySchema,
  type ProviderBookingsService,
} from "../bookings/provider-bookings.service.js";
import {
  serializeProviderBooking,
  serializeProviderBookingDetail,
  serializeProviderBookingList,
} from "../bookings/provider-bookings.serializers.js";
import { serializeInvoicePage, serializePayoutSummary } from "../finance/finance.serializers.js";
import {
  invoicesQuerySchema,
  payoutsQuerySchema,
  type FinanceService,
} from "../finance/finance.service.js";
import {
  createSlotsBodySchema,
  slotsQuerySchema,
  updateSlotsBodySchema,
  type InventoryService,
} from "../inventory/inventory.service.js";
import { serializeSlots } from "../inventory/inventory.serializers.js";
import {
  createListingBodySchema,
  listListingsQuerySchema,
  updateListingBodySchema,
} from "../listings/listing-management.schemas.js";
import {
  serializeManagedListing,
  serializeManagedListingList,
} from "../listings/listing-management.serializers.js";
import type { ListingManagementService } from "../listings/listing-management.service.js";
import {
  createPolicyBodySchema,
  defaultPolicyBodySchema,
  updatePolicyBodySchema,
} from "../cancellation-policies/cancellation-policies.schemas.js";
import { serializePolicy } from "../cancellation-policies/cancellation-policies.serializers.js";
import type { CancellationPoliciesService } from "../cancellation-policies/cancellation-policies.service.js";
import { sendDocumentFile } from "../providers/document-download.js";
import {
  DOCUMENT_MIME_TYPES,
  documentBodySchema,
  documentParamsSchema,
  MAX_DOCUMENT_BYTES,
  onboardingBodySchema,
  profilePatchSchema,
} from "../providers/providers.schemas.js";
import { serializeDocument, serializeProfile } from "../providers/providers.serializers.js";
import type { ProvidersService } from "../providers/providers.service.js";
import { createPartnerContext, currentPartner } from "./partner-context.js";

import { payoutsListQuerySchema, type PayoutsService } from "../payouts/payouts.service.js";
import { serializePayoutDetail, serializePayoutPage } from "../payouts/payouts.serializers.js";

export interface PartnerRouterDeps {
  prisma: PrismaClient;
  auth: AuthMiddleware;
  providers: ProvidersService;
  listings: ListingManagementService;
  inventory: InventoryService;
  bookings: ProviderBookingsService;
  finance: FinanceService;
  policies: CancellationPoliciesService;
  payouts: PayoutsService;
}

const itemParamsSchema = z.object({ itemId: uuidSchema }).strict();

/** Marks a retried write answered from the first result (Idempotency-Key). */
function markReplay(res: Response, result: IdempotentResult): void {
  if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
}

/**
 * Partner endpoints, mounted under /api/v1 (ADR 0008).
 *
 * - Every /partner URL needs a session (401) and, for writes, the CSRF token (403).
 * - Onboarding is open to customers (that is how one becomes a partner).
 * - Everything else needs role PARTNER (403 before any data is read) and acts for the partner's
 *   provider (partner-context.ts); another provider's data is a 404.
 */
export function createPartnerRouter(deps: PartnerRouterDeps): Router {
  const { auth, providers, listings, inventory, bookings, finance, policies, payouts } = deps;
  const router = Router();
  router.use("/partner", auth.loadSession, auth.requireAuth, auth.requireCsrf);

  // -------------------------------------------------------------- onboarding (customers)
  const onboard: RequestHandler = async (req, res) => {
    const body = onboardingBodySchema.parse(req.body ?? {});
    const result = await providers.onboard(auditContextOf(req), body, idempotencyKeyOf(req, false));
    markReplay(res, result);
    const profile = await providers.getProfile(result.resourceId);
    res.status(result.status).location("/api/v1/partner/profile").json(serializeProfile(profile));
  };
  router.post("/partner/onboarding", auth.requireRole("CUSTOMER", "PARTNER"), onboard);

  // -------------------------------------------------------------- partner only
  router.use("/partner", auth.requireRole("PARTNER"), createPartnerContext(deps.prisma));

  router.get("/partner/profile", async (req, res) => {
    res.json(serializeProfile(await providers.getProfile(currentPartner(req).providerId)));
  });

  router.patch("/partner/profile", async (req, res) => {
    const patch = profilePatchSchema.parse(req.body ?? {});
    const profile = await providers.updateProfile(
      auditContextOf(req),
      currentPartner(req).providerId,
      patch,
    );
    res.json(serializeProfile(profile));
  });

  router.post("/partner/verification/submit", async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const { provider, changed } = await providers.submitForVerification(
      auditContextOf(req),
      currentPartner(req).providerId,
    );
    res.json({ data: { changed, provider: serializeProfile(provider).data } });
  });

  router.get("/partner/verification-documents", async (req, res) => {
    const docs = await providers.listDocuments(currentPartner(req).providerId);
    res.json({ data: docs.map(serializeDocument) });
  });

  // Verification documents (ADR 0016): request → upload the file → confirm. Private: the owner
  // (and admins) can fetch the file through the API; no storage key or URL is ever sent.
  router.post("/partner/verification-documents", async (req, res) => {
    const body = documentBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    const result = await providers.requestDocumentUpload(
      auditContextOf(req),
      partner.providerId,
      partner.providerStatus,
      body,
      idempotencyKeyOf(req, false),
    );
    markReplay(res, result);
    const doc = await providers.getDocument(partner.providerId, result.resourceId);
    res.status(result.status).json({
      data: serializeDocument(doc),
      upload: {
        method: "PUT",
        path: `/api/v1/partner/verification-documents/${doc.id}/file`,
        contentType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
      },
    });
  });

  router.put(
    "/partner/verification-documents/:id/file",
    raw({ type: [...DOCUMENT_MIME_TYPES], limit: MAX_DOCUMENT_BYTES }),
    async (req, res) => {
      const { id } = documentParamsSchema.parse(req.params);
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Send the file itself as application/pdf, image/jpeg or image/png.",
        );
      }
      const partner = currentPartner(req);
      await providers.uploadDocumentFile(
        auditContextOf(req),
        partner.providerId,
        partner.providerStatus,
        id,
        req.body,
        req.headers["content-type"],
      );
      res.json({ data: serializeDocument(await providers.getDocument(partner.providerId, id)) });
    },
  );

  router.post("/partner/verification-documents/:id/confirm", async (req, res) => {
    const { id } = documentParamsSchema.parse(req.params);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const partner = currentPartner(req);
    const { changed } = await providers.confirmDocument(
      auditContextOf(req),
      partner.providerId,
      partner.providerStatus,
      id,
    );
    const doc = await providers.getDocument(partner.providerId, id);
    res.json({ data: { changed, document: serializeDocument(doc) } });
  });

  router.get("/partner/verification-documents/:id/file", async (req, res) => {
    const { id } = documentParamsSchema.parse(req.params);
    const { doc, body } = await providers.readDocumentFile(currentPartner(req).providerId, id);
    sendDocumentFile(res, doc, body);
  });

  router.delete("/partner/verification-documents/:id", async (req, res) => {
    const { id } = documentParamsSchema.parse(req.params);
    const partner = currentPartner(req);
    const { objectRemoved } = await providers.deleteDocument(
      auditContextOf(req),
      partner.providerId,
      partner.providerStatus,
      id,
    );
    if (!objectRemoved) {
      // The record is a tombstone either way; the orphaned object is left for a clean-up.
      req.log.warn({ documentId: id }, "Deleted document's stored object could not be removed");
    }
    res.status(204).end();
  });

  // Cancellation policies (ADR 0015): the provider's own, with where each is used.
  router.get("/partner/cancellation-policies", async (req, res) => {
    const { defaultPolicyId, policies: rows } = await policies.listOwn(
      currentPartner(req).providerId,
    );
    res.json({
      data: {
        defaultPolicyId,
        policies: rows.map(({ policy, usage }) => serializePolicy(policy, usage)),
      },
    });
  });

  router.post("/partner/cancellation-policies", async (req, res) => {
    const body = createPolicyBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    const result = await policies.create(
      auditContextOf(req),
      partner.providerId,
      partner.providerStatus,
      body,
      idempotencyKeyOf(req, false),
    );
    markReplay(res, result);
    const { policy, usage } = await policies.getOwn(partner.providerId, result.resourceId);
    res.status(result.status).json({ data: serializePolicy(policy, usage) });
  });

  router.put("/partner/cancellation-policies/default", async (req, res) => {
    const { policyId } = defaultPolicyBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    const { changed } = await policies.setProviderDefault(
      auditContextOf(req),
      partner.providerId,
      partner.providerStatus,
      policyId,
    );
    res.json({ data: { changed, defaultPolicyId: policyId } });
  });

  router.get("/partner/cancellation-policies/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { policy, usage } = await policies.getOwn(currentPartner(req).providerId, id);
    res.json({ data: serializePolicy(policy, usage) });
  });

  router.patch("/partner/cancellation-policies/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const patch = updatePolicyBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    await policies.update(
      auditContextOf(req),
      partner.providerId,
      partner.providerStatus,
      id,
      patch,
    );
    const { policy, usage } = await policies.getOwn(partner.providerId, id);
    res.json({ data: serializePolicy(policy, usage) });
  });

  // -------------------------------------------------------------- listings and inventory
  router.get("/partner/listings", async (req, res) => {
    const query = listListingsQuerySchema.parse(req.query);
    const { listings: rows, total } = await listings.list(currentPartner(req).providerId, query);
    res.json(serializeManagedListingList(rows, total, query));
  });

  router.post("/partner/listings", async (req, res) => {
    const body = createListingBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    const result = await listings.create(
      partner,
      currentUser(req).id,
      body,
      idempotencyKeyOf(req, false),
    );
    markReplay(res, result);
    const listing = await listings.get(partner.providerId, result.resourceId);
    res
      .status(result.status)
      .location(`/api/v1/partner/listings/${listing.id}`)
      .json({ data: serializeManagedListing(listing) });
  });

  router.get("/partner/listings/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json({
      data: serializeManagedListing(await listings.get(currentPartner(req).providerId, id)),
    });
  });

  router.patch("/partner/listings/:id", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const patch = updateListingBodySchema.parse(req.body ?? {});
    res.json({
      data: serializeManagedListing(await listings.update(currentPartner(req), id, patch)),
    });
  });

  router.get("/partner/listings/:id/slots", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { startDate, endDate } = slotsQuerySchema.parse(req.query);
    const { listing, slots } = await inventory.list(
      currentPartner(req).providerId,
      id,
      startDate,
      endDate,
    );
    res.json(serializeSlots(listing, slots));
  });

  router.post("/partner/listings/:id/slots", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = createSlotsBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    const counts = await inventory.create(partner, id, body);
    const { listing, slots } = await inventory.list(
      partner.providerId,
      id,
      body.startDate,
      body.endDate,
    );
    const out = serializeSlots(listing, slots);
    res.status(counts.created > 0 ? 201 : 200).json({ data: { ...out.data, ...counts } });
  });

  router.patch("/partner/listings/:id/slots", async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = updateSlotsBodySchema.parse(req.body ?? {});
    const partner = currentPartner(req);
    const counts = await inventory.update(partner, id, body);
    const { listing, slots } = await inventory.list(
      partner.providerId,
      id,
      body.startDate,
      body.endDate,
    );
    const out = serializeSlots(listing, slots);
    res.json({ data: { ...out.data, ...counts } });
  });

  // -------------------------------------------------------------- bookings, invoices, payouts
  router.get("/partner/bookings", async (req, res) => {
    const query = providerBookingsQuerySchema.parse(req.query);
    const { items, total } = await bookings.list(currentPartner(req).providerId, query);
    res.json(serializeProviderBookingList(items, total, query));
  });

  router.get("/partner/bookings/:itemId", async (req, res) => {
    const { itemId } = itemParamsSchema.parse(req.params);
    res.json(
      serializeProviderBookingDetail(await bookings.get(currentPartner(req).providerId, itemId)),
    );
  });

  router.post("/partner/bookings/:itemId/settle-at-property", async (req, res) => {
    const { itemId } = itemParamsSchema.parse(req.params);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const partner = currentPartner(req);
    const result = await bookings.settleAtProperty(
      auditContextOf(req),
      partner,
      itemId,
      idempotencyKeyOf(req, true) as string,
    );
    markReplay(res, result);
    const item = await bookings.get(partner.providerId, itemId);
    res.status(result.status).json({
      data: { replayed: result.replayed, booking: serializeProviderBooking(item) },
    });
  });

  router.get("/partner/invoices", async (req, res) => {
    const query = invoicesQuerySchema.parse(req.query);
    const { invoices, total } = await finance.listInvoices(query, currentPartner(req).providerId);
    res.json(serializeInvoicePage(invoices, total, query));
  });

  router.get("/partner/payouts", async (req, res) => {
    const query = payoutsQuerySchema.parse(req.query);
    const { rows, total } = await finance.payoutSummary(query, currentPartner(req).providerId);
    res.json(serializePayoutSummary(rows, total, query));
  });

  // Own payout batches (Phase 12, ADR 0018): read-only; another provider's is a 404.
  router.get("/partner/payout-batches", async (req, res) => {
    const query = payoutsListQuerySchema.parse(req.query);
    const { rows, total } = await payouts.list(query, currentPartner(req).providerId);
    res.json(serializePayoutPage(rows, total, query));
  });

  router.get("/partner/payout-batches/:id", async (req, res) => {
    const { id } = z.object({ id: uuidSchema }).strict().parse(req.params);
    const { payout, items } = await payouts.get(id, currentPartner(req).providerId);
    res.json(serializePayoutDetail(payout, items));
  });

  return router;
}

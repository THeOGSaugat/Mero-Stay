import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import {
  assertCommissionTransition,
  assertItemTransition,
  canWaivePaidOutCommission,
} from "../../domain/booking-item-status.js";
import { clawbackAmount } from "../../domain/clawbacks.js";
import { canReverseSettlement, planVoid } from "../../domain/booking-void.js";
import { decideListingType } from "../../domain/listing-rules.js";
import { maskAccountNumber } from "../../domain/masking.js";
import { AppError } from "../../lib/errors.js";
import { paginationShape, searchShape, skipTake } from "../../lib/pagination.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { providerTypeRules } from "../listings/listing-management.service.js";
import { refreshPayoutSums } from "../payouts/payouts.service.js";
import { adjustInvoiceForWaivedItem } from "../finance/invoice-adjustments.js";
import { settleTripAfterCancellations } from "../trips/trip-settlement.js";
import { lockTrip } from "../trips/trips.repository.js";

/**
 * Admin moderation (Phase 12, ADR 0018):
 * - listing review (gap 15): PENDING_REVIEW → APPROVED | REJECTED (with a reason). Approval
 *   re-checks the provider-type → listing-type rule (ADR 0013), here and in the database;
 * - voids and corrections (gap 13): void a booking item or a whole trip (CANCELLED, inventory
 *   released, commission waived, online money queued as refund REQUESTS, invoiced commission
 *   adjusted, never the invoice edited); undo a mistaken pay-at-property settlement;
 * - verifying a provider's payout bank account (needed before a payout can be scheduled).
 * All writes are audited and idempotent (repeating one changes nothing).
 */

export const reviewQuerySchema = z
  .object({
    ...paginationShape,
    ...searchShape,
    status: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).default("PENDING_REVIEW"),
  })
  .strict();
export const rejectListingSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(400) }).strict();

const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

const LISTING_INCLUDE = {
  provider: { select: { id: true, displayName: true, providerTypeCode: true, status: true } },
  listingType: { select: { code: true, isActive: true } },
  location: { select: { id: true, name: true, slug: true } },
} as const;
export type ReviewListingRow = Prisma.ListingGetPayload<{ include: typeof LISTING_INCLUDE }>;

export interface ReviewEntry {
  listing: ReviewListingRow;
  /** Whether approval would pass the listing-type rule right now (UI hint; approval re-checks). */
  typeRule: { allowed: boolean; reason: string | null; allowedListingTypes: string[] };
}

const listingNotFound = () => new AppError(404, "LISTING_NOT_FOUND", "Listing not found.");
const itemNotFound = () => new AppError(404, "ITEM_NOT_FOUND", "Booking item not found.");

export function createModerationService({
  prisma,
  now,
}: {
  prisma: PrismaClient;
  now: () => Date;
}) {
  async function typeRuleOf(
    db: Prisma.TransactionClient | PrismaClient,
    listing: { providerId: string; listingType: { code: string; isActive: boolean } },
  ) {
    const decision = decideListingType(
      await providerTypeRules(db, listing.providerId),
      listing.listingType,
    );
    return decision.ok
      ? { allowed: true, reason: null, allowedListingTypes: [] as string[], decision }
      : { allowed: false, reason: decision.reason, allowedListingTypes: decision.usable, decision };
  }

  // ------------------------------------------------------------------ listing review (gap 15)
  async function listForReview(query: z.infer<typeof reviewQuerySchema>) {
    const where: Prisma.ListingWhereInput = {
      status: query.status,
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" } },
              { provider: { displayName: { contains: query.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: LISTING_INCLUDE,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        ...skipTake(query),
      }),
      prisma.listing.count({ where }),
    ]);
    const entries: ReviewEntry[] = [];
    for (const listing of rows) {
      const { decision: _ignored, ...typeRule } = await typeRuleOf(prisma, listing);
      entries.push({ listing, typeRule });
    }
    return { entries, total };
  }

  async function getForReview(id: string): Promise<ReviewEntry> {
    const listing = await prisma.listing.findUnique({ where: { id }, include: LISTING_INCLUDE });
    if (!listing) throw listingNotFound();
    const { decision: _ignored, ...typeRule } = await typeRuleOf(prisma, listing);
    return { listing, typeRule };
  }

  async function lockListing(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM listings WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw listingNotFound();
    return tx.listing.findUniqueOrThrow({ where: { id }, include: LISTING_INCLUDE });
  }

  async function approveListing(ctx: AuditContext, id: string) {
    return prisma.$transaction(async (tx) => {
      const listing = await lockListing(tx, id);
      if (listing.status === "APPROVED") return { listing, changed: false };
      if (listing.status !== "PENDING_REVIEW") {
        throw new AppError(
          409,
          "LISTING_NOT_IN_REVIEW",
          `This listing is ${listing.status}, not waiting for review.`,
        );
      }
      // Gap 22 / ADR 0013: the type must still be allowed for this provider (mapping and both types active).
      const rule = await typeRuleOf(tx, listing);
      if (!rule.allowed) {
        throw new AppError(
          422,
          rule.decision.ok ? "LISTING_TYPE_NOT_ALLOWED" : rule.decision.code,
          "This listing's type is not allowed for this kind of business, so it cannot be approved.",
          {
            listingTypeCode: listing.listingTypeCode,
            providerTypeCode: listing.provider.providerTypeCode,
            reason: rule.reason,
            allowedListingTypes: rule.allowedListingTypes,
          },
        );
      }
      const updated = await tx.listing.update({
        where: { id },
        data: {
          status: "APPROVED",
          reviewedAt: now(),
          reviewedById: ctx.actorUserId,
          reviewNote: null,
          publishedAt: listing.publishedAt ?? now(),
        },
        include: LISTING_INCLUDE,
      });
      await recordAudit(tx, ctx, {
        action: "listing.approve",
        entityType: "listing",
        entityId: id,
        before: { status: listing.status },
        after: { status: "APPROVED" },
      });
      return { listing: updated, changed: true };
    }, TX_OPTIONS);
  }

  async function rejectListing(ctx: AuditContext, id: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const listing = await lockListing(tx, id);
      if (listing.status === "REJECTED") return { listing, changed: false };
      if (listing.status !== "PENDING_REVIEW") {
        throw new AppError(
          409,
          "LISTING_NOT_IN_REVIEW",
          `This listing is ${listing.status}, not waiting for review.`,
        );
      }
      const updated = await tx.listing.update({
        where: { id },
        data: {
          status: "REJECTED",
          reviewedAt: now(),
          reviewedById: ctx.actorUserId,
          reviewNote: reason,
        },
        include: LISTING_INCLUDE,
      });
      await recordAudit(tx, ctx, {
        action: "listing.reject",
        entityType: "listing",
        entityId: id,
        before: { status: listing.status },
        after: { status: "REJECTED", reason },
      });
      return { listing: updated, changed: true };
    }, TX_OPTIONS);
  }

  // ------------------------------------------------------------------ voids (gap 13)
  async function loadItem(tx: Prisma.TransactionClient, itemId: string) {
    return tx.bookingItem.findUnique({
      where: { id: itemId },
      include: {
        slots: true,
        payout: { select: { id: true, status: true } },
        allocations: {
          include: {
            payment: {
              select: { id: true, kind: true, status: true, gateway: true, currency: true },
            },
          },
        },
      },
    });
  }

  /** Voids one item inside the caller's transaction (trip already locked). */
  async function voidLocked(
    tx: Prisma.TransactionClient,
    ctx: AuditContext,
    itemId: string,
    reason: string,
  ): Promise<{
    itemId: string;
    changed: boolean;
    refundRequests: number;
    invoiceAdjusted: boolean;
    clawbackMinor: bigint | null;
    currency: string;
  }> {
    const item = await loadItem(tx, itemId);
    if (!item) throw itemNotFound();
    const plan = planVoid({
      status: item.status,
      paymentStatus: item.paymentStatus,
      commissionStatus: item.commissionStatus,
      payoutStatus: item.payoutStatus,
      payoutBatchStatus: item.payout?.status ?? null,
      voided: item.voidedAt !== null,
    });
    if (!plan.ok) {
      if (plan.refusal === "ALREADY_VOIDED") {
        return {
          itemId,
          changed: false,
          refundRequests: 0,
          invoiceAdjusted: false,
          clawbackMinor: null,
          currency: item.currency,
        };
      }
      const message = {
        NOT_VOIDABLE_STATUS: `This item is ${item.status}; only pending or confirmed bookings can be voided.`,
        IN_SCHEDULED_PAYOUT:
          "This item is in a scheduled payout. Record that payout as paid or failed first.",
      }[plan.refusal];
      throw new AppError(409, `ITEM_${plan.refusal}`, message, { itemId });
    }
    const at = now();

    // 1. Give the held inventory back.
    if (plan.releaseInventory) {
      for (const slot of item.slots) {
        if (!slot.inventorySlotId) continue;
        await tx.inventorySlot.update({
          where: { id: slot.inventorySlotId },
          data: { capacityBooked: { decrement: slot.units } },
        });
      }
    }
    // 2. Out of an open payout batch.
    if (plan.leavePendingPayout && item.payoutId) {
      await tx.bookingItem.update({ where: { id: itemId }, data: { payoutId: null } });
      await refreshPayoutSums(tx, item.payoutId);
    }
    // 3. The item itself: cancelled, commission waived.
    assertItemTransition(item.status, "CANCELLED");
    if (plan.commission !== "KEEP" && !(plan.clawback && canWaivePaidOutCommission(item))) {
      assertCommissionTransition(item.commissionStatus, "WAIVED", item.paymentStatus);
    }
    await tx.bookingItem.update({
      where: { id: itemId },
      data: {
        status: "CANCELLED",
        cancelledAt: at,
        voidedAt: at,
        voidedById: ctx.actorUserId,
        voidReason: reason,
        ...(plan.commission !== "KEEP" ? { commissionStatus: "WAIVED" as const } : {}),
      },
    });
    // 4. Invoiced commission: an adjustment (the issued invoice never changes); fully adjusted → VOID.
    let invoiceAdjusted = false;
    if (plan.commission === "WAIVE_AND_ADJUST_INVOICE" && item.commissionInvoiceId) {
      await adjustInvoiceForWaivedItem(
        tx,
        { ...item, commissionInvoiceId: item.commissionInvoiceId },
        `Booking voided: ${reason}`,
        ctx.actorUserId,
      );
      invoiceAdjusted = true;
    }
    // 5. Online money: one refund REQUEST per succeeded charge that paid this item (not executed).
    let refundRequests = 0;
    if (plan.requestRefund) {
      for (const allocation of item.allocations) {
        if (allocation.payment.kind !== "CHARGE" || allocation.payment.status !== "SUCCEEDED")
          continue;
        await tx.refundRequest.create({
          data: {
            paymentId: allocation.paymentId,
            bookingItemId: itemId,
            gateway: allocation.payment.gateway,
            amountMinor: allocation.amountMinor,
            currency: allocation.payment.currency,
            reason: `Booking voided: ${reason}`.slice(0, 500),
            requestedById: ctx.actorUserId,
          },
        });
        refundRequests += 1;
      }
    }
    // 6. Paid out already (gap 39): the provider owes back what its batch paid for this item,
    //    deducted from later payouts. The past payout itself never changes.
    let clawbackMinor: bigint | null = null;
    if (plan.clawback && item.payoutId) {
      clawbackMinor = clawbackAmount(item);
      if (clawbackMinor > 0n) {
        await tx.providerClawback.create({
          data: {
            providerId: item.providerId,
            bookingItemId: itemId,
            payoutId: item.payoutId,
            currency: item.currency,
            amountMinor: clawbackMinor,
            reason: `Paid-out booking voided: ${reason}`.slice(0, 500),
            createdById: ctx.actorUserId,
          },
        });
      }
    }
    await recordAudit(tx, ctx, {
      action: "booking_item.void",
      entityType: "booking_item",
      entityId: itemId,
      before: {
        status: item.status,
        paymentStatus: item.paymentStatus,
        commissionStatus: item.commissionStatus,
        payoutId: item.payoutId,
      },
      after: {
        status: "CANCELLED",
        reason,
        commissionStatus: plan.commission !== "KEEP" ? "WAIVED" : item.commissionStatus,
        refundRequests,
        invoiceAdjusted,
        clawbackMinor: clawbackMinor?.toString() ?? null,
      },
    });
    return {
      itemId,
      changed: true,
      refundRequests,
      invoiceAdjusted,
      clawbackMinor,
      currency: item.currency,
    };
  }

  /** Trip totals and status after voids (shared with customer cancellations). */
  async function settleTrip(tx: Prisma.TransactionClient, tripId: string): Promise<void> {
    await settleTripAfterCancellations(tx, tripId, now());
  }

  async function voidItem(ctx: AuditContext, itemId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const ref = await tx.bookingItem.findUnique({
        where: { id: itemId },
        select: { tripId: true },
      });
      if (!ref) throw itemNotFound();
      await lockTrip(tx, ref.tripId);
      const result = await voidLocked(tx, ctx, itemId, reason);
      if (result.changed) await settleTrip(tx, ref.tripId);
      return { tripId: ref.tripId, items: [result] };
    }, TX_OPTIONS);
  }

  /** Voids every pending or confirmed item of a trip, all or nothing. */
  async function voidTrip(ctx: AuditContext, tripId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      if (!(await lockTrip(tx, tripId))) {
        throw new AppError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      const items = await tx.bookingItem.findMany({
        where: { tripId, status: { in: ["PENDING", "CONFIRMED"] }, voidedAt: null },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      const results = [];
      for (const item of items) results.push(await voidLocked(tx, ctx, item.id, reason));
      if (results.some((r) => r.changed)) await settleTrip(tx, tripId);
      return { tripId, items: results };
    }, TX_OPTIONS);
  }

  /** Correction: undo a pay-at-property settlement recorded by mistake (money snapshots unchanged). */
  async function reverseSettlement(ctx: AuditContext, itemId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const ref = await tx.bookingItem.findUnique({
        where: { id: itemId },
        select: { tripId: true },
      });
      if (!ref) throw itemNotFound();
      await lockTrip(tx, ref.tripId);
      const item = await tx.bookingItem.findUniqueOrThrow({ where: { id: itemId } });
      if (item.paymentStatus === "PAY_AT_PROPERTY") return { itemId, changed: false };
      if (!canReverseSettlement(item)) {
        throw new AppError(
          409,
          "ITEM_NOT_SETTLED",
          "This item has no pay-at-property settlement to undo.",
        );
      }
      await tx.bookingItem.update({
        where: { id: itemId },
        data: {
          paymentStatus: "PAY_AT_PROPERTY",
          paymentSettledAt: null,
          paymentSettledById: null,
        },
      });
      await recordAudit(tx, ctx, {
        action: "booking_item.settlement.reverse",
        entityType: "booking_item",
        entityId: itemId,
        before: {
          paymentStatus: item.paymentStatus,
          settledAt: item.paymentSettledAt,
          settledById: item.paymentSettledById,
        },
        after: { paymentStatus: "PAY_AT_PROPERTY", reason },
      });
      return { itemId, changed: true };
    }, TX_OPTIONS);
  }

  // ------------------------------------------------------------------ payout accounts
  /** Marks a provider's default bank account verified (checked by MeroStay out of band). */
  async function verifyPayoutAccount(ctx: AuditContext, providerId: string) {
    return prisma.$transaction(async (tx) => {
      const account = await tx.providerPayoutAccount.findFirst({
        where: { providerId, isDefault: true },
      });
      if (!account) {
        throw new AppError(404, "PAYOUT_ACCOUNT_NOT_FOUND", "This provider has no bank account.");
      }
      const label = `${account.bankName} · ${maskAccountNumber(account.accountNumber)}`;
      if (account.verifiedAt) return { label, verifiedAt: account.verifiedAt, changed: false };
      const verifiedAt = now();
      await tx.providerPayoutAccount.update({ where: { id: account.id }, data: { verifiedAt } });
      await recordAudit(tx, ctx, {
        action: "provider.payout_account.verify",
        entityType: "provider",
        entityId: providerId,
        after: { payoutAccountLabel: label, verifiedAt },
      });
      return { label, verifiedAt, changed: true };
    });
  }

  return {
    listForReview,
    getForReview,
    approveListing,
    rejectListing,
    voidItem,
    voidTrip,
    reverseSettlement,
    verifyPayoutAccount,
  };
}

export type ModerationService = ReturnType<typeof createModerationService>;

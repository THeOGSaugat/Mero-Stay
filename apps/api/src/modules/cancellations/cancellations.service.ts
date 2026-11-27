import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import {
  assertCommissionTransition,
  assertItemTransition,
  isPayAtProperty,
} from "../../domain/booking-item-status.js";
import {
  planCustomerCancellation,
  ruleFromSnapshot,
  splitRefund,
  toNepalLocal,
  type CancelPlan,
  type CancelRefusal,
} from "../../domain/refunds.js";
import { AppError } from "../../lib/errors.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { minorAmountInputSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { adjustInvoiceForWaivedItem } from "../finance/invoice-adjustments.js";
import { settleTripAfterCancellations } from "../trips/trip-settlement.js";
import { lockTrip } from "../trips/trips.repository.js";

/**
 * Customer cancellations (Phase 14, ADR 0020). A customer cancels one CONFIRMED item of their own
 * trip before it starts. The refund comes from the policy frozen on the item and the refund clock
 * (hours before the ACTUAL start of the service, owner decision 2026-11-27):
 *
 * - GET  /trips/:id/items/:itemId/cancellation: what cancelling now would give back (preview);
 * - POST /trips/:id/items/:itemId/cancel { expectedRefundMinor }: cancels, but only if the refund
 *   is still the one the customer saw (a tier boundary may pass in between: 409, new preview).
 *
 * Effects (one transaction, trip locked): the item becomes CANCELLED with the tier, the refund and
 * the commission on what is kept frozen on it (database CHECKs re-compute them); its inventory is
 * released; online money owed back becomes refund REQUESTS for the admin queue (executed there);
 * nothing kept → commission waived (an issued invoice gets an adjustment). Audited (actor = the
 * customer). Repeating a cancellation returns the same result. Customers never see commission.
 */

export const cancelItemBodySchema = z
  .object({
    /** The refund the customer was shown, minor units as a string. */
    expectedRefundMinor: minorAmountInputSchema,
    reason: z.string().trim().min(1).max(400).optional(),
  })
  .strict();

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

const ITEM_INCLUDE = {
  slots: { select: { inventorySlotId: true, units: true } },
  allocations: {
    // Oldest charge first; refunds take from the newest first (splitRefund).
    orderBy: [{ payment: { createdAt: "asc" } }, { id: "asc" }],
    include: {
      payment: { select: { id: true, kind: true, status: true, gateway: true, currency: true } },
    },
  },
} as const satisfies Prisma.BookingItemInclude;

type CancellableItem = Prisma.BookingItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

const REFUSAL_MESSAGES: Record<CancelRefusal, string> = {
  NOT_CANCELLABLE_STATUS: "Only confirmed bookings can be cancelled.",
  ALREADY_STARTED: "This booking has already started and can no longer be cancelled.",
  SETTLED_AT_PROPERTY:
    "This booking was already paid at the property. Please contact the provider or MeroStay support.",
  NOT_FULLY_PAID: "This booking is not fully paid yet.",
};

export interface CancellationPreview {
  item: CancellableItem;
  plan: CancelPlan;
  at: Date;
}

const itemNotFound = () =>
  new AppError(404, "ITEM_NOT_FOUND", "Booking item not found in this trip.");

export function createCancellationsService({
  prisma,
  now,
}: {
  prisma: PrismaClient;
  now: () => Date;
}) {
  function planFor(item: CancellableItem, at: Date): CancelPlan {
    return planCustomerCancellation(
      {
        status: item.status,
        paymentStatus: item.paymentStatus,
        commissionStatus: item.commissionStatus,
        totalMinor: item.totalMinor,
        subtotalMinor: item.subtotalMinor,
        commissionRateBps: item.commissionRateBps,
        serviceStartsAt: item.serviceStartsAt,
        policySnapshot: item.cancellationPolicySnapshot,
      },
      at,
    );
  }

  /** Owner-scoped: another customer's trip or item is a 404 (CLAUDE.md §3.3). */
  async function loadOwned(
    db: PrismaClient | Prisma.TransactionClient,
    tripId: string,
    ownerId: string,
    itemId: string,
  ): Promise<CancellableItem> {
    const item = await db.bookingItem.findFirst({
      where: { id: itemId, tripId, trip: { customerId: ownerId } },
      include: ITEM_INCLUDE,
    });
    if (!item) throw itemNotFound();
    return item;
  }

  async function preview(
    tripId: string,
    ownerId: string,
    itemId: string,
  ): Promise<CancellationPreview> {
    const item = await loadOwned(prisma, tripId, ownerId, itemId);
    const at = now();
    return { item, plan: planFor(item, at), at };
  }

  async function cancel(
    ctx: AuditContext,
    tripId: string,
    ownerId: string,
    itemId: string,
    body: z.infer<typeof cancelItemBodySchema>,
  ): Promise<{ changed: boolean; refundRequests: number; item: CancellableItem }> {
    return prisma.$transaction(async (tx) => {
      if (!(await lockTrip(tx, tripId, ownerId))) {
        throw new AppError(404, "TRIP_NOT_FOUND", "Trip not found.");
      }
      const item = await loadOwned(tx, tripId, ownerId, itemId);
      // Already cancelled by the customer: the same answer again, nothing changes.
      if (item.cancellationRefundBps !== null) {
        return { changed: false, refundRequests: 0, item };
      }
      const at = now();
      const plan = planFor(item, at);
      if (!plan.ok) {
        throw new AppError(409, `ITEM_${plan.refusal}`, REFUSAL_MESSAGES[plan.refusal], { itemId });
      }
      if (body.expectedRefundMinor !== plan.refundMinor) {
        throw new AppError(
          409,
          "CANCELLATION_TERMS_CHANGED",
          "The refund for cancelling now has changed. Please review it again.",
          { ...currencyInfo(item.currency), refundMinor: minorToString(plan.refundMinor) },
        );
      }

      // 1. Give the inventory back.
      for (const slot of item.slots) {
        if (!slot.inventorySlotId) continue;
        await tx.inventorySlot.update({
          where: { id: slot.inventorySlotId },
          data: { capacityBooked: { decrement: slot.units } },
        });
      }
      // 2. The item: cancelled, with the tier, refund and kept commission frozen on it.
      assertItemTransition(item.status, "CANCELLED");
      const waive = plan.commission !== "KEEP";
      if (waive) assertCommissionTransition(item.commissionStatus, "WAIVED", item.paymentStatus);
      const reason = body.reason ?? "Cancelled by the customer";
      await tx.bookingItem.update({
        where: { id: item.id },
        data: {
          status: "CANCELLED",
          cancelledAt: at,
          cancellationReason: reason,
          cancelledById: ctx.actorUserId,
          cancellationRefundBps: plan.decision.refundBps,
          cancellationRefundMinor: plan.refundMinor,
          keptCommissionMinor: plan.keptCommissionMinor,
          ...(waive ? { commissionStatus: "WAIVED" as const } : {}),
        },
      });
      // 3. An issued invoice for this commission: an adjustment, never an edit.
      if (plan.commission === "WAIVE_AND_ADJUST_INVOICE" && item.commissionInvoiceId) {
        await adjustInvoiceForWaivedItem(
          tx,
          { ...item, commissionInvoiceId: item.commissionInvoiceId },
          `Cancelled by the customer: ${reason}`,
          ctx.actorUserId,
        );
      }
      // 4. Online money owed back: refund REQUESTS (the admin queue approves and executes them).
      let refundRequests = 0;
      if (plan.refundMinor > 0n) {
        const paid = item.allocations.filter(
          (a) => a.payment.kind === "CHARGE" && a.payment.status === "SUCCEEDED",
        );
        const byPayment = new Map(paid.map((a) => [a.paymentId, a.payment]));
        const percent = (plan.decision.refundBps / 100).toFixed(2).replace(/\.?0+$/, "");
        for (const part of splitRefund(plan.refundMinor, paid)) {
          const payment = byPayment.get(part.paymentId)!;
          await tx.refundRequest.create({
            data: {
              paymentId: part.paymentId,
              bookingItemId: item.id,
              gateway: payment.gateway,
              amountMinor: part.amountMinor,
              currency: payment.currency,
              reason: `Customer cancellation (${percent}% refund)`,
              requestedById: ctx.actorUserId,
            },
          });
          refundRequests += 1;
        }
      }
      // 5. Trip totals and status.
      await settleTripAfterCancellations(tx, tripId, at);

      await recordAudit(tx, ctx, {
        action: "booking_item.cancel",
        entityType: "booking_item",
        entityId: item.id,
        before: {
          status: item.status,
          paymentStatus: item.paymentStatus,
          commissionStatus: item.commissionStatus,
        },
        after: {
          status: "CANCELLED",
          serviceStartsAt: item.serviceStartsAt.toISOString(),
          cancelledAt: at.toISOString(),
          noticeMinutes: Math.floor(plan.decision.noticeMs / 60_000),
          refundBps: plan.decision.refundBps,
          refundMinor: plan.refundMinor.toString(),
          keptCommissionMinor: plan.keptCommissionMinor.toString(),
          commissionStatus: waive ? "WAIVED" : item.commissionStatus,
          refundRequests,
        },
      });
      const updated = await loadOwned(tx, tripId, ownerId, itemId);
      return { changed: true, refundRequests, item: updated };
    }, TX_OPTIONS);
  }

  return { preview, cancel };
}

export type CancellationsService = ReturnType<typeof createCancellationsService>;

/** The customer view of a cancellation: what goes back, never the commission (CLAUDE.md §3.3). */
export function serializeCancellationPreview({ item, plan, at }: CancellationPreview) {
  const rule = ruleFromSnapshot(item.cancellationPolicySnapshot);
  const policy =
    item.cancellationPolicySnapshot && typeof item.cancellationPolicySnapshot === "object"
      ? (item.cancellationPolicySnapshot as { name?: unknown }).name
      : null;
  return {
    data: {
      itemId: item.id,
      status: item.status,
      cancellable: plan.ok,
      refusal: plan.ok
        ? null
        : { code: `ITEM_${plan.refusal}`, message: REFUSAL_MESSAGES[plan.refusal] },
      serviceStartsAt: item.serviceStartsAt.toISOString(),
      /** The start in Nepal time, "YYYY-MM-DDTHH:MM". */
      serviceStartsAtNepal: toNepalLocal(item.serviceStartsAt),
      /** LISTING_TIME, or DEFAULT_MIDNIGHT when the listing had no start time. */
      serviceStartSource: item.serviceStartSource,
      evaluatedAt: at.toISOString(),
      noticeMinutes: Math.max(0, Math.floor(plan.decision.noticeMs / 60_000)),
      policy: {
        name: typeof policy === "string" ? policy : null,
        attached: rule !== null,
        nonRefundable: rule?.nonRefundable ?? null,
      },
      tier: plan.decision.tier,
      refundBps: plan.decision.refundBps,
      ...currencyInfo(item.currency),
      paymentMethod: isPayAtProperty(item.paymentStatus) ? "PAY_AT_PROPERTY" : "ONLINE",
      paidMinor: minorToString(
        item.allocations
          .filter((a) => a.payment.kind === "CHARGE" && a.payment.status === "SUCCEEDED")
          .reduce((sum, a) => sum + a.amountMinor, 0n),
      ),
      refundMinor: plan.ok ? minorToString(plan.refundMinor) : "0",
    },
  };
}

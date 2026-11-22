import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotentResult } from "../../lib/idempotency.js";
import { paginationShape, skipTake } from "../../lib/pagination.js";
import { isoDateSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { assertProviderWritable, type PartnerContext } from "../partner/partner-context.js";
import { settleItemAtProperty } from "../payments/settlement.js";
import { lockTrip } from "../trips/trips.repository.js";

/**
 * A provider's bookings (booking items of submitted trips) and partner-side pay-at-property
 * settlement (ADR 0008). Every query is filtered by the partner's provider: another provider's
 * booking is a 404. Draft trips (a customer still building their trip) are not shown.
 */

export const providerBookingsQuerySchema = z
  .object({
    ...paginationShape,
    status: z
      .enum(["PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW", "EXPIRED"])
      .optional(),
    /** Service start date range [from, to). */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict();

export const PROVIDER_BOOKING_INCLUDE = {
  trip: {
    select: {
      reference: true,
      status: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      customer: { select: { fullName: true, email: true, phone: true } },
    },
  },
  listing: { select: { id: true, title: true, listingTypeCode: true } },
  slots: { orderBy: { serviceDate: "asc" } },
  allocations: {
    where: { payment: { kind: "CHARGE", status: "SUCCEEDED" } },
    select: { amountMinor: true },
  },
  commissionInvoice: { select: { id: true, number: true, status: true } },
  paymentSettledBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.BookingItemInclude;

export type ProviderBooking = Prisma.BookingItemGetPayload<{
  include: typeof PROVIDER_BOOKING_INCLUDE;
}>;

const submittedTrip = { trip: { status: { not: "DRAFT" } } } satisfies Prisma.BookingItemWhereInput;
const bookingNotFound = () => new AppError(404, "BOOKING_NOT_FOUND", "Booking not found.");

export function createProviderBookingsService({
  prisma,
  now,
}: {
  prisma: PrismaClient;
  now: () => Date;
}) {
  async function list(providerId: string, query: z.infer<typeof providerBookingsQuerySchema>) {
    const where: Prisma.BookingItemWhereInput = {
      providerId,
      ...submittedTrip,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            startDate: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lt: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.bookingItem.findMany({
        where,
        include: PROVIDER_BOOKING_INCLUDE,
        orderBy: [{ startDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        ...skipTake(query),
      }),
      prisma.bookingItem.count({ where }),
    ]);
    return { items, total };
  }

  async function get(providerId: string, itemId: string): Promise<ProviderBooking> {
    const item = await prisma.bookingItem.findFirst({
      where: { id: itemId, providerId, ...submittedTrip },
      include: PROVIDER_BOOKING_INCLUDE,
    });
    if (!item) throw bookingNotFound();
    return item;
  }

  /**
   * The provider records that the guest paid on arrival. Requires an Idempotency-Key: a retry with
   * the same key returns the first result; settling an already settled item changes nothing.
   * Audited when it changes the item.
   */
  async function settleAtProperty(
    ctx: AuditContext,
    partner: PartnerContext,
    itemId: string,
    idempotencyKey: string,
  ): Promise<IdempotentResult> {
    assertProviderWritable(partner.providerStatus);
    return withIdempotency(
      prisma,
      {
        userId: ctx.actorUserId,
        key: idempotencyKey,
        scope: "partner.settle_at_property",
        request: { providerId: partner.providerId, itemId },
      },
      async (tx) => {
        const found = await tx.bookingItem.findFirst({
          where: { id: itemId, providerId: partner.providerId, ...submittedTrip },
          select: { tripId: true },
        });
        if (!found) throw bookingNotFound();
        // Same lock order as every other trip write: the trip row first.
        await lockTrip(tx, found.tripId);
        const item = await tx.bookingItem.findUniqueOrThrow({
          where: { id: itemId },
          select: { id: true, status: true, paymentStatus: true },
        });
        const at = now();
        const result = await settleItemAtProperty(tx, item, ctx.actorUserId, at);
        if (result.changed) {
          await recordAudit(tx, ctx, {
            action: "booking_item.settle_at_property",
            entityType: "booking_item",
            entityId: itemId,
            before: { paymentStatus: item.paymentStatus },
            after: { paymentStatus: result.paymentStatus, settledAt: at.toISOString() },
          });
        }
        return { resourceId: itemId, status: 200 };
      },
    );
  }

  return { list, get, settleAtProperty };
}

export type ProviderBookingsService = ReturnType<typeof createProviderBookingsService>;

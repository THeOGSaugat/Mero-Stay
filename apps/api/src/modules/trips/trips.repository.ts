import type { Prisma } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { summarizeTrip } from "../../domain/money.js";
import type { Db } from "../listings/listings.repository.js";

/** Prisma queries for trips and booking items. No business rules here (see trips.service.ts). */

export const TRIP_INCLUDE = {
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      slots: { orderBy: { serviceDate: "asc" } },
      // Money the customer has paid towards this item online (succeeded charges only, ADR 0007).
      allocations: {
        where: { payment: { kind: "CHARGE", status: "SUCCEEDED" } },
        select: { amountMinor: true },
      },
      listing: {
        select: {
          id: true,
          title: true,
          slug: true,
          listingTypeCode: true,
          provider: { select: { id: true, displayName: true } },
        },
      },
    },
  },
} satisfies Prisma.TripInclude;

export type TripWithItems = Prisma.TripGetPayload<{ include: typeof TRIP_INCLUDE }>;

/** Items that count towards trip totals and hold inventory. */
export const ACTIVE_ITEM_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
  "NO_SHOW",
] as const;

/**
 * A trip by id, ONLY if it belongs to `customerId`. Another user's trip is indistinguishable from a
 * missing one (callers turn null into 404), so trip existence never leaks across accounts.
 */
export async function findTrip(
  db: Db,
  id: string,
  customerId: string,
): Promise<TripWithItems | null> {
  return db.trip.findFirst({ where: { id, customerId }, include: TRIP_INCLUDE });
}

/**
 * Row-locks the trip until the transaction ends (SELECT ... FOR UPDATE), so concurrent edits of the
 * same trip run one after another and trip totals can never be computed from a stale item list.
 */
export async function lockTrip(
  tx: Prisma.TransactionClient,
  id: string,
  customerId?: string,
): Promise<boolean> {
  // Owner-scoped when customerId is given (API requests); unscoped only for the system sweeper.
  const rows = customerId
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM trips WHERE id = ${id}::uuid AND customer_id = ${customerId}::uuid FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM trips WHERE id = ${id}::uuid FOR UPDATE`;
  return rows.length === 1;
}

/** What a booking snapshot and a listing page need from a policy (ADR 0015). */
export const CANCELLATION_POLICY_SELECT = {
  id: true,
  name: true,
  description: true,
  rules: true,
  nonRefundable: true,
  isActive: true,
} as const;

export async function findListingForBooking(db: Db, id: string) {
  return db.listing.findUnique({
    where: { id },
    include: {
      provider: {
        select: {
          id: true,
          status: true,
          commissionRateBps: true,
          // Used when the listing has no policy of its own (ADR 0015).
          defaultCancellationPolicy: { select: CANCELLATION_POLICY_SELECT },
        },
      },
      listingType: { select: { code: true, isActive: true, isBookable: true } },
      defaultCancellationPolicy: { select: CANCELLATION_POLICY_SELECT },
    },
  });
}

export type BookingListing = NonNullable<Awaited<ReturnType<typeof findListingForBooking>>>;

export async function findSlotsForDates(db: Db, listingId: string, dates: readonly string[]) {
  return db.inventorySlot.findMany({
    where: { listingId, serviceDate: { in: dates.map(toDbDate) } },
  });
}

/**
 * Changes the units held/booked on one inventory row. The increment is a single atomic UPDATE; the
 * CHECK constraint `inventory_slots_no_overbooking_chk` rejects it if it would exceed capacity, even
 * under concurrent requests. That constraint, not application code, is what prevents overbooking.
 */
export async function adjustBookedUnits(
  tx: Prisma.TransactionClient,
  slotId: string,
  delta: number,
) {
  await tx.inventorySlot.update({
    where: { id: slotId },
    data: { capacityBooked: { increment: delta } },
  });
}

export async function findActiveItems(tx: Prisma.TransactionClient, tripId: string) {
  return tx.bookingItem.findMany({
    where: { tripId, status: { in: [...ACTIVE_ITEM_STATUSES] } },
    include: {
      slots: true,
      listing: { include: { provider: true, listingType: true } },
    },
  });
}

export async function findItemInTrip(tx: Prisma.TransactionClient, tripId: string, itemId: string) {
  return tx.bookingItem.findFirst({ where: { id: itemId, tripId }, include: { slots: true } });
}

/** The summary shown in a trip list: stored totals and the items' listing titles. */
export const TRIP_SUMMARY_INCLUDE = {
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      listing: { select: { title: true, listingTypeCode: true } },
    },
  },
} satisfies Prisma.TripInclude;

export type TripSummary = Prisma.TripGetPayload<{ include: typeof TRIP_SUMMARY_INCLUDE }>;

/** The OWNER's trips only (customer_id = the session user), newest first. */
export async function findTripsOfCustomer(
  db: Db,
  customerId: string,
  filter: { status?: TripSummary["status"]; skip: number; take: number },
): Promise<{ trips: TripSummary[]; total: number }> {
  const where = { customerId, ...(filter.status ? { status: filter.status } : {}) };
  const [trips, total] = await Promise.all([
    db.trip.findMany({
      where,
      include: TRIP_SUMMARY_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: filter.skip,
      take: filter.take,
    }),
    db.trip.count({ where }),
  ]);
  return { trips, total };
}

/**
 * Trip totals = sums of its active items (CLAUDE.md §3.5), written together with any other trip
 * fields. The caller holds the trip lock. Shared by the trips service and admin voids (ADR 0018).
 */
export async function recalculateTripTotals(
  tx: Prisma.TransactionClient,
  trip: { id: string; currency: string },
  extra: Prisma.TripUpdateInput = {},
): Promise<void> {
  const items = await tx.bookingItem.findMany({
    where: { tripId: trip.id, status: { in: [...ACTIVE_ITEM_STATUSES] } },
    select: {
      currency: true,
      subtotalMinor: true,
      serviceChargeMinor: true,
      taxMinor: true,
      totalMinor: true,
      commissionMinor: true,
    },
  });
  const totals = summarizeTrip(trip.currency, items);
  await tx.trip.update({
    where: { id: trip.id },
    data: {
      subtotalMinor: totals.subtotalMinor,
      serviceChargeMinor: totals.serviceChargeMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      commissionTotalMinor: totals.commissionTotalMinor,
      ...extra,
    },
  });
}

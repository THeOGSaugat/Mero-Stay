import type { Prisma } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import type { Db } from "../listings/listings.repository.js";

/** Prisma queries for trips and booking items. No business rules here (see trips.service.ts). */

export const TRIP_INCLUDE = {
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      slots: { orderBy: { serviceDate: "asc" } },
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

export async function findTrip(db: Db, id: string): Promise<TripWithItems | null> {
  return db.trip.findUnique({ where: { id }, include: TRIP_INCLUDE });
}

/**
 * Row-locks the trip until the transaction ends (SELECT ... FOR UPDATE), so concurrent edits of the
 * same trip run one after another and trip totals can never be computed from a stale item list.
 */
export async function lockTrip(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM trips WHERE id = ${id}::uuid FOR UPDATE`;
  return rows.length === 1;
}

export async function findListingForBooking(db: Db, id: string) {
  return db.listing.findUnique({
    where: { id },
    include: {
      provider: { select: { id: true, status: true, commissionRateBps: true } },
      listingType: { select: { code: true, isActive: true, isBookable: true } },
      defaultCancellationPolicy: {
        select: { id: true, name: true, description: true, rules: true },
      },
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

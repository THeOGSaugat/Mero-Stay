import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { CANCELLATION_POLICY_SELECT } from "../trips/trips.repository.js";
import { toDbDate } from "../../domain/dates.js";

/** Prisma queries for listings. No business rules here (see listings.service.ts). */

export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A listing is publicly visible when it is APPROVED, its provider is VERIFIED and its listing type
 * is active. Flights (is_active = false) are therefore never visible.
 */
export const publiclyVisibleWhere = {
  status: "APPROVED",
  provider: { status: "VERIFIED" },
  listingType: { isActive: true },
} satisfies Prisma.ListingWhereInput;

/** Visible AND bookable (excludes containers such as a hotel property that groups its rooms). */
export const bookableWhere = {
  ...publiclyVisibleWhere,
  listingType: { isActive: true, isBookable: true },
} satisfies Prisma.ListingWhereInput;

/** Every detail-table relation. A new vertical's detail table is added here, not in any endpoint. */
export const DETAIL_INCLUDE = {
  hotelDetail: true,
  hotelRoomDetail: true,
  busRouteDetail: {
    include: {
      origin: { select: { id: true, name: true, slug: true } },
      destination: { select: { id: true, name: true, slug: true } },
    },
  },
  guideServiceDetail: true,
  tourDetail: { include: { startLocation: { select: { id: true, name: true, slug: true } } } },
  activityDetail: true,
  flightRouteDetail: true,
} satisfies Prisma.ListingInclude;

export const DETAIL_RELATIONS = Object.keys(DETAIL_INCLUDE) as (keyof typeof DETAIL_INCLUDE)[];

export const SUMMARY_INCLUDE = {
  provider: { select: { id: true, displayName: true } },
  location: { select: { id: true, name: true, slug: true } },
  parent: { select: { id: true, title: true, slug: true } },
  listingType: { select: { code: true, name: true, unitLabel: true } },
} satisfies Prisma.ListingInclude;

export async function listListingTypes(db: Db) {
  return db.listingType.findMany({ orderBy: { code: "asc" } });
}

/** IDs of the location with this slug and all its descendants; null if the slug is unknown. */
export async function findLocationSubtreeIds(db: Db, slug: string): Promise<string[] | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM locations WHERE slug = ${slug}
      UNION ALL
      SELECT l.id FROM locations l JOIN subtree s ON l.parent_id = s.id
    )
    SELECT id::text AS id FROM subtree`;
  return rows.length === 0 ? null : rows.map((row) => row.id);
}

/**
 * Listings with an OPEN inventory row on EVERY requested date, each with at least `units` free.
 * Free = capacity_total − capacity_booked; capacity_booked already includes holds from other trips,
 * so search never offers inventory that is held or sold.
 */
export async function findListingIdsWithAvailability(
  db: Db,
  dates: readonly string[],
  units: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ listing_id: string }[]>`
    SELECT listing_id::text AS listing_id
    FROM inventory_slots
    WHERE service_date = ANY(${dates}::date[])
      AND status = 'OPEN'
      AND capacity_total - capacity_booked >= ${units}
    GROUP BY listing_id
    HAVING COUNT(*) = ${dates.length}`;
  return rows.map((row) => row.listing_id);
}

export async function searchListings(
  db: Db,
  where: Prisma.ListingWhereInput,
  orderBy: Prisma.ListingOrderByWithRelationInput[],
  skip: number,
  take: number,
) {
  const [items, total] = await Promise.all([
    db.listing.findMany({ where, orderBy, skip, take, include: SUMMARY_INCLUDE }),
    db.listing.count({ where }),
  ]);
  return { items, total };
}

export async function findSlots(db: Db, listingIds: readonly string[], dates: readonly string[]) {
  return db.inventorySlot.findMany({
    where: { listingId: { in: [...listingIds] }, serviceDate: { in: dates.map(toDbDate) } },
    orderBy: { serviceDate: "asc" },
  });
}

export async function findSlotsBetween(
  db: Db,
  listingId: string,
  from: string,
  toExclusive: string,
) {
  return db.inventorySlot.findMany({
    where: { listingId, serviceDate: { gte: toDbDate(from), lt: toDbDate(toExclusive) } },
    orderBy: { serviceDate: "asc" },
  });
}

export async function findVisibleListingDetail(db: Db, id: string) {
  return db.listing.findFirst({
    where: { id, ...publiclyVisibleWhere },
    include: {
      ...SUMMARY_INCLUDE,
      ...DETAIL_INCLUDE,
      provider: {
        select: {
          id: true,
          displayName: true,
          providerTypeCode: true,
          defaultCancellationPolicy: { select: CANCELLATION_POLICY_SELECT },
        },
      },
      defaultCancellationPolicy: { select: CANCELLATION_POLICY_SELECT },
      children: {
        where: bookableWhere,
        orderBy: { basePriceMinor: "asc" },
        select: {
          id: true,
          title: true,
          slug: true,
          listingTypeCode: true,
          basePriceMinor: true,
          currency: true,
        },
      },
    },
  });
}

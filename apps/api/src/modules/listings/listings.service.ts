import type { Prisma } from "../../generated/prisma/client.js";
import {
  InvalidDateRangeError,
  addDays,
  enumerateServiceDates,
  fromDbDate,
} from "../../domain/dates.js";
import { AppError } from "../../lib/errors.js";
import {
  bookableWhere,
  findListingIdsWithAvailability,
  findLocationSubtreeIds,
  findSlots,
  findSlotsBetween,
  findVisibleListingDetail,
  listListingTypes,
  searchListings,
  type Db,
} from "./listings.repository.js";
import type { ListingDetailQuery, SearchListingsQuery } from "./listings.schemas.js";

/** Longest availability calendar returned by the listing detail endpoint. */
export const MAX_CALENDAR_DAYS = 60;
const DEFAULT_CALENDAR_DAYS = 14;

export function invalidDateRange(err: unknown): AppError {
  return new AppError(
    422,
    "INVALID_DATE_RANGE",
    err instanceof Error ? err.message : "The date range is invalid.",
  );
}

export function assertNotInPast(startDate: string, today: string): void {
  if (startDate < today) {
    throw new AppError(
      422,
      "DATE_IN_PAST",
      `startDate ${startDate} is before today (${today}, Nepal time).`,
    );
  }
}

export async function getListingTypes(db: Db) {
  return listListingTypes(db);
}

export interface ListingAvailability {
  startDate: string;
  endDate: string | null;
  quantity: number;
  dates: number;
  /** Lowest number of free units across the requested dates. */
  minAvailable: number;
  /** quantity × Σ per-date unit prices, before service charge/VAT (indicative; quote for exact). */
  estimatedSubtotalMinor: bigint;
}

export async function searchListingsService(db: Db, query: SearchListingsQuery, today: string) {
  const where: Prisma.ListingWhereInput = { ...bookableWhere };
  const and: Prisma.ListingWhereInput[] = [];

  if (query.type) {
    const type = await db.listingType.findUnique({ where: { code: query.type } });
    if (!type)
      throw new AppError(422, "UNKNOWN_LISTING_TYPE", `Unknown listing type: ${query.type}`);
    and.push({ listingTypeCode: query.type });
  }

  if (query.location) {
    const locationIds = await findLocationSubtreeIds(db, query.location);
    if (!locationIds)
      throw new AppError(422, "UNKNOWN_LOCATION", `Unknown location: ${query.location}`);
    and.push({ locationId: { in: locationIds } });
  }

  if (query.currency) and.push({ currency: query.currency });
  if (query.minPrice !== undefined) and.push({ basePriceMinor: { gte: query.minPrice } });
  if (query.maxPrice !== undefined) and.push({ basePriceMinor: { lte: query.maxPrice } });

  let dates: string[] | null = null;
  if (query.startDate) {
    try {
      dates = enumerateServiceDates(query.startDate, query.endDate);
    } catch (err) {
      if (err instanceof InvalidDateRangeError) throw invalidDateRange(err);
      throw err;
    }
    assertNotInPast(query.startDate, today);
    const availableIds = await findListingIdsWithAvailability(db, dates, query.quantity);
    and.push({ id: { in: availableIds } });
  }

  if (and.length > 0) where.AND = and;

  const orderBy: Prisma.ListingOrderByWithRelationInput[] =
    query.sort === "title"
      ? [{ title: "asc" }, { id: "asc" }]
      : [{ basePriceMinor: query.sort === "price_desc" ? "desc" : "asc" }, { id: "asc" }];

  const { items, total } = await searchListings(
    db,
    where,
    orderBy,
    (query.page - 1) * query.pageSize,
    query.pageSize,
  );

  const availability = new Map<string, ListingAvailability>();
  if (dates && query.startDate && items.length > 0) {
    const slots = await findSlots(
      db,
      items.map((item) => item.id),
      dates,
    );
    for (const item of items) {
      const own = slots.filter((slot) => slot.listingId === item.id);
      availability.set(item.id, {
        startDate: query.startDate,
        endDate: query.endDate ?? null,
        quantity: query.quantity,
        dates: dates.length,
        minAvailable: Math.min(...own.map((slot) => slot.capacityTotal - slot.capacityBooked)),
        estimatedSubtotalMinor: own.reduce(
          (sum, slot) =>
            sum + (slot.priceOverrideMinor ?? item.basePriceMinor) * BigInt(query.quantity),
          0n,
        ),
      });
    }
  }

  return {
    items,
    availability,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getListingDetailService(
  db: Db,
  id: string,
  query: ListingDetailQuery,
  today: string,
) {
  const listing = await findVisibleListingDetail(db, id);
  if (!listing) throw new AppError(404, "LISTING_NOT_FOUND", "Listing not found.");

  const from = query.from ?? today;
  const to = query.to ?? addDays(from, DEFAULT_CALENDAR_DAYS);
  if (to <= from) throw invalidDateRange(new Error("to must be after from"));
  if (to > addDays(from, MAX_CALENDAR_DAYS)) {
    throw invalidDateRange(new Error(`The calendar can cover at most ${MAX_CALENDAR_DAYS} days`));
  }

  const listingType = await db.listingType.findUniqueOrThrow({
    where: { code: listing.listingTypeCode },
  });
  const slots = listingType.isBookable ? await findSlotsBetween(db, listing.id, from, to) : [];

  return {
    listing,
    isBookable: listingType.isBookable,
    calendar: {
      from,
      to,
      slots: slots.map((slot) => ({
        date: fromDbDate(slot.serviceDate),
        status: slot.status,
        available: Math.max(0, slot.capacityTotal - slot.capacityBooked),
        unitPriceMinor: slot.priceOverrideMinor ?? listing.basePriceMinor,
      })),
    },
  };
}

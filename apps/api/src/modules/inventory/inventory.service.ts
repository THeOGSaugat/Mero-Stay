import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { addDays, fromDbDate, toDbDate } from "../../domain/dates.js";
import { AppError } from "../../lib/errors.js";
import { isoDateSchema, minorAmountInputSchema } from "../../lib/validation.js";
import { assertProviderWritable, type PartnerContext } from "../partner/partner-context.js";

/**
 * Partner inventory: one `inventory_slots` row per listing per service date (ADR 0004/0008).
 *
 * - Create (POST): a date range of new slots. A date that already has a slot with exactly the same
 *   values is left alone (a retry is harmless); a different existing slot is 409 SLOT_EXISTS.
 * - Update (PATCH): change capacity, price or open/closed for existing slots in a range.
 *   Capacity below the units already booked is refused (409 CAPACITY_BELOW_BOOKED); under a race
 *   with a booking, the overbooking CHECK still refuses it (409 INSUFFICIENT_AVAILABILITY).
 * Ranges are [startDate, endDate), at most 366 days.
 */

export const MAX_SLOT_RANGE_DAYS = 366;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

const range = {
  startDate: isoDateSchema,
  endDate: isoDateSchema,
};

export const slotsQuerySchema = z.object(range).strict();

export const createSlotsBodySchema = z
  .object({
    ...range,
    capacityTotal: z.number().int().min(0).max(10_000),
    priceOverrideMinor: minorAmountInputSchema.nullable().optional(),
    status: z.enum(["OPEN", "CLOSED"]).default("OPEN"),
  })
  .strict();

export const updateSlotsBodySchema = z
  .object({
    ...range,
    capacityTotal: z.number().int().min(0).max(10_000).optional(),
    priceOverrideMinor: minorAmountInputSchema.nullable().optional(),
    status: z.enum(["OPEN", "CLOSED"]).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.capacityTotal !== undefined || b.priceOverrideMinor !== undefined || b.status !== undefined,
    { error: "send capacityTotal, priceOverrideMinor or status" },
  );

/** Every date in [start, end), capped at 366 days. */
export function slotDates(start: string, end: string): string[] {
  if (end <= start) {
    throw new AppError(422, "INVALID_DATE_RANGE", "endDate must be after startDate.");
  }
  const dates: string[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_SLOT_RANGE_DAYS) {
      throw new AppError(422, "INVALID_DATE_RANGE", `At most ${MAX_SLOT_RANGE_DAYS} days at once.`);
    }
  }
  return dates;
}

export type SlotRow = Prisma.InventorySlotGetPayload<object>;

export function createInventoryService({ prisma }: { prisma: PrismaClient }) {
  /** The partner's own, bookable listing (row-locked when inside a transaction). */
  async function ownBookableListing(
    db: Prisma.TransactionClient | PrismaClient,
    providerId: string,
    listingId: string,
  ) {
    const listing = await db.listing.findFirst({
      where: { id: listingId, providerId },
      include: { listingType: { select: { isBookable: true } } },
    });
    if (!listing) throw new AppError(404, "LISTING_NOT_FOUND", "Listing not found.");
    if (!listing.listingType.isBookable) {
      throw new AppError(
        422,
        "LISTING_NOT_BOOKABLE",
        "This listing groups other listings and has no inventory of its own.",
      );
    }
    return listing;
  }

  async function list(providerId: string, listingId: string, startDate: string, endDate: string) {
    const listing = await ownBookableListing(prisma, providerId, listingId);
    const dates = slotDates(startDate, endDate);
    const slots = await prisma.inventorySlot.findMany({
      where: { listingId, serviceDate: { gte: toDbDate(dates[0]!), lte: toDbDate(dates.at(-1)!) } },
      orderBy: { serviceDate: "asc" },
    });
    return { listing, slots };
  }

  async function create(
    partner: PartnerContext,
    listingId: string,
    input: z.infer<typeof createSlotsBodySchema>,
  ): Promise<{ created: number; unchanged: number }> {
    assertProviderWritable(partner.providerStatus);
    const dates = slotDates(input.startDate, input.endDate);
    return prisma.$transaction(async (tx) => {
      await ownBookableListing(tx, partner.providerId, listingId);
      const existing = await tx.inventorySlot.findMany({
        where: { listingId, serviceDate: { in: dates.map(toDbDate) } },
      });
      const price = input.priceOverrideMinor ?? null;
      const conflicts = existing.filter(
        (slot) =>
          slot.capacityTotal !== input.capacityTotal ||
          slot.priceOverrideMinor !== price ||
          slot.status !== input.status,
      );
      if (conflicts.length > 0) {
        throw new AppError(
          409,
          "SLOT_EXISTS",
          "Some dates already have slots; change them with PATCH.",
          {
            dates: conflicts.map((slot) => fromDbDate(slot.serviceDate)),
          },
        );
      }
      const have = new Set(existing.map((slot) => fromDbDate(slot.serviceDate)));
      const toCreate = dates.filter((date) => !have.has(date));
      if (toCreate.length > 0) {
        await tx.inventorySlot.createMany({
          data: toCreate.map((date) => ({
            listingId,
            serviceDate: toDbDate(date),
            capacityTotal: input.capacityTotal,
            priceOverrideMinor: price,
            status: input.status,
          })),
        });
      }
      return { created: toCreate.length, unchanged: existing.length };
    }, TX_OPTIONS);
  }

  async function update(
    partner: PartnerContext,
    listingId: string,
    input: z.infer<typeof updateSlotsBodySchema>,
  ): Promise<{ updated: number; missingDates: string[] }> {
    assertProviderWritable(partner.providerStatus);
    const dates = slotDates(input.startDate, input.endDate);
    return prisma.$transaction(async (tx) => {
      await ownBookableListing(tx, partner.providerId, listingId);
      // Lock the rows: a concurrent booking waits, then the CHECK re-verifies capacity.
      const locked = await tx.$queryRaw<{ service_date: Date; capacity_booked: number }[]>`
        SELECT service_date, capacity_booked FROM inventory_slots
        WHERE listing_id = ${listingId}::uuid AND service_date = ANY(${dates.map(toDbDate)}::date[])
        FOR UPDATE`;
      const found = new Set(locked.map((row) => fromDbDate(row.service_date)));
      const missingDates = dates.filter((date) => !found.has(date));
      if (input.capacityTotal !== undefined) {
        const below = locked.filter((row) => row.capacity_booked > input.capacityTotal!);
        if (below.length > 0) {
          throw new AppError(
            409,
            "CAPACITY_BELOW_BOOKED",
            "Capacity cannot be lower than the units already booked.",
            {
              dates: below.map((row) => ({
                date: fromDbDate(row.service_date),
                booked: row.capacity_booked,
              })),
            },
          );
        }
      }
      const result = await tx.inventorySlot.updateMany({
        where: { listingId, serviceDate: { in: dates.map(toDbDate) } },
        data: {
          ...(input.capacityTotal !== undefined ? { capacityTotal: input.capacityTotal } : {}),
          ...(input.priceOverrideMinor !== undefined
            ? { priceOverrideMinor: input.priceOverrideMinor }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      return { updated: result.count, missingDates };
    }, TX_OPTIONS);
  }

  return { list, create, update };
}

export type InventoryService = ReturnType<typeof createInventoryService>;

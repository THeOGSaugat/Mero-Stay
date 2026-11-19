import { z } from "zod";
import { currencyCodeSchema, isoDateSchema, minorAmountInputSchema } from "../../lib/validation.js";

export const LISTING_SORTS = ["price_asc", "price_desc", "title"] as const;

/** GET /api/v1/listings */
export const searchListingsQuerySchema = z
  .object({
    /** listing_types.code, e.g. hotel_room, bus_ticket, guide_service, tour. */
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,49}$/, { error: "must be a listing type code" })
      .optional(),
    /** locations.slug; matches that location and everything inside it (e.g. a province). */
    location: z
      .string()
      .regex(/^[a-z0-9-]{1,100}$/, { error: "must be a location slug" })
      .optional(),
    startDate: isoDateSchema.optional(),
    /** Exclusive end date for ranges (stays, multi-day guides). Omit for single-date items. */
    endDate: isoDateSchema.optional(),
    /** Units needed on EACH date: rooms, seats, persons, guides. */
    quantity: z.coerce.number().int().min(1).max(50).default(1),
    minPrice: minorAmountInputSchema.optional(),
    maxPrice: minorAmountInputSchema.optional(),
    currency: currencyCodeSchema.optional(),
    sort: z.enum(LISTING_SORTS).default("price_asc"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((q) => !(q.endDate && !q.startDate), {
    error: "endDate requires startDate",
    path: ["endDate"],
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    error: "minPrice must not exceed maxPrice",
    path: ["minPrice"],
  });

export type SearchListingsQuery = z.infer<typeof searchListingsQuerySchema>;

/** GET /api/v1/listings/:id */
export const listingDetailQuerySchema = z
  .object({
    /** First date of the availability calendar (default: today in Nepal). */
    from: isoDateSchema.optional(),
    /** Exclusive end of the calendar (default: from + 14 days; at most 60 days). */
    to: isoDateSchema.optional(),
  })
  .strict();

export type ListingDetailQuery = z.infer<typeof listingDetailQuerySchema>;

import { z } from "zod";
import { currencyCodeSchema, isoDateSchema, uuidSchema } from "../../lib/validation.js";
import { PAYMENT_METHODS } from "./trip-pricing.js";

/**
 * POST /api/v1/trips. The owner is the logged-in user (ADR 0006); a body that still sends
 * `userId` is rejected by `.strict()` with 400 VALIDATION_ERROR.
 */
export const createTripBodySchema = z
  .object({
    currency: currencyCodeSchema.default("NPR"),
    contact: z
      .object({
        name: z.string().trim().min(1).max(200),
        phone: z.string().regex(/^\+?[0-9 ]{7,20}$/, { error: "must be a phone number" }),
        email: z.email(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

const itemShape = {
  listingId: uuidSchema,
  /** First service date: check-in, travel date, first guide day, tour departure. */
  startDate: isoDateSchema,
  /** Exclusive end for ranges (check-out, day after the last guide day). Omit for single dates. */
  endDate: isoDateSchema.nullable().optional(),
  /** Units on EACH date: rooms, seats, persons, guides. */
  quantity: z.number().int().min(1).max(50),
  travellerCount: z.number().int().min(1).max(100).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** Type-specific extras, e.g. { "seatNumbers": ["A1"] } or guest names. */
  attributes: z.record(z.string(), z.unknown()).optional(),
};

export const addItemBodySchema = z.object(itemShape).strict();
export type AddItemInput = z.infer<typeof addItemBodySchema>;

export const updateItemBodySchema = z
  .object({
    startDate: itemShape.startDate.optional(),
    endDate: itemShape.endDate,
    quantity: itemShape.quantity.optional(),
    travellerCount: itemShape.travellerCount,
    paymentMethod: itemShape.paymentMethod.optional(),
    attributes: itemShape.attributes,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    error: "provide at least one field to change",
  });
export type UpdateItemInput = z.infer<typeof updateItemBodySchema>;

/** POST /api/v1/trips/:id/quote: optional candidate items to price alongside the trip's own items. */
export const quoteBodySchema = z
  .object({ items: z.array(addItemBodySchema).max(20).default([]) })
  .strict();

export const tripItemParamsSchema = z.object({ id: uuidSchema, itemId: uuidSchema }).strict();

/** GET /api/v1/trips: the caller's own trips, newest first (Phase 7). */
export const listTripsQuerySchema = z
  .object({
    status: z
      .enum(["DRAFT", "PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXPIRED"])
      .optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type ListTripsQuery = z.infer<typeof listTripsQuerySchema>;

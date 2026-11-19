import { z } from "zod";
import { currencyCodeSchema, isoDateSchema, uuidSchema } from "../../lib/validation.js";
import { PAYMENT_METHODS } from "./trip-pricing.js";

/**
 * POST /api/v1/trips
 * `userId` is TEMPORARY: there is no authentication yet (ADR 0005). When auth arrives, the owner
 * comes from the session and this field is ignored, so clients keep working.
 */
export const createTripBodySchema = z
  .object({
    userId: uuidSchema,
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

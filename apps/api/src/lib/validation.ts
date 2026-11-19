import { z } from "zod";
import { isIsoDate } from "../domain/dates.js";
import { MAX_MINOR_AMOUNT } from "../domain/money.js";

/** Shared Zod building blocks for request validation. */

export const uuidSchema = z.uuid({ error: "must be a UUID" });

export const isoDateSchema = z
  .string()
  .refine(isIsoDate, { error: "must be a real calendar date in YYYY-MM-DD format" });

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: "must be a 3-letter ISO 4217 code in capitals, e.g. NPR" });

/** Money INPUT: digits-only string in minor units (same convention as responses) → bigint. */
export const minorAmountInputSchema = z
  .string()
  .regex(/^\d{1,19}$/, {
    error: 'must be a whole number of minor units as a string, e.g. "350000"',
  })
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_MINOR_AMOUNT, { error: "is too large" });

export const idParamsSchema = z.object({ id: uuidSchema }).strict();

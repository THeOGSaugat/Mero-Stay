import { z } from "zod";
import { uuidSchema } from "../../lib/validation.js";

/** Input contracts for the payment endpoints (ADR 0007). Strict: unknown fields are rejected. */

export const paymentParamsSchema = z.object({ id: uuidSchema, paymentId: uuidSchema }).strict();

/**
 * Creating an intent takes no input: the amount and items are computed on the server from the
 * trip (CLAUDE.md §4: never trust the client about amount). An empty object or no body.
 */
export const createIntentBodySchema = z.object({}).strict();

/**
 * Simulated provider callback (test mode only). In a real integration these values come from the
 * gateway's server-to-server verification, never from the customer's browser.
 */
export const confirmPaymentBodySchema = z
  .object({
    /** What the simulated gateway reports. Default: succeeded. */
    outcome: z.enum(["succeeded", "failed"]).default("succeeded"),
    /**
     * Amount the simulated gateway captured, as a digit string in minor units. Default: the full
     * intent amount. Less than that simulates a partial capture (ADR 0007).
     */
    capturedAmountMinor: z
      .string()
      .regex(/^[1-9]\d{0,18}$/, { error: "must be a positive whole number of minor units" })
      .optional(),
    /** Gateway's transaction id. Default: generated ("SIM-..."). Unique per gateway. */
    gatewayTransactionId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,100}$/, { error: "must be 1–100 letters, digits, - or _" })
      .optional(),
  })
  .strict();

export type ConfirmPaymentInput = z.infer<typeof confirmPaymentBodySchema>;

/** Admin: record that pay-at-property items were paid at the property. */
export const settleAtPropertyBodySchema = z
  .object({
    itemIds: z
      .array(uuidSchema)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, { error: "must not repeat an item" }),
  })
  .strict();

import { z } from "zod";
import { GATEWAY_NAMES, LIVE_GATEWAY_NAMES } from "../../lib/payment-gateways/index.js";
import { uuidSchema } from "../../lib/validation.js";

/** Input contracts for the payment endpoints (ADR 0007). Strict: unknown fields are rejected. */

export const paymentParamsSchema = z.object({ id: uuidSchema, paymentId: uuidSchema }).strict();

/**
 * Creating an intent takes only the gateway: the amount and items are computed on the server from
 * the trip (CLAUDE.md §4: never trust the client about amount).
 */
export const createIntentBodySchema = z
  .object({ gateway: z.enum(GATEWAY_NAMES, { error: "must be esewa, khalti or simulated" }) })
  .strict();

/** The customer's browser hands back what the gateway gave it (verified server-side). */
export const callbackParamsSchema = z.object({ gateway: z.enum(LIVE_GATEWAY_NAMES) }).strict();

const opaque = (max: number) => z.string().trim().min(1).max(max);
export const esewaCallbackBodySchema = z
  .object({
    paymentId: uuidSchema,
    /** eSewa's base64 response from the success page; absent on the failure page (status API). */
    data: opaque(4000).optional(),
  })
  .strict();
export const khaltiCallbackBodySchema = z
  .object({
    paymentId: uuidSchema,
    /** Only names the payment to look up; Khalti's other return parameters are ignored. */
    pidx: opaque(200),
  })
  .passthrough()
  .transform(({ paymentId, pidx }) => ({ paymentId, pidx }));

/**
 * Simulated provider callback (development and tests only; refused in production). Real gateways
 * are verified server-side through the callback and refresh endpoints instead.
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

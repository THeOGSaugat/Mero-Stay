import { z } from "zod";
import { paginationShape } from "../../lib/pagination.js";
import { currencyCodeSchema, minorAmountInputSchema, uuidSchema } from "../../lib/validation.js";

/**
 * Partner listing input (ADR 0008). The provider comes from the session (partner context), never
 * from the body: a `providerId` field is rejected like any unknown field. Partners cannot set the
 * commission rate (MeroStay's setting) or approve their own listings.
 */

const bps = z.number().int().min(0).max(10_000);
const attributes = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 10_000, { error: "is too large" });

export const createListingBodySchema = z
  .object({
    listingTypeCode: z.string().regex(/^[a-z_]{2,40}$/),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().max(5000).nullable().optional(),
    parentId: uuidSchema.nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    currency: currencyCodeSchema.default("NPR"),
    basePriceMinor: minorAmountInputSchema,
    serviceChargeRateBps: bps.default(0),
    taxRateBps: bps.default(0),
    defaultCancellationPolicyId: uuidSchema.nullable().optional(),
    addressLine: z.string().trim().max(300).nullable().optional(),
    attributes: attributes.default({}),
    /** Type-specific fields (detail table); validated per listing type. */
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Statuses a partner may move their own listing to. Approval is an admin action (Phase 7). */
export const PARTNER_LISTING_STATUSES = ["DRAFT", "PENDING_REVIEW", "ARCHIVED"] as const;

export const updateListingBodySchema = z
  .object({
    title: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    locationId: uuidSchema.nullable().optional(),
    basePriceMinor: minorAmountInputSchema.optional(),
    serviceChargeRateBps: bps.optional(),
    taxRateBps: bps.optional(),
    defaultCancellationPolicyId: uuidSchema.nullable().optional(),
    addressLine: z.string().trim().max(300).nullable().optional(),
    attributes: attributes.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(PARTNER_LISTING_STATUSES).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "send at least one field" });

export const listListingsQuerySchema = z
  .object({
    ...paginationShape,
    status: z
      .enum(["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED", "SUSPENDED", "ARCHIVED"])
      .optional(),
    listingType: z
      .string()
      .regex(/^[a-z_]{2,40}$/)
      .optional(),
  })
  .strict();

import { z } from "zod";
import { DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES } from "../../lib/document-content.js";
import { paginationShape, searchShape, sortShape } from "../../lib/pagination.js";
import { isoDateSchema, uuidSchema } from "../../lib/validation.js";

/** Input contracts for partner onboarding/profile/documents and admin verification (ADR 0008). */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const nepalPhone = z
  .string()
  .trim()
  .regex(/^\+977\d{8,10}$/, { error: "must be a Nepali number in +977 format" });

export const onboardingBodySchema = z
  .object({
    providerTypeCode: z.string().regex(/^[a-z_]{2,40}$/),
    legalName: text(200),
    displayName: text(120),
    description: optionalText(2000),
    contactEmail: z.email().trim().toLowerCase().nullable().optional(),
    contactPhone: nepalPhone.nullable().optional(),
    addressLine: optionalText(300),
    panNumber: z
      .string()
      .trim()
      .regex(/^\d{9}$/, { error: "must be 9 digits" })
      .nullable()
      .optional(),
    vatNumber: z
      .string()
      .trim()
      .regex(/^\d{9}$/, { error: "must be 9 digits" })
      .nullable()
      .optional(),
    businessRegistrationNo: optionalText(60),
  })
  .strict();

/** Bank account for online payouts. The number is stored, but only ever returned masked. */
export const payoutAccountSchema = z
  .object({
    bankName: text(120),
    branch: optionalText(120),
    accountName: text(200),
    accountNumber: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z-]{6,34}$/, { error: "must be 6–34 letters, digits or -" }),
  })
  .strict();

export const profilePatchSchema = z
  .object({
    displayName: text(120).optional(),
    description: optionalText(2000),
    contactEmail: z.email().trim().toLowerCase().nullable().optional(),
    contactPhone: nepalPhone.nullable().optional(),
    addressLine: optionalText(300),
    // Legal and tax identity: editable only before verification (or after a rejection).
    legalName: text(200).optional(),
    panNumber: z
      .string()
      .trim()
      .regex(/^\d{9}$/)
      .nullable()
      .optional(),
    vatNumber: z
      .string()
      .trim()
      .regex(/^\d{9}$/)
      .nullable()
      .optional(),
    businessRegistrationNo: optionalText(60),
    payoutAccount: payoutAccountSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "send at least one field" });

export const DOCUMENT_TYPES = [
  "OWNER_ID",
  "BUSINESS_REGISTRATION",
  "LOCAL_GOVERNMENT_REGISTRATION",
  "PAN_CERTIFICATE",
  "VAT_CERTIFICATE",
  "TOURISM_LICENSE",
  "GUIDE_LICENSE",
  "VEHICLE_ROUTE_PERMIT",
  "PROPERTY_OWNERSHIP_OR_LEASE",
  "BANK_PROOF",
  "OTHER",
] as const;

export { DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES } from "../../lib/document-content.js";

/**
 * POST /partner/verification-documents: ask to upload one document (ADR 0016). The server creates
 * the record (AWAITING_UPLOAD) and its private storage key; the file itself follows with
 * PUT …/:id/file, and must match the declared type and size exactly. `fileName` is a display
 * name only.
 */
export const documentBodySchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(DOCUMENT_MIME_TYPES),
    sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
    documentNumber: optionalText(60),
    expiresOn: isoDateSchema.nullable().optional(),
  })
  .strict();

export const documentParamsSchema = z.object({ id: uuidSchema }).strict();
export const adminDocumentParamsSchema = z
  .object({ id: uuidSchema, documentId: uuidSchema })
  .strict();

export const adminProvidersQuerySchema = z
  .object({
    ...paginationShape,
    /** Display or legal name, owner email, or provider type (gap 25). */
    ...searchShape,
    ...sortShape,
    status: z
      .enum(["DRAFT", "PENDING_VERIFICATION", "VERIFIED", "REJECTED", "SUSPENDED"])
      .optional(),
    providerType: z
      .string()
      .regex(/^[a-z_]{2,40}$/)
      .optional(),
  })
  .strict();

export const verificationDecisionParamsSchema = z
  .object({ id: uuidSchema, decision: z.enum(["approve", "reject"]) })
  .strict();

export const verificationDecisionBodySchema = z
  .object({ reason: z.string().trim().min(3).max(1000).optional() })
  .strict();

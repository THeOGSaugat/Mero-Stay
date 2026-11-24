import type { PartnerProfile, RequiredDocumentGroup, VerificationDocument } from "./partner-types";

/**
 * Shapes of the admin API responses (docs/architecture/api.md, ADR 0007/0008). Money fields are
 * digit strings; bank numbers arrive masked. Invoices and payouts share the partner shapes
 * (`CommissionInvoice`, `PayoutSummaryRow` in partner-types.ts), across all providers.
 */

/** A provider in the admin list (the profile plus the owner's account). */
export interface AdminProviderSummary extends PartnerProfile {
  owner: { id: string; fullName: string; email: string | null; phone: string | null };
}

/** GET /admin/providers/:id adds the documents. */
export interface AdminProvider extends AdminProviderSummary {
  documentList: VerificationDocument[];
}

/** GET /admin/provider-types: every type, offered or not, with its rules (ADR 0009/0013). */
export interface AdminProviderType {
  code: string;
  name: string;
  isActive: boolean;
  requiredDocuments: RequiredDocumentGroup[];
  /** The full mapping, each listing type with its own active flag. */
  listingTypes: {
    code: string;
    name: string;
    unitLabel: string;
    isBookable: boolean;
    isActive: boolean;
  }[];
  /** What a provider of this type may list now (mapped and both active). */
  usableListingTypes: string[];
}

export interface AuditEntry {
  id: string;
  /** `name` is the user's full name (no contact data); null actor = a system action. */
  actor: { userId: string; role: string | null; name: string | null } | null;
  action: string;
  entity: { type: string; id: string };
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

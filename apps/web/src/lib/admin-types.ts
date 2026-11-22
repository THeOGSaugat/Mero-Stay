import type { PartnerProfile, VerificationDocument } from "./partner-types";

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

export interface AuditEntry {
  id: string;
  actor: { userId: string; role: string | null } | null;
  action: string;
  entity: { type: string; id: string };
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

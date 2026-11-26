import type { CancellationTier, PolicyTerms } from "./cancellation-policy";
import type { CurrencyInfo, PaymentMethod } from "./api-types";

/**
 * Shapes of the partner API responses (docs/architecture/api.md, "Partner endpoints", ADR 0008).
 * Every `*Minor` field is a digit STRING (or null for an absent optional amount); never convert it
 * to a number. Bank account numbers only ever arrive masked (`accountNumberMasked`).
 */

/** Partner and admin lists: `{ data, page: { page, pageSize, total } }`. */
export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
}

export interface Paged<T> {
  data: T[];
  page: PageInfo;
}

export type ProviderStatus =
  "DRAFT" | "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "SUSPENDED";

/** ADR 0016: AWAITING_UPLOAD → UPLOADED → PENDING (confirmed, for review) → APPROVED | REJECTED. */
export type DocumentStatus = "AWAITING_UPLOAD" | "UPLOADED" | "PENDING" | "APPROVED" | "REJECTED";

export interface RequiredDocumentGroup {
  requirement: string;
  acceptedDocumentTypes: string[];
}

/** GET /provider-types (public): only types offered at onboarding, with required documents. */
export interface AllowedListingType {
  code: string;
  name: string;
  unitLabel: string;
  isBookable: boolean;
}

export interface ProviderTypeOffer {
  code: string;
  name: string;
  description: string | null;
  requiredDocuments: RequiredDocumentGroup[];
  /** The listing types this kind of business may create (ADR 0013). */
  allowedListingTypes: AllowedListingType[];
}

export interface PayoutAccount {
  id: string;
  bankName: string;
  branch: string | null;
  accountName: string;
  /** Last 4 only, e.g. "••••9012". The full number is never returned. */
  accountNumberMasked: string;
  verified: boolean;
  verifiedAt: string | null;
}

export interface PartnerProfile {
  id: string;
  providerType: {
    code: string;
    name: string;
    isActive?: boolean;
    /** What this business may list now: mapped to its type AND active (ADR 0013). */
    allowedListingTypes: AllowedListingType[];
  };
  legalName: string;
  displayName: string;
  description: string | null;
  status: ProviderStatus;
  verifiedAt: string | null;
  rejectionReason: string | null;
  contact: { email: string | null; phone: string | null; addressLine: string | null };
  tax: {
    panNumber: string | null;
    vatNumber: string | null;
    businessRegistrationNo: string | null;
  };
  payoutAccount: PayoutAccount | null;
  documents: Record<DocumentStatus, number>;
  commissionRateBps: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A partner's own cancellation policy (ADR 0015). */
export interface CancellationPolicy {
  id: string;
  name: string;
  description: string;
  nonRefundable: boolean;
  rules: CancellationTier[];
  isActive: boolean;
  isPlatformTemplate: boolean;
  createdAt: string;
  updatedAt: string;
  usage?: { listings: number; providerDefault: boolean };
}

export interface PolicyList {
  defaultPolicyId: string | null;
  policies: CancellationPolicy[];
}

export interface VerificationDocument {
  id: string;
  documentType: string;
  status: DocumentStatus;
  /** Display name only. The file itself is fetched through the API, never by a storage key. */
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  hasFile: boolean;
  uploadedAt: string | null;
  documentNumber: string | null;
  expiresOn: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export type ListingStatus =
  "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "SUSPENDED" | "ARCHIVED";

export interface ManagedListing extends CurrencyInfo {
  id: string;
  status: ListingStatus;
  listingType: { code: string; name: string; unitLabel: string; isBookable: boolean };
  title: string;
  slug: string;
  description: string | null;
  parent: { id: string; title: string } | null;
  location: { id: string; name: string; slug: string } | null;
  addressLine: string | null;
  basePriceMinor: string;
  serviceChargeRateBps: number;
  taxRateBps: number;
  commissionRateBps: number | null;
  defaultCancellationPolicyId: string | null;
  attributes: Record<string, unknown>;
  details: Record<string, unknown> | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventorySlot {
  id: string;
  date: string;
  status: "OPEN" | "CLOSED";
  capacityTotal: number;
  capacityBooked: number;
  available: number;
  priceOverrideMinor: string | null;
  effectivePriceMinor: string;
}

export interface SlotsPayload extends CurrencyInfo {
  listingId: string;
  basePriceMinor: string;
  slots: InventorySlot[];
}

/** POST/PATCH slots add counts to the payload. */
export interface SlotsWriteResult extends SlotsPayload {
  created?: number;
  unchanged?: number;
  updated?: number;
  missingDates?: string[];
}

export interface LocationNode {
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  slug: string;
  hasChildren: boolean;
}

export interface ProviderBooking extends CurrencyInfo {
  id: string;
  tripReference: string;
  status: string;
  listing: { id: string; title: string; listingType: string };
  startDate: string;
  endDate: string | null;
  quantity: number;
  travellerCount: number;
  /** Name only; email and phone arrive masked from the API. */
  customer: { name: string; emailMasked: string | null; phoneMasked: string | null };
  paymentMethod: PaymentMethod;
  paymentStatus: string;
  commissionStatus: string;
  payoutStatus: string;
  money: {
    subtotalMinor: string;
    serviceChargeMinor: string;
    taxMinor: string;
    totalMinor: string;
    commissionRateBps: number;
    commissionMinor: string;
    providerPayoutMinor: string;
    paidOnlineMinor: string;
    refundedMinor: string;
  };
  commissionInvoice: { id: string; number: string; status: string } | null;
  settledAt: string | null;
  settledBy: { role: string; name: string } | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface ProviderBookingDetail extends ProviderBooking {
  lines: { date: string; units: number; unitPriceMinor: string; amountMinor: string }[];
  cancellationPolicy: PolicyTerms | null;
  attributes: Record<string, unknown> | null;
}

export interface CommissionInvoice extends CurrencyInfo {
  id: string;
  number: string;
  status: string;
  tripId: string;
  provider: { id: string; name: string };
  amountMinor: string;
  issuedAt: string | null;
  dueOn: string | null;
  paidAt: string | null;
  items: {
    id: string;
    listingId: string;
    listingType: string;
    paymentStatus: string;
    commissionStatus: string;
    subtotalMinor: string;
    commissionRateBps: number;
    commissionMinor: string;
  }[];
}

export interface PayoutSummaryRow extends CurrencyInfo {
  provider: { id: string; name: string };
  period: string;
  items: number;
  subtotalMinor: string;
  serviceChargeMinor: string;
  taxMinor: string;
  totalMinor: string;
  commissionMinor: string;
  providerPayoutMinor: string;
  payoutStatus: "PENDING";
  executed: false;
}

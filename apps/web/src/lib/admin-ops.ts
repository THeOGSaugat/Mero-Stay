import type { CurrencyInfo } from "./api-types";

/**
 * Phase 12 admin operations in the web app (ADR 0018): payout batches, admin accounts, listing
 * review, late payments and refund requests. Types mirror the API; helpers are pure and
 * unit-tested. Money is formatted from the API's strings only; the UI computes no totals.
 */

export type PayoutBatchStatus = "PENDING" | "SCHEDULED" | "PAID" | "FAILED";

export interface PayoutBatch extends CurrencyInfo {
  id: string;
  provider: { id: string; name: string };
  period: string;
  periodStart: string;
  periodEnd: string;
  status: PayoutBatchStatus;
  grossMinor: string;
  commissionMinor: string;
  netMinor: string;
  itemCount: number;
  payoutAccountLabel: string | null;
  bankReferenceMasked: string | null;
  scheduledAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface PayoutBatchItem extends CurrencyInfo {
  id: string;
  trip: { id: string; reference: string };
  listing: { id: string; title: string; listingType: string };
  startDate: string;
  endDate: string | null;
  quantity: number;
  totalMinor: string;
  commissionMinor: string;
  netMinor: string;
}

export interface PayoutBatchDetail extends PayoutBatch {
  items: PayoutBatchItem[];
}

const PAYOUT_BATCH_LABELS: Record<PayoutBatchStatus, string> = {
  PENDING: "Ready to schedule",
  SCHEDULED: "Scheduled for transfer",
  PAID: "Paid",
  FAILED: "Transfer failed",
};

export function payoutBatchStatusLabel(status: string): string {
  return PAYOUT_BATCH_LABELS[status as PayoutBatchStatus] ?? status;
}

export function payoutBatchTone(status: string): "good" | "wait" | "neutral" | "bad" {
  return status === "PAID"
    ? "good"
    : status === "FAILED"
      ? "bad"
      : status === "SCHEDULED"
        ? "neutral"
        : "wait";
}

export type PayoutAction = "schedule" | "mark-paid" | "mark-failed";

/** What an admin can do next with a batch (the API re-checks every step). */
export function payoutActions(status: string): PayoutAction[] {
  if (status === "PENDING") return ["schedule"];
  if (status === "SCHEDULED") return ["mark-paid", "mark-failed"];
  return [];
}

/** The month before `today` ("2026-11-26" → "2026-10"): the usual month to pay out. */
export function previousMonth(today: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(today);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 1 ? `${year - 1}-12` : `${match[1]}-${String(month - 1).padStart(2, "0")}`;
}

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// ------------------------------------------------------------------ admin accounts
export interface AdminAccount {
  id: string;
  email: string | null;
  fullName: string;
  status: "ACTIVE" | "SUSPENDED";
  setupPending: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SetupLink {
  setupPath: string;
  expiresAt: string;
}

/** The token from the setup page's fragment ("#token=…"), or null if it is not a valid one. */
export function setupTokenFromHash(hash: string): string | null {
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
  return match ? match[1]! : null;
}

/** The full link to hand over: this site's origin + the API's path (never stored by the UI). */
export function setupUrl(origin: string, link: SetupLink): string {
  return `${origin.replace(/\/+$/, "")}${link.setupPath}`;
}

export function adminAccountLabel(admin: Pick<AdminAccount, "status" | "setupPending">): string {
  if (admin.status === "SUSPENDED") return "Suspended";
  return admin.setupPending ? "Invited (no password yet)" : "Active";
}

// ------------------------------------------------------------------ listing review
export interface ReviewListing {
  id: string;
  title: string;
  status: string;
  listingType: { code: string; isActive: boolean };
  provider: { id: string; name: string; providerType: string; status: string };
  location: { id: string; name: string; slug: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  submittedAt: string;
  typeRule: { allowed: boolean; reason: string | null; allowedListingTypes: string[] };
}

/** Why approval would be refused, in words (the API decides; this is a hint). */
export function typeRuleText(rule: ReviewListing["typeRule"]): string {
  if (rule.allowed) return "Allowed for this kind of business";
  const allowed = rule.allowedListingTypes.length
    ? `Allowed: ${rule.allowedListingTypes.map((t) => t.replace(/_/g, " ")).join(", ")}.`
    : "This kind of business can list nothing right now.";
  if (rule.reason === "listing_type_not_offered")
    return `This listing type is switched off. ${allowed}`;
  if (rule.reason === "provider_type_not_offered")
    return `This kind of business is switched off. ${allowed}`;
  return `Not allowed for this kind of business. ${allowed}`;
}

// ------------------------------------------------------------------ queues
export interface LatePayment extends CurrencyInfo {
  id: string;
  paymentId: string;
  trip: { id: string; reference: string };
  gateway: string;
  gatewayTransactionId: string;
  amountMinor: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const RECONCILIATION_REASONS: Record<string, string> = {
  PAYMENT_NOT_OPEN: "Paid after the booking hold ended",
  TRIP_NOT_AWAITING_PAYMENT: "Trip no longer waiting for payment",
  INTENT_STALE: "Amount due changed before payment",
  AMOUNT_MISMATCH: "Gateway took a different amount",
  DUPLICATE_PAYMENT: "Paid twice",
};

export function reconciliationReasonLabel(reason: string): string {
  return RECONCILIATION_REASONS[reason] ?? reason;
}

export interface RefundRequestRow extends CurrencyInfo {
  id: string;
  paymentId: string;
  bookingItemId: string | null;
  paymentReconciliationId: string | null;
  gateway: string;
  gatewayRefundCapability: { api: "documented" | "none"; partial: boolean; note: string };
  amountMinor: string;
  reason: string;
  status: string;
  executed: boolean;
  createdAt: string;
}

export function refundStatusLabel(status: string): string {
  return status === "REQUESTED"
    ? "Requested (not executed)"
    : status === "REJECTED"
      ? "Rejected"
      : status;
}

export function gatewayName(gateway: string): string {
  return gateway === "esewa" ? "eSewa" : gateway === "khalti" ? "Khalti" : gateway;
}

import type {
  DocumentStatus,
  ListingStatus,
  PayoutAccount,
  RequiredDocumentGroup,
  VerificationDocument,
} from "./partner-types";

/**
 * Display helpers for the partner dashboard (Phase 7 Track B). Pure functions only, so they are
 * unit-tested. Money is never computed here: amounts are formatted with lib/money.ts from the
 * API's strings. Rates (basis points) are integers, and so are document counts.
 */

const MASK = "••••";

/**
 * The masked account number exactly as the API sent it, or a full mask if it doesn't look
 * masked. The API never returns full numbers; this is a second line of defence so the UI can
 * never show more than the last four characters, whatever it receives.
 */
export function safeMaskedAccountNumber(value: unknown): string {
  if (typeof value !== "string") return MASK;
  return /^•{2,}[0-9A-Za-z-]{0,4}$/.test(value) ? value : MASK;
}

/** "Nabil Bank · ••••9012" (or a prompt to add one). */
export function payoutAccountSummary(account: PayoutAccount | null): string {
  if (!account) return "No payout account yet";
  return `${account.bankName} · ${safeMaskedAccountNumber(account.accountNumberMasked)}`;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  OWNER_ID: "Owner's citizenship or passport",
  BUSINESS_REGISTRATION: "Business registration certificate",
  LOCAL_GOVERNMENT_REGISTRATION: "Ward / municipality registration",
  PAN_CERTIFICATE: "PAN certificate",
  VAT_CERTIFICATE: "VAT certificate",
  TOURISM_LICENSE: "Tourism licence",
  GUIDE_LICENSE: "Guide licence",
  VEHICLE_ROUTE_PERMIT: "Vehicle route permit",
  PROPERTY_OWNERSHIP_OR_LEASE: "Property ownership or lease",
  BANK_PROOF: "Bank account proof",
  OTHER: "Other document",
};

export const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABELS);

export function documentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABELS[type] ?? humanize(type);
}

const REQUIREMENT_LABELS: Record<string, string> = {
  identity: "Identity",
  registration: "Business registration",
  tax: "Tax registration",
  licence: "Licence or permit",
};

export function requirementLabel(requirement: string): string {
  return REQUIREMENT_LABELS[requirement] ?? humanize(requirement);
}

function humanize(code: string): string {
  const text = code.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type RequirementState = "approved" | "pending" | "missing";

export interface RequirementRow {
  requirement: string;
  label: string;
  acceptedDocumentTypes: string[];
  state: RequirementState;
  /** The document that satisfies the group (an approved one first), if any. */
  satisfiedBy: VerificationDocument | null;
}

/**
 * The required-document checklist (ADR 0009): one row per group of the provider type, satisfied
 * by ONE document of any accepted type that is approved or pending. Rejected documents never
 * count. This is for display; the API enforces the same rule at submit and before approval.
 */
export function requirementChecklist(
  groups: readonly RequiredDocumentGroup[],
  documents: readonly VerificationDocument[],
): RequirementRow[] {
  return groups.map((group) => {
    const matching = documents.filter((d) => group.acceptedDocumentTypes.includes(d.documentType));
    const approved = matching.find((d) => d.status === "APPROVED");
    const pending = matching.find((d) => d.status === "PENDING");
    const satisfiedBy = approved ?? pending ?? null;
    return {
      requirement: group.requirement,
      label: requirementLabel(group.requirement),
      acceptedDocumentTypes: group.acceptedDocumentTypes,
      state: approved ? "approved" : pending ? "pending" : "missing",
      satisfiedBy,
    };
  });
}

const PROVIDER_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Not submitted",
  PENDING_VERIFICATION: "Waiting for verification",
  VERIFIED: "Verified",
  REJECTED: "Changes requested",
  SUSPENDED: "Suspended",
};

export function providerStatusLabel(status: string): string {
  return PROVIDER_STATUS_LABELS[status] ?? humanize(status);
}

const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  PENDING: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export function documentStatusLabel(status: string): string {
  return DOCUMENT_STATUS_LABELS[status as DocumentStatus] ?? humanize(status);
}

const LISTING_STATUS_LABELS: Record<ListingStatus, string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "In review",
  APPROVED: "Live",
  REJECTED: "Changes requested",
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
};

export function listingStatusLabel(status: string): string {
  return LISTING_STATUS_LABELS[status as ListingStatus] ?? humanize(status);
}

/**
 * The status moves a partner may make (mirrors the API's rule, ADR 0008, so the UI only offers
 * buttons that can work; the API refuses anything else with 409 LISTING_STATUS_NOT_ALLOWED).
 */
const PARTNER_MOVES: Record<ListingStatus, readonly { to: ListingStatus; label: string }[]> = {
  DRAFT: [
    { to: "PENDING_REVIEW", label: "Submit for review" },
    { to: "ARCHIVED", label: "Archive" },
  ],
  REJECTED: [
    { to: "PENDING_REVIEW", label: "Submit again" },
    { to: "DRAFT", label: "Back to draft" },
    { to: "ARCHIVED", label: "Archive" },
  ],
  PENDING_REVIEW: [
    { to: "DRAFT", label: "Withdraw to draft" },
    { to: "ARCHIVED", label: "Archive" },
  ],
  APPROVED: [{ to: "ARCHIVED", label: "Archive" }],
  ARCHIVED: [{ to: "DRAFT", label: "Reopen as draft" }],
  SUSPENDED: [],
};

export function partnerListingMoves(status: string): readonly { to: string; label: string }[] {
  return PARTNER_MOVES[status as ListingStatus] ?? [];
}

const COMMISSION_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  INVOICED: "Invoiced",
  PAID: "Paid",
  WAIVED: "Waived",
};

export function commissionStatusLabel(status: string): string {
  return COMMISSION_STATUS_LABELS[status] ?? humanize(status);
}

const PAYOUT_STATUS_LABELS: Record<string, string> = {
  NOT_APPLICABLE: "Not applicable",
  PENDING: "Pending",
  ON_HOLD: "On hold",
  PAID: "Paid",
};

export function payoutStatusLabel(status: string): string {
  return PAYOUT_STATUS_LABELS[status] ?? humanize(status);
}

const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  ISSUED: "Issued",
  PAID: "Paid",
  VOID: "Void",
};

export function invoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABELS[status] ?? humanize(status);
}

/** Basis points as a percentage: 1500 → "15%", 1250 → "12.5%", 5 → "0.05%". */
export function bpsToPercentText(bps: number | null | undefined): string {
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0) return "—";
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}

/**
 * A percentage typed by the partner ("13", "12.5", "0.05") → basis points (1300, 1250, 5), with
 * string operations only. Empty → 0. Anything else, or above 100%, → null (invalid).
 */
export function percentInputToBps(input: string): number | null {
  const text = input.trim();
  if (text === "") return 0;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const bps =
    Number.parseInt(match[1]!, 10) * 100 + Number.parseInt((match[2] ?? "").padEnd(2, "0"), 10);
  return bps <= 10_000 ? bps : null;
}

/** Basis points back into the percentage input ("1250" → "12.5"). */
export function bpsToPercentInput(bps: number): string {
  return bpsToPercentText(bps).replace("%", "");
}

/** "2.4 MB", "820 KB", for document sizes (integers, not money). */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const kathmanduTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kathmandu",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A UTC timestamp from the API in Nepal time: "22 Nov 2026, 14:35 NPT". */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${kathmanduTime.format(date)} NPT`;
}

/** "2026-12" → "December 2026" (a payout reporting period). */
export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(date);
}

const kathmanduDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kathmandu",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Nepal (UTC+05:45) as YYYY-MM-DD. */
export function kathmanduToday(now: Date = new Date()): string {
  return kathmanduDay.format(now);
}

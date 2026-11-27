import { formatMoney } from "./money";
import type { CurrencyInfo } from "./api-types";

/**
 * Cancellations, refunds, settlement reconciliation and clawbacks in the web app (Phase 14,
 * ADR 0020). Pure presentation: every amount comes from the API as a digit string and is only
 * formatted here (money.ts); the UI computes no refund, commission or payout.
 */

// ------------------------------------------------------------------ customer cancellation

/** GET /trips/:id/items/:itemId/cancellation (no commission in the customer view). */
export interface CancellationPreview extends CurrencyInfo {
  itemId: string;
  status: string;
  cancellable: boolean;
  refusal: { code: string; message: string } | null;
  serviceStartsAt: string;
  /** "YYYY-MM-DDTHH:MM" in Nepal time. */
  serviceStartsAtNepal: string;
  serviceStartSource: "LISTING_TIME" | "DEFAULT_MIDNIGHT";
  evaluatedAt: string;
  noticeMinutes: number;
  policy: { name: string | null; attached: boolean; nonRefundable: boolean | null };
  tier: { minHoursBeforeStart: number; refundBps: number } | null;
  refundBps: number;
  paymentMethod: "ONLINE" | "PAY_AT_PROPERTY";
  paidMinor: string;
  refundMinor: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-20T14:00" (Nepal time) → "20 Dec 2026, 14:00". String operations only. */
export function formatNepalStart(local: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(local);
  if (!match) return local;
  const [, year, month, day, time] = match;
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${time}`;
}

/** 5000 → "50%", 2550 → "25.5%", 10000 → "100%". Basis points, not money. */
export function percentOfBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return `${whole}%`;
  return `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
}

/** "3 days 4 hours" / "45 minutes": how much notice cancelling now gives. */
export function formatNotice(minutes: number): string {
  if (minutes <= 0) return "no notice";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (days > 0)
    return hours > 0 ? `${part(days, "day")} ${part(hours, "hour")}` : part(days, "day");
  if (hours > 0)
    return mins > 0 ? `${part(hours, "hour")} ${part(mins, "minute")}` : part(hours, "hour");
  return part(mins, "minute");
}

/** "Starts 20 Dec 2026, 14:00 (Nepal time)" for a booking card. */
export function itemStartLabel(item: {
  serviceStartsAtNepal: string;
  serviceStartSource: "LISTING_TIME" | "DEFAULT_MIDNIGHT";
}): string {
  const when = formatNepalStart(item.serviceStartsAtNepal);
  return item.serviceStartSource === "DEFAULT_MIDNIGHT"
    ? `Starts ${when.replace(/, 00:00$/, "")} (no start time given)`
    : `Starts ${when} (Nepal time)`;
}

/** The lines a customer reads before confirming a cancellation. */
export function cancellationSummary(preview: CancellationPreview): {
  startLine: string;
  startNote: string | null;
  refundLine: string;
  policyLine: string;
} {
  const money = (minor: string) => formatMoney(minor, preview.currency, preview.currencyExponent);
  const startLine = `Starts ${formatNepalStart(preview.serviceStartsAtNepal)} (Nepal time)`;
  const startNote =
    preview.serviceStartSource === "DEFAULT_MIDNIGHT"
      ? "This listing has no start time, so the refund counts from midnight at the start of that day."
      : null;
  let refundLine: string;
  if (preview.paymentMethod === "PAY_AT_PROPERTY") {
    refundLine =
      "You have not paid anything through MeroStay for this booking, so nothing is refunded.";
  } else if (preview.refundMinor === "0") {
    refundLine = `No refund: you keep nothing back of the ${money(preview.paidMinor)} paid.`;
  } else {
    refundLine = `You get ${money(preview.refundMinor)} back (${percentOfBps(preview.refundBps)} of ${money(preview.paidMinor)}).`;
  }
  const policyLine = !preview.policy.attached
    ? "No cancellation policy was attached to this booking: cancelling gives no refund."
    : preview.policy.nonRefundable
      ? "This booking is non-refundable."
      : preview.tier
        ? `${preview.policy.name ?? "Policy"}: cancelling at least ${preview.tier.minHoursBeforeStart} hours before the start gives ${percentOfBps(preview.tier.refundBps)} back. You are cancelling ${formatNotice(preview.noticeMinutes)} before.`
        : `${preview.policy.name ?? "Policy"}: you are cancelling ${formatNotice(preview.noticeMinutes)} before the start, later than any refund tier.`;
  return { startLine, startNote, refundLine, policyLine };
}

// ------------------------------------------------------------------ admin refund queue

export type RefundStatus =
  "REQUESTED" | "APPROVED" | "PROCESSING" | "COMPLETED" | "FAILED" | "REJECTED";

export interface RefundRow extends CurrencyInfo {
  id: string;
  paymentId: string;
  bookingItemId: string | null;
  paymentReconciliationId: string | null;
  trip: { id: string; reference: string } | null;
  item: {
    id: string;
    title: string;
    status: string;
    paymentStatus: string;
    payoutStatus: string;
  } | null;
  gateway: string;
  gatewayRefundCapability: { api: "documented" | "none"; partial: boolean; note: string };
  amountMinor: string;
  reason: string;
  status: RefundStatus;
  executed: boolean;
  executionMode: "API" | "MANUAL" | null;
  attempts: number;
  gatewayRefundReferenceMasked: string | null;
  note: string | null;
  failureReason: string | null;
  createdAt: string;
  approvedAt: string | null;
  processingAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  rejectedAt: string | null;
}

const REFUND_LABELS: Record<RefundStatus, string> = {
  REQUESTED: "Requested (not executed)",
  APPROVED: "Approved, not sent yet",
  PROCESSING: "Being refunded",
  COMPLETED: "Refunded",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

export function refundStatusText(row: Pick<RefundRow, "status" | "executionMode">): string {
  if (row.status === "PROCESSING" && row.executionMode === "MANUAL") {
    return "Waiting for the manual refund";
  }
  return REFUND_LABELS[row.status] ?? row.status;
}

export function refundStatusTone(status: string): "good" | "wait" | "bad" | "neutral" {
  if (status === "COMPLETED") return "good";
  if (status === "FAILED") return "bad";
  if (status === "REJECTED") return "neutral";
  return "wait";
}

export type RefundAction = "approve" | "reject" | "execute" | "complete" | "check";

/**
 * Which buttons a refund shows. The API decides again (and is idempotent): this only avoids
 * offering steps that cannot work.
 */
export function refundActions(
  row: Pick<RefundRow, "status" | "executionMode" | "gatewayRefundCapability">,
): RefundAction[] {
  switch (row.status) {
    case "REQUESTED":
      return ["approve", "reject"];
    case "APPROVED":
      return ["execute", "reject"];
    case "FAILED":
      return ["execute", "reject"];
    case "PROCESSING":
      // A manual refund is recorded once done; an API refund with a lost answer can be checked
      // with the gateway, or confirmed by hand after looking in its merchant portal.
      return row.executionMode === "MANUAL" ? ["complete"] : ["check", "complete"];
    default:
      return [];
  }
}

/** The execute button's wording: Khalti (API) or a manual refund (eSewa). */
export function executeLabel(
  row: Pick<RefundRow, "gateway" | "gatewayRefundCapability" | "status">,
): string {
  const retry = row.status === "FAILED" ? "Try again: " : "";
  if (row.gatewayRefundCapability.api === "documented") {
    return `${retry}Refund through ${gatewayDisplayName(row.gateway)}`;
  }
  return `${retry}Start a manual refund (${gatewayDisplayName(row.gateway)} merchant portal)`;
}

export function gatewayDisplayName(gateway: string): string {
  return gateway === "esewa"
    ? "eSewa"
    : gateway === "khalti"
      ? "Khalti"
      : gateway === "simulated"
        ? "test gateway"
        : gateway;
}

// ------------------------------------------------------------------ settlements (gap 36)

export type SettlementKind =
  "UNSETTLED_AFTER_SERVICE" | "SETTLED_NOT_INVOICED" | "SETTLED_BEFORE_SERVICE";

export interface SettlementEntry extends CurrencyInfo {
  itemId: string;
  trip: { id: string; reference: string };
  listing: { title: string };
  provider: { id: string; name: string };
  status: string;
  startDate: string;
  endDate: string | null;
  serviceStartsAt: string;
  paymentStatus: string;
  paymentSettledAt: string | null;
  commissionStatus: string;
  invoice: { id: string; number: string; status: string } | null;
  totalMinor: string;
  commissionMinor: string;
  mismatches: {
    kind: SettlementKind;
    resolution: { note: string; resolvedAt: string; resolvedById: string | null } | null;
  }[];
}

const SETTLEMENT_LABELS: Record<SettlementKind, string> = {
  UNSETTLED_AFTER_SERVICE: "Invoiced, service over, payment never recorded",
  SETTLED_NOT_INVOICED: "Recorded as paid, but no commission invoice",
  SETTLED_BEFORE_SERVICE: "Recorded as paid before the service started",
};

export function settlementKindLabel(kind: string): string {
  return SETTLEMENT_LABELS[kind as SettlementKind] ?? kind;
}

// ------------------------------------------------------------------ clawbacks (gap 39)

export interface Clawback extends CurrencyInfo {
  id: string;
  provider: { id: string; name: string };
  bookingItem: { id: string; title: string; tripReference: string };
  paidOutInPayoutId: string;
  amountMinor: string;
  recoveredMinor: string;
  outstandingMinor: string;
  recoveries: { payoutId: string; payoutStatus: string; amountMinor: string; counts: boolean }[];
  reason: string;
  createdAt: string;
}

export function clawbackSettled(row: Pick<Clawback, "outstandingMinor">): boolean {
  return /^0+$/.test(row.outstandingMinor);
}

/** Whether a payout batch had clawbacks deducted (its deductions are not zero). */
export function hasDeductions(batch: { deductionsMinor?: string }): boolean {
  return batch.deductionsMinor !== undefined && !/^0+$/.test(batch.deductionsMinor);
}

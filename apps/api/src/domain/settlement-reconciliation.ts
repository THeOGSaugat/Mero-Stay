import { lastServiceDate } from "./payouts.js";

/**
 * Pay-at-property settlement reconciliation (gap 36, ADR 0020). Pure, unit-tested; the SQL in the
 * reconciliation service mirrors it.
 *
 * Partners record that a customer paid at the property (PAID_AT_PROPERTY, Phase 6); MeroStay invoices
 * the provider the commission when the trip is confirmed (ADR 0007). A mismatch is where the two
 * stories disagree. Nothing here moves money: an admin looks into each one and records what was
 * done (audited).
 */

export type SettlementMismatchKind =
  /** Invoiced, the service is over (Nepal date), but the partner never recorded the payment. */
  | "UNSETTLED_AFTER_SERVICE"
  /** Recorded as paid at the property, but its commission is not invoiced (or was waived). */
  | "SETTLED_NOT_INVOICED"
  /** Recorded as paid before the service even started (a mistake, or paid in advance). */
  | "SETTLED_BEFORE_SERVICE";

export const SETTLEMENT_MISMATCH_KINDS: readonly SettlementMismatchKind[] = [
  "UNSETTLED_AFTER_SERVICE",
  "SETTLED_NOT_INVOICED",
  "SETTLED_BEFORE_SERVICE",
];

export interface SettlementItem {
  status: string;
  paymentStatus: string;
  commissionStatus: string;
  commissionInvoiceId: string | null;
  startDate: string;
  endDate: string | null;
  serviceStartsAt: Date;
  paymentSettledAt: Date | null;
}

const LIVE = ["CONFIRMED", "IN_PROGRESS", "COMPLETED"];

/** The mismatches of one pay-at-property item today (Nepal date). */
export function settlementMismatches(
  item: SettlementItem,
  todayNepal: string,
): SettlementMismatchKind[] {
  const kinds: SettlementMismatchKind[] = [];
  if (!LIVE.includes(item.status)) return kinds;
  const invoiced =
    (item.commissionStatus === "INVOICED" || item.commissionStatus === "PAID") &&
    item.commissionInvoiceId !== null;
  if (
    item.paymentStatus === "PAY_AT_PROPERTY" &&
    invoiced &&
    lastServiceDate(item.startDate, item.endDate) < todayNepal
  ) {
    kinds.push("UNSETTLED_AFTER_SERVICE");
  }
  if (item.paymentStatus === "PAID_AT_PROPERTY") {
    if (!invoiced) kinds.push("SETTLED_NOT_INVOICED");
    if (item.paymentSettledAt && item.paymentSettledAt < item.serviceStartsAt) {
      kinds.push("SETTLED_BEFORE_SERVICE");
    }
  }
  return kinds;
}

import { addDays } from "./dates.js";

/**
 * Payout rules (Phase 12, ADR 0018; owner decision 2026-11-26). Pure, unit-tested.
 *
 * - An online-paid item becomes eligible for a payout once its service has ENDED in Nepal time
 *   and it was not cancelled: never paying out money that may still have to be refunded.
 * - One payout per provider, currency and calendar month of the item's service (start) date.
 * - Net payout = gross − commission − deductions (ADR 0008; Phase 14, ADR 0020):
 *   gross = what MeroStay kept per item (total − refunded), commission = the commission on it (the
 *   kept commission of a customer-cancelled item, else the snapshot), deductions = clawbacks of
 *   paid-out voided bookings recovered from this batch.
 * - A customer-cancelled item (Phase 14) is paid out what it kept, once its refund is completed;
 *   a voided item never is.
 * - Manual bank transfer, recorded: PENDING → SCHEDULED → PAID | FAILED.
 */

export type PayoutBatchStatus = "PENDING" | "SCHEDULED" | "PAID" | "FAILED";

const TRANSITIONS: Record<PayoutBatchStatus, readonly PayoutBatchStatus[]> = {
  PENDING: ["SCHEDULED"],
  SCHEDULED: ["PAID", "FAILED"],
  PAID: [],
  FAILED: [],
};

export function canMovePayout(from: PayoutBatchStatus, to: PayoutBatchStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-11" → { start: "2026-11-01", end: "2026-11-30" } (inclusive calendar dates). */
export function payoutPeriod(month: string): { start: string; end: string } {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError(`not a month: ${month}`);
  const year = Number(match[1]);
  const m = Number(match[2]);
  const start = `${match[1]}-${match[2]}-01`;
  const next = m === 12 ? `${year + 1}-01-01` : `${match[1]}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(next, -1) };
}

export function isPayoutMonth(value: string): boolean {
  return MONTH.test(value);
}

/** The last day of service: the day before check-out for ranges, else the single date. */
export function lastServiceDate(startDate: string, endDate: string | null): string {
  return endDate ? addDays(endDate, -1) : startDate;
}

export interface PayoutCandidate {
  status: string;
  paymentStatus: string;
  payoutStatus: string;
  payoutId: string | null;
  startDate: string;
  endDate: string | null;
  /** An unfinished (REQUESTED, APPROVED, PROCESSING, FAILED) refund request holds it back. */
  hasOpenRefundRequest: boolean;
  /** Set when the customer cancelled (Phase 14): the refund owed at cancelling. */
  cancellationRefundMinor?: bigint | null;
  voided?: boolean;
  totalMinor?: bigint;
  refundedMinor?: bigint;
}

const PAYABLE_ITEM_STATUSES = ["CONFIRMED", "IN_PROGRESS", "COMPLETED", "NO_SHOW"];

/** Eligible today (Nepal date) for a payout of its service month. */
export function isPayoutEligible(item: PayoutCandidate, todayNepal: string): boolean {
  const common =
    item.payoutStatus === "PENDING" &&
    item.payoutId === null &&
    !item.hasOpenRefundRequest &&
    lastServiceDate(item.startDate, item.endDate) < todayNepal;
  if (!common) return false;
  if (PAYABLE_ITEM_STATUSES.includes(item.status)) return item.paymentStatus === "PAID";
  // Customer-cancelled with money kept: refund done, something left (mirrors the SQL guard).
  const refundOwed = item.cancellationRefundMinor;
  return (
    item.status === "CANCELLED" &&
    refundOwed !== null &&
    refundOwed !== undefined &&
    item.voided !== true &&
    (item.paymentStatus === "PAID" || item.paymentStatus === "PARTIALLY_REFUNDED") &&
    (item.refundedMinor ?? 0n) === refundOwed &&
    refundOwed < (item.totalMinor ?? 0n)
  );
}

export interface PayoutLine {
  totalMinor: bigint;
  commissionMinor: bigint;
  /** Completed refunds (customer-cancelled items); 0 otherwise. */
  refundedMinor?: bigint;
  /** Commission on the kept part of a customer-cancelled item (replaces commissionMinor). */
  keptCommissionMinor?: bigint | null;
}

/** One item's line: what was kept, its commission, and the provider's share. */
export function payoutLine(item: PayoutLine): {
  grossMinor: bigint;
  commissionMinor: bigint;
  netMinor: bigint;
} {
  const gross = item.totalMinor - (item.refundedMinor ?? 0n);
  const commission = item.keptCommissionMinor ?? item.commissionMinor;
  return { grossMinor: gross, commissionMinor: commission, netMinor: gross - commission };
}

export function sumPayout(
  items: readonly PayoutLine[],
  deductionsMinor = 0n,
): {
  grossMinor: bigint;
  commissionMinor: bigint;
  deductionsMinor: bigint;
  netMinor: bigint;
  itemCount: number;
} {
  let gross = 0n;
  let commission = 0n;
  for (const item of items) {
    const line = payoutLine(item);
    gross += line.grossMinor;
    commission += line.commissionMinor;
  }
  if (deductionsMinor < 0n || deductionsMinor > gross - commission) {
    throw new RangeError("deductions must be between 0 and the net before deductions");
  }
  return {
    grossMinor: gross,
    commissionMinor: commission,
    deductionsMinor,
    netMinor: gross - commission - deductionsMinor,
    itemCount: items.length,
  };
}

/** A bank transfer reference as shown in responses and audit rows: "••••7788". */
export function maskReference(reference: string | null): string | null {
  if (reference === null) return null;
  const compact = reference.replace(/\s+/g, "");
  return compact.length <= 4 ? "••••" : `••••${compact.slice(-4)}`;
}

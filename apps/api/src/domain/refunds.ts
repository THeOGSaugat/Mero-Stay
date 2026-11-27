import { BPS_DENOMINATOR, applyRate } from "./money.js";
import { isIsoDate } from "./dates.js";
import type { CancellationRule, CancellationTier } from "./cancellation-policy.js";

/**
 * Customer cancellations and refunds (Phase 14, ADR 0020). Pure, unit-tested; the trips and
 * refunds services carry them out, and the database re-checks every amount.
 *
 * THE REFUND CLOCK (owner decision 2026-11-27): "N hours before the start" counts from the ACTUAL
 * start of the service, frozen on the booking item as an exact instant: the start date at the
 * listing's check-in / departure / start time, Nepal time (UTC+05:45, no daylight saving). A listing
 * without a start time falls back to 00:00 Nepal time of the start date, and says so.
 *
 * AMOUNTS (owner decisions 2026-11-27):
 * - refund = round_half_up(paid × tier bps / 10000); a confirmed online item is fully paid, so
 *   paid = its total. Pay-at-property: nothing was paid through MeroStay, refund 0.
 * - commission on the part KEPT = round_half_up(subtotal × (10000 − bps) × rate / 10⁸), never more
 *   than what is kept. Nothing kept (pay-at-property, or a full refund) → commission waived.
 * - no policy, or non-refundable: the customer may still cancel; refund 0.
 */

/** Nepal is UTC+05:45 all year (no daylight saving). */
export const NEPAL_OFFSET_MINUTES = 5 * 60 + 45;

const HH_MM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export type ServiceStartSource = "LISTING_TIME" | "DEFAULT_MIDNIGHT";

export interface ServiceStart {
  startsAt: Date;
  source: ServiceStartSource;
}

/**
 * The instant a service starts: `date` ("YYYY-MM-DD", the Nepal calendar date) at `time`
 * ("HH:MM", Nepal time), as a UTC Date. No time → 00:00 Nepal time, marked DEFAULT_MIDNIGHT.
 */
export function serviceStart(date: string, time: string | null | undefined): ServiceStart {
  if (!isIsoDate(date)) throw new RangeError(`not a date: ${date}`);
  const match = time ? HH_MM.exec(time) : null;
  if (time && !match) throw new RangeError(`not a time: ${time}`);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  return {
    startsAt: new Date(utcMidnight + (minutes - NEPAL_OFFSET_MINUTES) * 60_000),
    source: match ? "LISTING_TIME" : "DEFAULT_MIDNIGHT",
  };
}

/** The two booking-item columns for a start (fixtures and the trip service use this). */
export function serviceStartFields(
  date: string,
  time: string | null | undefined,
): { serviceStartsAt: Date; serviceStartSource: ServiceStartSource } {
  const start = serviceStart(date, time);
  return { serviceStartsAt: start.startsAt, serviceStartSource: start.source };
}

/** "2026-12-20T14:00" in Nepal time, for messages and tests. */
export function toNepalLocal(instant: Date): string {
  const shifted = new Date(instant.getTime() + NEPAL_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** The frozen policy on an item, read defensively (older snapshots lack `nonRefundable`). */
export function ruleFromSnapshot(snapshot: unknown): CancellationRule | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as { nonRefundable?: unknown; rules?: unknown };
  const tiers = Array.isArray(value.rules)
    ? value.rules.filter(
        (t): t is CancellationTier =>
          !!t &&
          typeof t === "object" &&
          Number.isInteger((t as CancellationTier).minHoursBeforeStart) &&
          Number.isInteger((t as CancellationTier).refundBps),
      )
    : [];
  const nonRefundable = value.nonRefundable === true || tiers.length === 0;
  return { nonRefundable, tiers: nonRefundable ? [] : tiers };
}

export interface TierDecision {
  /** Exact notice in milliseconds (start − cancellation); negative once the service has started. */
  noticeMs: number;
  /** The tier that applies, or null (too late, non-refundable, or no policy). */
  tier: CancellationTier | null;
  refundBps: number;
}

const HOUR_MS = 3_600_000;

/**
 * The tier for cancelling at `cancelledAt`: the first tier (most hours first) whose
 * `minHoursBeforeStart` hours fit into the notice given. Exactly 72 h before the start meets a
 * 72-hour tier; 71 h 59 m 59.999 s does not. Exact instants, never rounded to hours or days.
 */
export function refundTier(
  rule: CancellationRule | null,
  serviceStartsAt: Date,
  cancelledAt: Date,
): TierDecision {
  const noticeMs = serviceStartsAt.getTime() - cancelledAt.getTime();
  if (!rule || rule.nonRefundable || noticeMs < 0) return { noticeMs, tier: null, refundBps: 0 };
  const ordered = [...rule.tiers].sort((a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart);
  const tier = ordered.find((t) => noticeMs >= t.minHoursBeforeStart * HOUR_MS) ?? null;
  return { noticeMs, tier, refundBps: tier?.refundBps ?? 0 };
}

/** round_half_up(subtotal × (10000 − refundBps) × rate / 10⁸): one rounding, like the SQL CHECK. */
export function commissionOnKept(
  subtotalMinor: bigint,
  refundBps: number,
  commissionRateBps: number,
): bigint {
  const keptBps = BigInt(BPS_DENOMINATOR - refundBps);
  const scale = BigInt(BPS_DENOMINATOR) * BigInt(BPS_DENOMINATOR);
  return (subtotalMinor * keptBps * BigInt(commissionRateBps) + scale / 2n) / scale;
}

export type CancelRefusal =
  "NOT_CANCELLABLE_STATUS" | "ALREADY_STARTED" | "SETTLED_AT_PROPERTY" | "NOT_FULLY_PAID";

export interface CancelInput {
  status: string;
  paymentStatus: string;
  commissionStatus: string;
  totalMinor: bigint;
  subtotalMinor: bigint;
  commissionRateBps: number;
  serviceStartsAt: Date;
  /** The item's frozen policy snapshot (or null). */
  policySnapshot: unknown;
}

export type CancelPlan =
  | { ok: false; refusal: CancelRefusal; decision: TierDecision }
  | {
      ok: true;
      decision: TierDecision;
      online: boolean;
      /** What goes back to the customer. */
      refundMinor: bigint;
      /** What MeroStay keeps for the provider (online only). */
      keptMinor: bigint;
      /** Commission on the kept part (0 when waived). */
      keptCommissionMinor: bigint;
      /** WAIVE: nothing kept. KEEP: commission stays open, collected from the payout. */
      commission: "WAIVE" | "WAIVE_AND_ADJUST_INVOICE" | "KEEP";
    };

/**
 * What a customer cancelling this item at `cancelledAt` gets. Only CONFIRMED items before their
 * start; a pay-at-property item already settled at the property is the provider's to refund (an
 * admin can void it). Online confirmed items are always fully PAID (ADR 0007).
 */
export function planCustomerCancellation(item: CancelInput, cancelledAt: Date): CancelPlan {
  const decision = refundTier(
    ruleFromSnapshot(item.policySnapshot),
    item.serviceStartsAt,
    cancelledAt,
  );
  if (item.status !== "CONFIRMED") {
    return { ok: false, refusal: "NOT_CANCELLABLE_STATUS", decision };
  }
  if (decision.noticeMs <= 0) return { ok: false, refusal: "ALREADY_STARTED", decision };
  if (item.paymentStatus === "PAID_AT_PROPERTY") {
    return { ok: false, refusal: "SETTLED_AT_PROPERTY", decision };
  }
  const online = item.paymentStatus !== "PAY_AT_PROPERTY";
  if (online && item.paymentStatus !== "PAID") {
    return { ok: false, refusal: "NOT_FULLY_PAID", decision };
  }

  if (!online) {
    return {
      ok: true,
      decision,
      online,
      refundMinor: 0n,
      keptMinor: 0n,
      keptCommissionMinor: 0n,
      commission: item.commissionStatus === "INVOICED" ? "WAIVE_AND_ADJUST_INVOICE" : "WAIVE",
    };
  }
  const refundMinor = applyRate(item.totalMinor, decision.refundBps);
  const keptMinor = item.totalMinor - refundMinor;
  if (keptMinor === 0n) {
    return {
      ok: true,
      decision,
      online,
      refundMinor,
      keptMinor,
      keptCommissionMinor: 0n,
      commission: "WAIVE",
    };
  }
  const commission = commissionOnKept(
    item.subtotalMinor,
    decision.refundBps,
    item.commissionRateBps,
  );
  return {
    ok: true,
    decision,
    online,
    refundMinor,
    keptMinor,
    keptCommissionMinor: commission < keptMinor ? commission : keptMinor,
    commission: "KEEP",
  };
}

/**
 * Splits a refund over the charges that paid an item, newest first, never more than each paid.
 * (Usually one charge pays the item.)
 */
export function splitRefund(
  refundMinor: bigint,
  allocations: readonly { paymentId: string; amountMinor: bigint }[],
): { paymentId: string; amountMinor: bigint }[] {
  let left = refundMinor;
  const parts: { paymentId: string; amountMinor: bigint }[] = [];
  for (const allocation of [...allocations].reverse()) {
    if (left === 0n) break;
    const take = allocation.amountMinor < left ? allocation.amountMinor : left;
    if (take > 0n) parts.push({ paymentId: allocation.paymentId, amountMinor: take });
    left -= take;
  }
  if (left !== 0n) throw new RangeError("refund exceeds what was paid");
  return parts;
}

// ------------------------------------------------------------------ refund execution

export type RefundStatus =
  "REQUESTED" | "APPROVED" | "PROCESSING" | "COMPLETED" | "FAILED" | "REJECTED";

const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["PROCESSING", "REJECTED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  // Retry, or give up (handled outside MeroStay, with a note).
  FAILED: ["PROCESSING", "REJECTED"],
  COMPLETED: [],
  REJECTED: [],
};

/** Mirrors refund_requests_guard (the database re-checks every change). */
export function canMoveRefund(from: RefundStatus, to: RefundStatus): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

/** The item's payment status once `refundedMinor` of what was `paidMinor` has gone back. */
export function paymentStatusAfterRefunds(
  paidMinor: bigint,
  refundedMinor: bigint,
): "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" {
  if (refundedMinor < 0n || refundedMinor > paidMinor) {
    throw new RangeError("refunded must be between 0 and what was paid");
  }
  if (refundedMinor === 0n) return "PAID";
  return refundedMinor === paidMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
}

/**
 * What voiding a booking item does (Phase 12, gap 13, ADR 0018). Pure, unit-tested; the moderation
 * service carries it out in one transaction holding the trip lock.
 *
 * A void is an admin correction ("this booking should not exist"): the item becomes CANCELLED,
 * its held inventory is released, its commission is WAIVED, and money the customer paid online is
 * queued as a refund REQUEST (never executed here). Items already paid out to the provider, or
 * whose service is under way or over, cannot be voided.
 */

export type VoidRefusal =
  "ALREADY_VOIDED" | "NOT_VOIDABLE_STATUS" | "PAID_OUT" | "IN_SCHEDULED_PAYOUT";

export type CommissionOnVoid = "WAIVE" | "WAIVE_AND_ADJUST_INVOICE" | "KEEP";

export interface VoidInput {
  status: string;
  paymentStatus: string;
  commissionStatus: string;
  payoutStatus: string;
  /** Status of the payout batch the item is in, if any. */
  payoutBatchStatus: string | null;
  voided: boolean;
}

export type VoidPlan =
  | { ok: false; refusal: VoidRefusal }
  | {
      ok: true;
      releaseInventory: boolean;
      commission: CommissionOnVoid;
      /** Queue refund requests for the item's online allocations. */
      requestRefund: boolean;
      /** Take the item out of its open (PENDING) payout batch. */
      leavePendingPayout: boolean;
    };

const VOIDABLE = ["PENDING", "CONFIRMED"];

export function planVoid(item: VoidInput): VoidPlan {
  if (item.voided) return { ok: false, refusal: "ALREADY_VOIDED" };
  if (!VOIDABLE.includes(item.status)) return { ok: false, refusal: "NOT_VOIDABLE_STATUS" };
  if (item.payoutStatus === "PAID") return { ok: false, refusal: "PAID_OUT" };
  if (item.payoutBatchStatus === "SCHEDULED") return { ok: false, refusal: "IN_SCHEDULED_PAYOUT" };
  const commission: CommissionOnVoid =
    item.commissionStatus === "INVOICED"
      ? "WAIVE_AND_ADJUST_INVOICE"
      : item.commissionStatus === "PENDING"
        ? "WAIVE"
        : "KEEP";
  return {
    ok: true,
    releaseInventory: true,
    commission,
    requestRefund: item.paymentStatus === "PAID" || item.paymentStatus === "PARTIALLY_PAID",
    leavePendingPayout: item.payoutBatchStatus === "PENDING",
  };
}

/**
 * Settlement correction (gap 13): an admin may undo a pay-at-property settlement recorded by
 * mistake (PAID_AT_PROPERTY → PAY_AT_PROPERTY), with a reason. Money snapshots never change.
 */
export function canReverseSettlement(item: { status: string; paymentStatus: string }): boolean {
  return item.paymentStatus === "PAID_AT_PROPERTY" && item.status !== "CANCELLED";
}

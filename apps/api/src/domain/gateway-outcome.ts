/**
 * What a verified gateway result does to a payment (ADR 0017, gap 8). Pure, so every case is
 * unit-tested; the payments service only carries out the decision inside one locked transaction.
 *
 * Money the gateway confirms is never dropped: if it cannot be applied to the trip (the payment
 * was cancelled when the hold expired, the trip no longer waits, the amount due changed, the
 * amount differs, or the trip was already paid), it is RECORDED for reconciliation instead.
 */

export type ReconciliationReason =
  | "PAYMENT_NOT_OPEN"
  | "TRIP_NOT_AWAITING_PAYMENT"
  | "INTENT_STALE"
  | "AMOUNT_MISMATCH"
  | "DUPLICATE_PAYMENT";

export type GatewayOutcome =
  /** Apply it: mark SUCCEEDED, allocate to the due items, confirm what is fully paid. */
  | { action: "record_success" }
  /** Already applied (the same gateway transaction again): change nothing. */
  | { action: "replay" }
  /** Money arrived but cannot be applied: keep it for an admin; close the payment if still open. */
  | {
      action: "reconcile";
      reason: ReconciliationReason;
      closePaymentAs: "CANCELLED" | "FAILED" | null;
    }
  /** Not paid: close the open payment. */
  | { action: "close"; status: "FAILED" | "CANCELLED" }
  /** Nothing to do (still pending, or already finished). */
  | { action: "none" };

export interface OutcomeInput {
  result: {
    status: "pending" | "paid" | "failed" | "expired";
    amountMinor: bigint | null;
    transactionId: string | null;
    reason: string | null;
  };
  payment: {
    status: "INITIATED" | "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
    amountMinor: bigint;
    gatewayTransactionId: string | null;
  };
  /** The trip is PENDING and its hold has not expired. */
  tripAwaitingPayment: boolean;
  /** The amount due (items and amounts) changed since the payment was started. */
  intentStale: boolean;
}

const isOpen = (status: OutcomeInput["payment"]["status"]) =>
  status === "INITIATED" || status === "PENDING";

export function decideGatewayOutcome(input: OutcomeInput): GatewayOutcome {
  const { result, payment } = input;
  const open = isOpen(payment.status);

  if (result.status === "pending") return { action: "none" };

  if (result.status === "failed" || result.status === "expired") {
    // The gateway took money, but not the amount we asked for: keep it, never apply it.
    if (result.reason === "amount_mismatch" && (result.amountMinor ?? 0n) > 0n) {
      return {
        action: "reconcile",
        reason: "AMOUNT_MISMATCH",
        closePaymentAs: open ? "FAILED" : null,
      };
    }
    if (!open) return { action: "none" };
    return { action: "close", status: result.status === "expired" ? "CANCELLED" : "FAILED" };
  }

  // Paid, and verified by the adapter for exactly payment.amountMinor.
  if (payment.status === "SUCCEEDED") {
    return payment.gatewayTransactionId === result.transactionId
      ? { action: "replay" }
      : { action: "reconcile", reason: "DUPLICATE_PAYMENT", closePaymentAs: null };
  }
  if (!open) return { action: "reconcile", reason: "PAYMENT_NOT_OPEN", closePaymentAs: null };
  if (!input.tripAwaitingPayment) {
    return {
      action: "reconcile",
      reason: "TRIP_NOT_AWAITING_PAYMENT",
      closePaymentAs: "CANCELLED",
    };
  }
  if (input.intentStale) {
    return { action: "reconcile", reason: "INTENT_STALE", closePaymentAs: "CANCELLED" };
  }
  return { action: "record_success" };
}

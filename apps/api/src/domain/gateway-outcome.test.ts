import { describe, expect, it } from "vitest";
import { decideGatewayOutcome, type OutcomeInput } from "./gateway-outcome.js";

type Result = OutcomeInput["result"];
type Payment = OutcomeInput["payment"];

const paid: Result = { status: "paid", amountMinor: 1000n, transactionId: "T1", reason: null };
const open: Payment = { status: "PENDING", amountMinor: 1000n, gatewayTransactionId: null };

function decide(
  result: Partial<Result> = {},
  payment: Partial<Payment> = {},
  trip: { tripAwaitingPayment?: boolean; intentStale?: boolean } = {},
) {
  return decideGatewayOutcome({
    result: { ...paid, ...result },
    payment: { ...open, ...payment },
    tripAwaitingPayment: trip.tripAwaitingPayment ?? true,
    intentStale: trip.intentStale ?? false,
  });
}

describe("decideGatewayOutcome (ADR 0017, gap 8)", () => {
  it("applies a verified payment to an open intent of a waiting trip", () => {
    expect(decide()).toEqual({ action: "record_success" });
    expect(decide({}, { status: "INITIATED" })).toEqual({ action: "record_success" });
  });

  it("does nothing while the gateway says pending", () => {
    expect(decide({ status: "pending", transactionId: null })).toEqual({ action: "none" });
    expect(decide({ status: "pending" }, { status: "CANCELLED" })).toEqual({ action: "none" });
  });

  it("is idempotent: the same transaction again is a replay", () => {
    expect(decide({}, { status: "SUCCEEDED", gatewayTransactionId: "T1" })).toEqual({
      action: "replay",
    });
  });

  it("flags a second, different transaction on a paid intent", () => {
    expect(
      decide({ transactionId: "T2" }, { status: "SUCCEEDED", gatewayTransactionId: "T1" }),
    ).toEqual({ action: "reconcile", reason: "DUPLICATE_PAYMENT", closePaymentAs: null });
  });

  it("records late money for a payment already cancelled or failed (hold expired)", () => {
    for (const status of ["CANCELLED", "FAILED"] as const) {
      expect(decide({}, { status })).toEqual({
        action: "reconcile",
        reason: "PAYMENT_NOT_OPEN",
        closePaymentAs: null,
      });
    }
  });

  it("records money for a trip that no longer waits, closing the open intent", () => {
    expect(decide({}, {}, { tripAwaitingPayment: false })).toEqual({
      action: "reconcile",
      reason: "TRIP_NOT_AWAITING_PAYMENT",
      closePaymentAs: "CANCELLED",
    });
  });

  it("records money for an intent whose amount due changed", () => {
    expect(decide({}, {}, { intentStale: true })).toEqual({
      action: "reconcile",
      reason: "INTENT_STALE",
      closePaymentAs: "CANCELLED",
    });
  });

  it("records a different amount the gateway took, and fails the open intent", () => {
    const mismatch = { status: "failed" as const, reason: "amount_mismatch", amountMinor: 900n };
    expect(decide(mismatch)).toEqual({
      action: "reconcile",
      reason: "AMOUNT_MISMATCH",
      closePaymentAs: "FAILED",
    });
    expect(decide(mismatch, { status: "CANCELLED" })).toEqual({
      action: "reconcile",
      reason: "AMOUNT_MISMATCH",
      closePaymentAs: null,
    });
    // No money moved: nothing to keep.
    expect(decide({ ...mismatch, amountMinor: 0n })).toEqual({ action: "close", status: "FAILED" });
    expect(decide({ ...mismatch, amountMinor: null })).toEqual({
      action: "close",
      status: "FAILED",
    });
  });

  it("closes an open intent the gateway failed or expired; finished ones are left alone", () => {
    const failed = { status: "failed" as const, reason: "canceled", transactionId: null };
    const expired = { status: "expired" as const, reason: "expired", transactionId: null };
    expect(decide(failed)).toEqual({ action: "close", status: "FAILED" });
    expect(decide(expired)).toEqual({ action: "close", status: "CANCELLED" });
    expect(decide(failed, { status: "SUCCEEDED", gatewayTransactionId: "T1" })).toEqual({
      action: "none",
    });
    expect(decide(expired, { status: "CANCELLED" })).toEqual({ action: "none" });
  });
});

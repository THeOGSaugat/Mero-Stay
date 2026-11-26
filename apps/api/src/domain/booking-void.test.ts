import { describe, expect, it } from "vitest";
import { canReverseSettlement, planVoid, type VoidInput } from "./booking-void.js";

const base: VoidInput = {
  status: "CONFIRMED",
  paymentStatus: "PAID",
  commissionStatus: "PENDING",
  payoutStatus: "PENDING",
  payoutBatchStatus: null,
  voided: false,
};

describe("booking voids (ADR 0018, gap 13)", () => {
  it("a paid online item: cancelled, inventory back, commission waived, refund requested", () => {
    expect(planVoid(base)).toEqual({
      ok: true,
      releaseInventory: true,
      commission: "WAIVE",
      requestRefund: true,
      leavePendingPayout: false,
    });
    expect(planVoid({ ...base, paymentStatus: "PARTIALLY_PAID", status: "PENDING" })).toMatchObject(
      {
        ok: true,
        requestRefund: true,
      },
    );
  });

  it("an unpaid item: no refund request", () => {
    expect(planVoid({ ...base, status: "PENDING", paymentStatus: "UNPAID" })).toMatchObject({
      ok: true,
      requestRefund: false,
      commission: "WAIVE",
    });
  });

  it("an invoiced pay-at-property item: commission waived with an invoice adjustment", () => {
    expect(
      planVoid({ ...base, paymentStatus: "PAY_AT_PROPERTY", commissionStatus: "INVOICED" }),
    ).toEqual({
      ok: true,
      releaseInventory: true,
      commission: "WAIVE_AND_ADJUST_INVOICE",
      requestRefund: false,
      leavePendingPayout: false,
    });
  });

  it("an item in an open payout batch leaves it; scheduled or paid out items cannot be voided", () => {
    expect(planVoid({ ...base, payoutBatchStatus: "PENDING" })).toMatchObject({
      ok: true,
      leavePendingPayout: true,
    });
    expect(planVoid({ ...base, payoutBatchStatus: "SCHEDULED" })).toEqual({
      ok: false,
      refusal: "IN_SCHEDULED_PAYOUT",
    });
    expect(planVoid({ ...base, payoutStatus: "PAID", payoutBatchStatus: "PAID" })).toEqual({
      ok: false,
      refusal: "PAID_OUT",
    });
  });

  it("only pending or confirmed items; a second void is recognised", () => {
    for (const status of ["IN_PROGRESS", "COMPLETED", "NO_SHOW", "CANCELLED", "EXPIRED"]) {
      expect(planVoid({ ...base, status }), status).toEqual({
        ok: false,
        refusal: "NOT_VOIDABLE_STATUS",
      });
    }
    expect(planVoid({ ...base, status: "CANCELLED", voided: true })).toEqual({
      ok: false,
      refusal: "ALREADY_VOIDED",
    });
  });

  it("a settlement can be undone only while it stands", () => {
    expect(canReverseSettlement({ status: "CONFIRMED", paymentStatus: "PAID_AT_PROPERTY" })).toBe(
      true,
    );
    expect(canReverseSettlement({ status: "CONFIRMED", paymentStatus: "PAY_AT_PROPERTY" })).toBe(
      false,
    );
    expect(canReverseSettlement({ status: "CANCELLED", paymentStatus: "PAID_AT_PROPERTY" })).toBe(
      false,
    );
    expect(canReverseSettlement({ status: "CONFIRMED", paymentStatus: "PAID" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  assertCommissionTransition,
  assertItemTransition,
  canTransitionCommissionStatus,
  canTransitionItemStatus,
  canTransitionPaymentStatus,
} from "./booking-item-status.js";

describe("booking item status", () => {
  it.each([
    ["PENDING", "CONFIRMED"],
    ["PENDING", "EXPIRED"],
    ["CONFIRMED", "IN_PROGRESS"],
    ["CONFIRMED", "COMPLETED"],
    ["CONFIRMED", "NO_SHOW"],
    ["IN_PROGRESS", "COMPLETED"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(canTransitionItemStatus(from, to)).toBe(true);
  });

  it.each([
    ["COMPLETED", "CANCELLED"],
    ["CANCELLED", "CONFIRMED"],
    ["EXPIRED", "CONFIRMED"],
    ["PENDING", "COMPLETED"],
    ["IN_PROGRESS", "CANCELLED"],
  ] as const)("rejects %s → %s", (from, to) => {
    expect(canTransitionItemStatus(from, to)).toBe(false);
    expect(() => assertItemTransition(from, to)).toThrow(InvalidTransitionError);
  });
});

describe("payment status (per item)", () => {
  it("lets the customer pay online or choose pay-at-property", () => {
    expect(canTransitionPaymentStatus("UNPAID", "PAID")).toBe(true);
    expect(canTransitionPaymentStatus("UNPAID", "PAY_AT_PROPERTY")).toBe(true);
  });

  it("only refunds money MeroStay actually collected", () => {
    expect(canTransitionPaymentStatus("PAID", "REFUNDED")).toBe(true);
    expect(canTransitionPaymentStatus("PAID", "PARTIALLY_REFUNDED")).toBe(true);
    expect(canTransitionPaymentStatus("PARTIALLY_REFUNDED", "REFUNDED")).toBe(true);
    expect(canTransitionPaymentStatus("PAY_AT_PROPERTY", "REFUNDED")).toBe(false);
    expect(canTransitionPaymentStatus("UNPAID", "REFUNDED")).toBe(false);
  });

  it("never reopens a refunded item", () => {
    expect(canTransitionPaymentStatus("REFUNDED", "PAID")).toBe(false);
  });
});

describe("commission status (per item)", () => {
  it("online payment: commission is deducted from the payout (PENDING → PAID), never invoiced", () => {
    expect(canTransitionCommissionStatus("PENDING", "PAID", "PAID")).toBe(true);
    expect(canTransitionCommissionStatus("PENDING", "INVOICED", "PAID")).toBe(false);
  });

  it("pay-at-property: commission must be invoiced before it is paid", () => {
    expect(canTransitionCommissionStatus("PENDING", "INVOICED", "PAY_AT_PROPERTY")).toBe(true);
    expect(canTransitionCommissionStatus("INVOICED", "PAID", "PAY_AT_PROPERTY")).toBe(true);
    expect(canTransitionCommissionStatus("PENDING", "PAID", "PAY_AT_PROPERTY")).toBe(false);
  });

  it("cannot collect commission on an unpaid item", () => {
    expect(canTransitionCommissionStatus("PENDING", "PAID", "UNPAID")).toBe(false);
    expect(canTransitionCommissionStatus("PENDING", "INVOICED", "UNPAID")).toBe(false);
  });

  it("can be waived while open, but final states are final", () => {
    expect(canTransitionCommissionStatus("PENDING", "WAIVED", "UNPAID")).toBe(true);
    expect(canTransitionCommissionStatus("INVOICED", "WAIVED", "PAY_AT_PROPERTY")).toBe(true);
    expect(canTransitionCommissionStatus("PAID", "WAIVED", "PAID")).toBe(false);
    expect(() => assertCommissionTransition("WAIVED", "PAID", "PAID")).toThrow(
      /Invalid commission transition: WAIVED → PAID/,
    );
  });
});

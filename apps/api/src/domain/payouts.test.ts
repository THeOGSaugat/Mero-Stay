import { describe, expect, it } from "vitest";
import {
  canMovePayout,
  isPayoutEligible,
  isPayoutMonth,
  lastServiceDate,
  maskReference,
  payoutPeriod,
  sumPayout,
  type PayoutCandidate,
} from "./payouts.js";

const paidItem: PayoutCandidate = {
  status: "COMPLETED",
  paymentStatus: "PAID",
  payoutStatus: "PENDING",
  payoutId: null,
  startDate: "2026-11-10",
  endDate: "2026-11-12",
  hasOpenRefundRequest: false,
};

describe("payouts (ADR 0018, gap 16)", () => {
  it("a period is one calendar month, leap years included", () => {
    expect(payoutPeriod("2026-11")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(payoutPeriod("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(payoutPeriod("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(payoutPeriod("2027-02")).toEqual({ start: "2027-02-01", end: "2027-02-28" });
    for (const bad of ["2026-13", "2026-1", "26-11", "2026-11-01", ""]) {
      expect(isPayoutMonth(bad)).toBe(false);
      expect(() => payoutPeriod(bad)).toThrow(RangeError);
    }
  });

  it("net = gross − commission, in bigint, for any number of items", () => {
    expect(sumPayout([])).toEqual({
      grossMinor: 0n,
      commissionMinor: 0n,
      netMinor: 0n,
      itemCount: 0,
    });
    expect(
      sumPayout([
        { totalMinor: 360000n, commissionMinor: 54000n },
        { totalMinor: 900000n, commissionMinor: 135000n },
      ]),
    ).toEqual({ grossMinor: 1260000n, commissionMinor: 189000n, netMinor: 1071000n, itemCount: 2 });
    // Beyond 2^53: no precision lost.
    const big = 9_007_199_254_740_993n;
    expect(sumPayout([{ totalMinor: big, commissionMinor: 1n }]).netMinor).toBe(big - 1n);
  });

  it("an item is eligible only once its service is over (Nepal date), paid in full, not cancelled", () => {
    // Nights 10–11 (check-out 12): the last service date is the 11th.
    expect(lastServiceDate("2026-11-10", "2026-11-12")).toBe("2026-11-11");
    expect(lastServiceDate("2026-11-10", null)).toBe("2026-11-10");
    expect(isPayoutEligible(paidItem, "2026-11-11")).toBe(false); // still the last night
    expect(isPayoutEligible(paidItem, "2026-11-12")).toBe(true);
    expect(isPayoutEligible({ ...paidItem, endDate: null }, "2026-11-10")).toBe(false);
    expect(isPayoutEligible({ ...paidItem, endDate: null }, "2026-11-11")).toBe(true);
    for (const status of ["CONFIRMED", "IN_PROGRESS", "COMPLETED", "NO_SHOW"]) {
      expect(isPayoutEligible({ ...paidItem, status }, "2026-12-01")).toBe(true);
    }
    for (const change of [
      { status: "CANCELLED" },
      { status: "EXPIRED" },
      { paymentStatus: "PARTIALLY_PAID" },
      { paymentStatus: "PAY_AT_PROPERTY" },
      { paymentStatus: "REFUNDED" },
      { payoutStatus: "PAID" },
      { payoutId: "already-in-a-batch" },
      { hasOpenRefundRequest: true },
    ]) {
      expect(
        isPayoutEligible({ ...paidItem, ...change }, "2026-12-01"),
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("moves PENDING → SCHEDULED → PAID | FAILED, never back", () => {
    expect(canMovePayout("PENDING", "SCHEDULED")).toBe(true);
    expect(canMovePayout("SCHEDULED", "PAID")).toBe(true);
    expect(canMovePayout("SCHEDULED", "FAILED")).toBe(true);
    for (const [from, to] of [
      ["PENDING", "PAID"],
      ["PENDING", "FAILED"],
      ["SCHEDULED", "PENDING"],
      ["PAID", "FAILED"],
      ["PAID", "SCHEDULED"],
      ["FAILED", "SCHEDULED"],
      ["FAILED", "PAID"],
    ] as const) {
      expect(canMovePayout(from, to), `${from}→${to}`).toBe(false);
    }
  });

  it("masks bank references to the last 4", () => {
    expect(maskReference("NIC-2026-11-0007788")).toBe("••••7788");
    expect(maskReference("ab 123")).toBe("••••b123");
    expect(maskReference("ab 12")).toBe("••••");
    expect(maskReference("123")).toBe("••••");
    expect(maskReference(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { planDeductions, clawbackAmount } from "./clawbacks.js";
import { isPayoutEligible, payoutLine, sumPayout, type PayoutCandidate } from "./payouts.js";
import {
  canMoveRefund,
  commissionOnKept,
  paymentStatusAfterRefunds,
  planCustomerCancellation,
  refundTier,
  ruleFromSnapshot,
  serviceStart,
  splitRefund,
  toNepalLocal,
  type CancelInput,
} from "./refunds.js";
import { settlementMismatches, type SettlementItem } from "./settlement-reconciliation.js";

const H = 3_600_000;
const TIERS = {
  nonRefundable: false,
  rules: [
    { minHoursBeforeStart: 72, refundBps: 10_000 },
    { minHoursBeforeStart: 24, refundBps: 5_000 },
  ],
};

describe("the refund clock: the actual service start, Nepal time (owner decision 2026-11-27)", () => {
  it("is the start date at the listing's time in Nepal (UTC+05:45), stored in UTC", () => {
    const start = serviceStart("2026-12-20", "14:00");
    expect(start.source).toBe("LISTING_TIME");
    // 14:00 in Kathmandu = 08:15 UTC (the 45-minute offset matters).
    expect(start.startsAt.toISOString()).toBe("2026-12-20T08:15:00.000Z");
    expect(toNepalLocal(start.startsAt)).toBe("2026-12-20T14:00");
  });

  it("crosses the UTC date boundary correctly for early-morning starts", () => {
    // 05:00 Nepal on the 20th is still the 19th in UTC.
    expect(serviceStart("2026-12-20", "05:00").startsAt.toISOString()).toBe(
      "2026-12-19T23:15:00.000Z",
    );
  });

  it("falls back to 00:00 Nepal time when the listing has no start time, and says so", () => {
    const start = serviceStart("2026-12-20", null);
    expect(start.source).toBe("DEFAULT_MIDNIGHT");
    expect(start.startsAt.toISOString()).toBe("2026-12-19T18:15:00.000Z");
    expect(toNepalLocal(start.startsAt)).toBe("2026-12-20T00:00");
  });

  it("has no daylight-saving shift: the offset is the same in June and December", () => {
    const june = serviceStart("2026-06-20", "10:00").startsAt.toISOString();
    const december = serviceStart("2026-12-20", "10:00").startsAt.toISOString();
    expect(june.slice(11)).toBe(december.slice(11));
  });

  it("rejects malformed dates and times", () => {
    expect(() => serviceStart("2026-02-30", "10:00")).toThrow(RangeError);
    expect(() => serviceStart("2026-12-20", "24:00")).toThrow(RangeError);
  });
});

describe("refund tiers use exact instants", () => {
  const rule = ruleFromSnapshot(TIERS);
  const start = serviceStart("2026-12-20", "14:00").startsAt;
  const at = (msBefore: number) => new Date(start.getTime() - msBefore);

  it("exactly 72 h before the start meets the 72-hour tier", () => {
    expect(refundTier(rule, start, at(72 * H))).toMatchObject({ refundBps: 10_000 });
  });

  it("71 h 59 m before falls to the next tier; a millisecond short of 72 h too", () => {
    expect(refundTier(rule, start, at(71 * H + 59 * 60_000))).toMatchObject({ refundBps: 5_000 });
    expect(refundTier(rule, start, at(72 * H - 1))).toMatchObject({ refundBps: 5_000 });
  });

  it("exactly 24 h and just under 24 h", () => {
    expect(refundTier(rule, start, at(24 * H)).refundBps).toBe(5_000);
    expect(refundTier(rule, start, at(24 * H - 1)).refundBps).toBe(0);
  });

  it("a cancellation at 23:59 Nepal time the day before a midnight-default start is 1 minute' notice", () => {
    const midnight = serviceStart("2026-12-20", null).startsAt;
    // 23:59 NPT on the 19th = 18:14 UTC on the 19th.
    const cancelledAt = new Date("2026-12-19T18:14:00.000Z");
    expect(toNepalLocal(cancelledAt)).toBe("2026-12-19T23:59");
    const decision = refundTier(rule, midnight, cancelledAt);
    expect(decision.noticeMs).toBe(60_000);
    expect(decision.refundBps).toBe(0);
  });

  it("the same evening with a 14:00 check-in still has 14 h 1 m of notice", () => {
    const cancelledAt = new Date("2026-12-19T18:14:00.000Z");
    expect(refundTier(rule, start, cancelledAt).noticeMs).toBe(14 * H + 60_000);
  });

  it("no policy and non-refundable both give 0; after the start gives 0", () => {
    expect(refundTier(null, start, at(500 * H)).refundBps).toBe(0);
    expect(
      refundTier(ruleFromSnapshot({ nonRefundable: true, rules: [] }), start, at(500 * H)),
    ).toMatchObject({ tier: null, refundBps: 0 });
    expect(refundTier(rule, start, new Date(start.getTime() + 1)).refundBps).toBe(0);
  });

  it("reads older snapshots without nonRefundable, and ignores malformed tiers", () => {
    expect(ruleFromSnapshot({ rules: [{ minHoursBeforeStart: 48, refundBps: 10_000 }] })).toEqual({
      nonRefundable: false,
      tiers: [{ minHoursBeforeStart: 48, refundBps: 10_000 }],
    });
    expect(ruleFromSnapshot({ rules: [{ minHoursBeforeStart: "x" }] })).toEqual({
      nonRefundable: true,
      tiers: [],
    });
    expect(ruleFromSnapshot(null)).toBeNull();
  });
});

describe("customer cancellation amounts", () => {
  const start = serviceStart("2026-12-20", "14:00").startsAt;
  // Subtotal 7,000.00, service charge 10%, VAT 13% → total 8,701.00; commission 15% = 1,050.00.
  const item: CancelInput = {
    status: "CONFIRMED",
    paymentStatus: "PAID",
    commissionStatus: "PENDING",
    totalMinor: 870_100n,
    subtotalMinor: 700_000n,
    commissionRateBps: 1500,
    serviceStartsAt: start,
    policySnapshot: TIERS,
  };
  const at = (msBefore: number) => new Date(start.getTime() - msBefore);

  it("a 50% tier: half the total back; commission on the half kept", () => {
    const plan = planCustomerCancellation(item, at(30 * H));
    expect(plan).toMatchObject({
      ok: true,
      online: true,
      refundMinor: 435_050n,
      keptMinor: 435_050n,
      // 15% of 50% of 7,000.00 = 525.00.
      keptCommissionMinor: 52_500n,
      commission: "KEEP",
    });
  });

  it("a full refund waives the commission", () => {
    expect(planCustomerCancellation(item, at(100 * H))).toMatchObject({
      ok: true,
      refundMinor: 870_100n,
      keptMinor: 0n,
      keptCommissionMinor: 0n,
      commission: "WAIVE",
    });
  });

  it("too late, non-refundable or no policy: may cancel, nothing back, full commission kept", () => {
    for (const plan of [
      planCustomerCancellation(item, at(2 * H)),
      planCustomerCancellation({ ...item, policySnapshot: null }, at(500 * H)),
      planCustomerCancellation(
        { ...item, policySnapshot: { nonRefundable: true, rules: [] } },
        at(500 * H),
      ),
    ]) {
      expect(plan).toMatchObject({
        ok: true,
        refundMinor: 0n,
        keptMinor: 870_100n,
        keptCommissionMinor: 105_000n,
        commission: "KEEP",
      });
    }
  });

  it("rounds half up once, like the database", () => {
    // 1,001 paisa at 50%: 500.5 → 501 back.
    const odd = { ...item, totalMinor: 1_001n, subtotalMinor: 1_001n };
    expect(planCustomerCancellation(odd, at(30 * H))).toMatchObject({
      refundMinor: 501n,
      keptMinor: 500n,
      // 1001 × 5000 × 1500 / 10⁸ = 75.075 → 75.
      keptCommissionMinor: 75n,
    });
    expect(commissionOnKept(1_001n, 5_000, 1500)).toBe(75n);
    // Half-up at exactly .5: 100 × 5000 × 1500 / 10⁸ = 7.5 → 8.
    expect(commissionOnKept(100n, 5_000, 1500)).toBe(8n);
  });

  it("never keeps more commission than what is kept (100% commission, tiny amounts)", () => {
    const plan = planCustomerCancellation(
      { ...item, totalMinor: 1n, subtotalMinor: 1n, commissionRateBps: 10_000 },
      at(30 * H),
    );
    expect(plan).toMatchObject({ refundMinor: 1n, keptMinor: 0n, commission: "WAIVE" });
  });

  it("pay at property: nothing was paid through MeroStay; commission waived (and invoice adjusted)", () => {
    expect(
      planCustomerCancellation(
        { ...item, paymentStatus: "PAY_AT_PROPERTY", commissionStatus: "INVOICED" },
        at(30 * H),
      ),
    ).toMatchObject({
      ok: true,
      online: false,
      refundMinor: 0n,
      keptCommissionMinor: 0n,
      commission: "WAIVE_AND_ADJUST_INVOICE",
    });
  });

  it("refuses started, not confirmed, settled-at-property and not fully paid items", () => {
    expect(planCustomerCancellation(item, new Date(start.getTime()))).toMatchObject({
      ok: false,
      refusal: "ALREADY_STARTED",
    });
    expect(planCustomerCancellation({ ...item, status: "PENDING" }, at(100 * H))).toMatchObject({
      refusal: "NOT_CANCELLABLE_STATUS",
    });
    expect(
      planCustomerCancellation({ ...item, paymentStatus: "PAID_AT_PROPERTY" }, at(100 * H)),
    ).toMatchObject({ refusal: "SETTLED_AT_PROPERTY" });
    expect(
      planCustomerCancellation({ ...item, paymentStatus: "PARTIALLY_PAID" }, at(100 * H)),
    ).toMatchObject({ refusal: "NOT_FULLY_PAID" });
  });

  it("splits a refund over the charges that paid the item, newest first, never above each", () => {
    expect(
      splitRefund(700n, [
        { paymentId: "a", amountMinor: 500n },
        { paymentId: "b", amountMinor: 400n },
      ]),
    ).toEqual([
      { paymentId: "b", amountMinor: 400n },
      { paymentId: "a", amountMinor: 300n },
    ]);
    expect(() => splitRefund(901n, [{ paymentId: "a", amountMinor: 900n }])).toThrow(RangeError);
  });
});

describe("refund execution state machine and limits", () => {
  it("follows requested → approved → processing → completed | failed, with retry", () => {
    expect(canMoveRefund("REQUESTED", "APPROVED")).toBe(true);
    expect(canMoveRefund("APPROVED", "PROCESSING")).toBe(true);
    expect(canMoveRefund("PROCESSING", "COMPLETED")).toBe(true);
    expect(canMoveRefund("PROCESSING", "FAILED")).toBe(true);
    expect(canMoveRefund("FAILED", "PROCESSING")).toBe(true);
    expect(canMoveRefund("REQUESTED", "PROCESSING")).toBe(false);
    expect(canMoveRefund("COMPLETED", "PROCESSING")).toBe(false);
    expect(canMoveRefund("REJECTED", "APPROVED")).toBe(false);
    expect(canMoveRefund("PROCESSING", "REJECTED")).toBe(false);
  });

  it("payment status follows the completed refunds; never more than was paid", () => {
    expect(paymentStatusAfterRefunds(870_100n, 0n)).toBe("PAID");
    expect(paymentStatusAfterRefunds(870_100n, 435_050n)).toBe("PARTIALLY_REFUNDED");
    expect(paymentStatusAfterRefunds(870_100n, 870_100n)).toBe("REFUNDED");
    expect(() => paymentStatusAfterRefunds(870_100n, 870_101n)).toThrow(RangeError);
  });
});

describe("clawbacks and payout deductions (gap 39)", () => {
  it("the clawback is the item's line in its paid batch", () => {
    expect(
      clawbackAmount({
        totalMinor: 870_100n,
        refundedMinor: 0n,
        commissionMinor: 105_000n,
        keptCommissionMinor: null,
      }),
    ).toBe(765_100n);
  });

  it("deducts oldest first, never below zero, the rest carried forward", () => {
    const claws = [
      { id: "old", outstandingMinor: 300n },
      { id: "new", outstandingMinor: 500n },
    ];
    expect(planDeductions(1_000n, claws)).toEqual([
      { clawbackId: "old", amountMinor: 300n },
      { clawbackId: "new", amountMinor: 500n },
    ]);
    expect(planDeductions(400n, claws)).toEqual([
      { clawbackId: "old", amountMinor: 300n },
      { clawbackId: "new", amountMinor: 100n },
    ]);
    expect(planDeductions(0n, claws)).toEqual([]);
    expect(planDeductions(100n, [{ id: "done", outstandingMinor: 0n }])).toEqual([]);
  });

  it("batch sums use what was kept, the kept commission and the deductions", () => {
    const lines = [
      { totalMinor: 870_100n, commissionMinor: 105_000n },
      {
        totalMinor: 870_100n,
        commissionMinor: 105_000n,
        refundedMinor: 435_050n,
        keptCommissionMinor: 52_500n,
      },
    ];
    expect(payoutLine(lines[1]!)).toEqual({
      grossMinor: 435_050n,
      commissionMinor: 52_500n,
      netMinor: 382_550n,
    });
    expect(sumPayout(lines, 100_000n)).toEqual({
      grossMinor: 1_305_150n,
      commissionMinor: 157_500n,
      deductionsMinor: 100_000n,
      netMinor: 1_047_650n,
      itemCount: 2,
    });
    expect(() => sumPayout(lines, 1_147_651n)).toThrow(RangeError);
  });

  it("a customer-cancelled item with money kept is payable once its refund completed", () => {
    const cancelled: PayoutCandidate = {
      status: "CANCELLED",
      paymentStatus: "PARTIALLY_REFUNDED",
      payoutStatus: "PENDING",
      payoutId: null,
      startDate: "2026-11-10",
      endDate: null,
      hasOpenRefundRequest: false,
      cancellationRefundMinor: 435_050n,
      refundedMinor: 435_050n,
      totalMinor: 870_100n,
    };
    expect(isPayoutEligible(cancelled, "2026-11-27")).toBe(true);
    expect(isPayoutEligible({ ...cancelled, refundedMinor: 0n }, "2026-11-27")).toBe(false);
    expect(isPayoutEligible({ ...cancelled, hasOpenRefundRequest: true }, "2026-11-27")).toBe(
      false,
    );
    expect(isPayoutEligible({ ...cancelled, voided: true }, "2026-11-27")).toBe(false);
    expect(
      isPayoutEligible(
        {
          ...cancelled,
          paymentStatus: "REFUNDED",
          cancellationRefundMinor: 870_100n,
          refundedMinor: 870_100n,
        },
        "2026-11-27",
      ),
    ).toBe(false);
    // A voided or admin-cancelled item (no customer cancellation) is never payable.
    expect(isPayoutEligible({ ...cancelled, cancellationRefundMinor: null }, "2026-11-27")).toBe(
      false,
    );
  });
});

describe("pay-at-property settlement mismatches (gap 36)", () => {
  const item: SettlementItem = {
    status: "CONFIRMED",
    paymentStatus: "PAY_AT_PROPERTY",
    commissionStatus: "INVOICED",
    commissionInvoiceId: "inv",
    startDate: "2026-11-20",
    endDate: "2026-11-22",
    serviceStartsAt: serviceStart("2026-11-20", "14:00").startsAt,
    paymentSettledAt: null,
  };

  it("invoiced, service over, never settled", () => {
    // Last night is the 21st: on the 22nd it is over.
    expect(settlementMismatches(item, "2026-11-21")).toEqual([]);
    expect(settlementMismatches(item, "2026-11-22")).toEqual(["UNSETTLED_AFTER_SERVICE"]);
  });

  it("settled but not invoiced, and settled before the service started", () => {
    expect(
      settlementMismatches(
        {
          ...item,
          paymentStatus: "PAID_AT_PROPERTY",
          commissionStatus: "PENDING",
          commissionInvoiceId: null,
          paymentSettledAt: new Date(item.serviceStartsAt.getTime() - 60_000),
        },
        "2026-11-27",
      ),
    ).toEqual(["SETTLED_NOT_INVOICED", "SETTLED_BEFORE_SERVICE"]);
  });

  it("a correct settlement and cancelled items raise nothing", () => {
    expect(
      settlementMismatches(
        {
          ...item,
          paymentStatus: "PAID_AT_PROPERTY",
          paymentSettledAt: new Date(item.serviceStartsAt.getTime() + 60_000),
        },
        "2026-11-27",
      ),
    ).toEqual([]);
    expect(settlementMismatches({ ...item, status: "CANCELLED" }, "2026-11-27")).toEqual([]);
  });
});

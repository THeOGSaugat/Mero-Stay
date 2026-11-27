import { describe, expect, it } from "vitest";
import { refundStatusLabel } from "./admin-ops";
import { DETAIL_FIELDS } from "./listing-forms";
import {
  cancellationSummary,
  clawbackSettled,
  executeLabel,
  formatNepalStart,
  formatNotice,
  hasDeductions,
  itemStartLabel,
  percentOfBps,
  refundActions,
  refundStatusText,
  refundStatusTone,
  settlementKindLabel,
  type CancellationPreview,
} from "./refunds-display";

const preview: CancellationPreview = {
  itemId: "i",
  status: "CONFIRMED",
  cancellable: true,
  refusal: null,
  serviceStartsAt: "2026-12-20T08:15:00.000Z",
  serviceStartsAtNepal: "2026-12-20T14:00",
  serviceStartSource: "LISTING_TIME",
  evaluatedAt: "2026-12-19T02:15:00.000Z",
  noticeMinutes: 30 * 60,
  policy: { name: "Moderate", attached: true, nonRefundable: false },
  tier: { minHoursBeforeStart: 24, refundBps: 5000 },
  refundBps: 5000,
  currency: "NPR",
  currencyExponent: 2,
  paymentMethod: "ONLINE",
  paidMinor: "435050",
  refundMinor: "217525",
};

describe("Phase 14: the refund clock and cancellation wording (ADR 0020)", () => {
  it("formats the Nepal start time with string operations only", () => {
    expect(formatNepalStart("2026-12-20T14:00")).toBe("20 Dec 2026, 14:00");
    expect(formatNepalStart("2026-01-05T06:30")).toBe("5 Jan 2026, 06:30");
    expect(formatNepalStart("not a time")).toBe("not a time");
  });

  it("labels a booking's start, saying when the listing gave no start time", () => {
    expect(
      itemStartLabel({
        serviceStartsAtNepal: "2026-12-20T14:00",
        serviceStartSource: "LISTING_TIME",
      }),
    ).toBe("Starts 20 Dec 2026, 14:00 (Nepal time)");
    expect(
      itemStartLabel({
        serviceStartsAtNepal: "2026-12-20T00:00",
        serviceStartSource: "DEFAULT_MIDNIGHT",
      }),
    ).toBe("Starts 20 Dec 2026 (no start time given)");
  });

  it("shows percentages from basis points and the notice in words", () => {
    expect([percentOfBps(10_000), percentOfBps(5000), percentOfBps(2550), percentOfBps(1)]).toEqual(
      ["100%", "50%", "25.5%", "0.01%"],
    );
    expect([
      formatNotice(0),
      formatNotice(45),
      formatNotice(90),
      formatNotice(30 * 60),
      formatNotice(1440 + 60),
    ]).toEqual(["no notice", "45 minutes", "1 hour 30 minutes", "1 day 6 hours", "1 day 1 hour"]);
  });

  it("summarises what cancelling now gives back, formatted from the API's strings", () => {
    expect(cancellationSummary(preview)).toEqual({
      startLine: "Starts 20 Dec 2026, 14:00 (Nepal time)",
      startNote: null,
      refundLine: "You get Rs. 2,175.25 back (50% of Rs. 4,350.50).",
      policyLine:
        "Moderate: cancelling at least 24 hours before the start gives 50% back. You are cancelling 1 day 6 hours before.",
    });
  });

  it("no policy, non-refundable, too late, pay at property, and the midnight fallback", () => {
    expect(
      cancellationSummary({
        ...preview,
        policy: { name: null, attached: false, nonRefundable: null },
        tier: null,
        refundBps: 0,
        refundMinor: "0",
      }),
    ).toMatchObject({
      policyLine:
        "No cancellation policy was attached to this booking: cancelling gives no refund.",
      refundLine: "No refund: you keep nothing back of the Rs. 4,350.50 paid.",
    });
    expect(
      cancellationSummary({
        ...preview,
        policy: { name: "Strict", attached: true, nonRefundable: true },
      }).policyLine,
    ).toBe("This booking is non-refundable.");
    expect(cancellationSummary({ ...preview, tier: null, noticeMinutes: 60 }).policyLine).toBe(
      "Moderate: you are cancelling 1 hour before the start, later than any refund tier.",
    );
    expect(
      cancellationSummary({
        ...preview,
        paymentMethod: "PAY_AT_PROPERTY",
        paidMinor: "0",
        refundMinor: "0",
      }).refundLine,
    ).toBe("You have not paid anything through MeroStay for this booking, so nothing is refunded.");
    expect(
      cancellationSummary({ ...preview, serviceStartSource: "DEFAULT_MIDNIGHT" }).startNote,
    ).toMatch(/midnight/);
  });

  it("guides, tours and activities ask for a start time; no listing-type code elsewhere", () => {
    for (const type of ["guide_service", "tour", "activity"]) {
      expect(
        DETAIL_FIELDS[type]?.find((f) => f.name === "startTime"),
        type,
      ).toMatchObject({
        kind: "time",
        required: true,
      });
    }
  });
});

describe("Phase 14: the admin refund queue", () => {
  const khalti = {
    gateway: "khalti",
    gatewayRefundCapability: { api: "documented" as const, partial: true, note: "" },
  };
  const esewa = {
    gateway: "esewa",
    gatewayRefundCapability: { api: "none" as const, partial: false, note: "" },
  };

  it("offers only the steps that can work in each state", () => {
    expect(refundActions({ ...khalti, status: "REQUESTED", executionMode: null })).toEqual([
      "approve",
      "reject",
    ]);
    expect(refundActions({ ...khalti, status: "APPROVED", executionMode: null })).toEqual([
      "execute",
      "reject",
    ]);
    expect(refundActions({ ...esewa, status: "PROCESSING", executionMode: "MANUAL" })).toEqual([
      "complete",
    ]);
    expect(refundActions({ ...khalti, status: "PROCESSING", executionMode: "API" })).toEqual([
      "check",
      "complete",
    ]);
    expect(refundActions({ ...khalti, status: "FAILED", executionMode: "API" })).toEqual([
      "execute",
      "reject",
    ]);
    expect(refundActions({ ...khalti, status: "COMPLETED", executionMode: "API" })).toEqual([]);
    expect(refundActions({ ...khalti, status: "REJECTED", executionMode: null })).toEqual([]);
  });

  it("names the execution: Khalti's API or a manual eSewa refund", () => {
    expect(executeLabel({ ...khalti, status: "APPROVED" })).toBe("Refund through Khalti");
    expect(executeLabel({ ...esewa, status: "APPROVED" })).toBe(
      "Start a manual refund (eSewa merchant portal)",
    );
    expect(executeLabel({ ...khalti, status: "FAILED" })).toBe("Try again: Refund through Khalti");
  });

  it("status words and tones", () => {
    expect(refundStatusLabel("REQUESTED")).toBe("Requested (not executed)");
    expect(refundStatusText({ status: "PROCESSING", executionMode: "MANUAL" })).toBe(
      "Waiting for the manual refund",
    );
    expect(refundStatusText({ status: "COMPLETED", executionMode: "API" })).toBe("Refunded");
    expect([
      refundStatusTone("COMPLETED"),
      refundStatusTone("FAILED"),
      refundStatusTone("APPROVED"),
    ]).toEqual(["good", "bad", "wait"]);
  });
});

describe("Phase 14: settlements and clawbacks", () => {
  it("names settlement mismatches", () => {
    expect(settlementKindLabel("SETTLED_BEFORE_SERVICE")).toBe(
      "Recorded as paid before the service started",
    );
    expect(settlementKindLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("a clawback is settled when nothing is outstanding; deductions show only when not zero", () => {
    expect(clawbackSettled({ outstandingMinor: "0" })).toBe(true);
    expect(clawbackSettled({ outstandingMinor: "153000" })).toBe(false);
    expect([
      hasDeductions({ deductionsMinor: "0" }),
      hasDeductions({ deductionsMinor: "153000" }),
      hasDeductions({}),
    ]).toEqual([false, true, false]);
  });
});

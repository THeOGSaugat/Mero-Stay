import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMISSION_RATE_BPS,
  applyRate,
  calculateItemCharges,
  resolveCommissionRateBps,
  summarizeTrip,
} from "./money.js";

describe("applyRate", () => {
  it("computes exact percentages", () => {
    expect(applyRate(450_000, 1500)).toBe(67_500); // 15% of Rs 4,500.00
    expect(applyRate(100, 10_000)).toBe(100);
    expect(applyRate(12_345, 0)).toBe(0);
  });

  it("rounds half-up to the nearest paisa", () => {
    expect(applyRate(10, 1500)).toBe(2); // 1.5 → 2
    expect(applyRate(3, 1500)).toBe(0); // 0.45 → 0
    expect(applyRate(333_333, 1500)).toBe(50_000); // 49,999.95 → 50,000
    expect(applyRate(333_330, 1500)).toBe(50_000); // exactly 49,999.5 → rounds up
    expect(applyRate(333_329, 1500)).toBe(49_999); // 49,999.35 → rounds down
  });

  it("rejects floats, negatives and out-of-range rates", () => {
    expect(() => applyRate(10.5, 1500)).toThrow(RangeError);
    expect(() => applyRate(-1, 1500)).toThrow(RangeError);
    expect(() => applyRate(100, 10_001)).toThrow(RangeError);
    expect(() => applyRate(100, 15.5)).toThrow(RangeError);
  });
});

describe("resolveCommissionRateBps", () => {
  it("defaults to 15%", () => {
    expect(DEFAULT_COMMISSION_RATE_BPS).toBe(1500);
    expect(resolveCommissionRateBps({})).toBe(1500);
  });

  it("prefers listing over provider over platform default", () => {
    expect(resolveCommissionRateBps({ providerRateBps: 1200 })).toBe(1200);
    expect(resolveCommissionRateBps({ listingRateBps: 1000, providerRateBps: 1200 })).toBe(1000);
    expect(resolveCommissionRateBps({ listingRateBps: null, providerRateBps: null })).toBe(1500);
    expect(resolveCommissionRateBps({ listingRateBps: 0 })).toBe(0); // explicit 0% is honoured
  });

  it("rejects invalid rates", () => {
    expect(() => resolveCommissionRateBps({ listingRateBps: 20_000 })).toThrow(RangeError);
  });
});

describe("calculateItemCharges", () => {
  it("bus ticket: 2 seats × Rs 1,800, no taxes, 15% commission", () => {
    const item = calculateItemCharges({
      lines: [{ units: 2, unitPriceMinor: 180_000 }],
      commissionRateBps: 1500,
    });
    expect(item).toMatchObject({
      quantity: 2,
      subtotalMinor: 360_000,
      serviceChargeMinor: 0,
      taxMinor: 0,
      totalMinor: 360_000,
      commissionMinor: 54_000,
      providerPayoutMinor: 306_000,
    });
  });

  it("hotel stay: 2 nights at different prices, 10% service charge, 13% VAT on top", () => {
    const item = calculateItemCharges({
      lines: [
        { units: 1, unitPriceMinor: 350_000 }, // night 1: Rs 3,500
        { units: 1, unitPriceMinor: 420_000 }, // night 2 (festival): Rs 4,200
      ],
      serviceChargeRateBps: 1000,
      taxRateBps: 1300,
      commissionRateBps: 1500,
    });
    // subtotal 7,700.00; service charge 770.00; VAT 13% of 8,470.00 = 1,101.10
    expect(item.subtotalMinor).toBe(770_000);
    expect(item.serviceChargeMinor).toBe(77_000);
    expect(item.taxMinor).toBe(110_110);
    expect(item.totalMinor).toBe(957_110);
    // Commission on the subtotal only: 15% of 7,700.00 = 1,155.00
    expect(item.commissionMinor).toBe(115_500);
    expect(item.providerPayoutMinor).toBe(957_110 - 115_500);
    expect(item.lines.map((l) => l.amountMinor)).toEqual([350_000, 420_000]);
  });

  it("uses a per-item commission rate when one is given", () => {
    const item = calculateItemCharges({
      lines: [{ units: 3, unitPriceMinor: 250_000 }],
      commissionRateBps: 1000,
    });
    expect(item.commissionMinor).toBe(75_000);
  });

  it("rejects empty or invalid lines", () => {
    expect(() => calculateItemCharges({ lines: [], commissionRateBps: 1500 })).toThrow(RangeError);
    expect(() =>
      calculateItemCharges({ lines: [{ units: 0, unitPriceMinor: 100 }], commissionRateBps: 1500 }),
    ).toThrow(RangeError);
    expect(() =>
      calculateItemCharges({ lines: [{ units: 1, unitPriceMinor: -5 }], commissionRateBps: 1500 }),
    ).toThrow(RangeError);
  });
});

describe("summarizeTrip", () => {
  it("sums rounded item amounts: commission per item, stored trip total", () => {
    // Three items whose commissions each round: 0.45 → 0, 1.5 → 2, 0.45 → 0 (paisa).
    const a = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 3 }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    const b = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 10 }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    const c = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 3 }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };

    const trip = summarizeTrip("NPR", [a, b, c]);

    expect(trip.subtotalMinor).toBe(16);
    // Per-item rounding (0 + 2 + 0), NOT 15% of the trip subtotal (2.4 → 2 happens to match here):
    expect(trip.commissionTotalMinor).toBe(
      a.commissionMinor + b.commissionMinor + c.commissionMinor,
    );
  });

  it("Inaruwa → Shree Antu: bus + hotel in one trip", () => {
    const bus = {
      ...calculateItemCharges({
        lines: [{ units: 2, unitPriceMinor: 180_000 }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    const hotel = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 350_000 }],
        serviceChargeRateBps: 1000,
        taxRateBps: 1300,
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };

    const trip = summarizeTrip("NPR", [bus, hotel]);

    expect(trip).toEqual({
      currency: "NPR",
      subtotalMinor: 360_000 + 350_000,
      serviceChargeMinor: 35_000,
      taxMinor: 50_050, // 13% of 3,850.00
      totalMinor: 360_000 + 435_050,
      commissionTotalMinor: 54_000 + 52_500,
    });
  });

  it("rejects mixed currencies (MVP: one currency per trip)", () => {
    const usd = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 100 }],
        commissionRateBps: 1500,
      }),
      currency: "USD",
    };
    expect(() => summarizeTrip("NPR", [usd])).toThrow(/does not match trip currency/);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMISSION_RATE_BPS,
  MAX_MINOR_AMOUNT,
  applyRate,
  calculateItemCharges,
  resolveCommissionRateBps,
  summarizeTrip,
} from "./money.js";

describe("applyRate", () => {
  it("computes exact percentages", () => {
    expect(applyRate(450_000n, 1500)).toBe(67_500n); // 15% of Rs 4,500.00
    expect(applyRate(100n, 10_000)).toBe(100n);
    expect(applyRate(12_345n, 0)).toBe(0n);
  });

  it("rounds half-up to the nearest paisa", () => {
    expect(applyRate(10n, 1500)).toBe(2n); // 1.5 → 2
    expect(applyRate(3n, 1500)).toBe(0n); // 0.45 → 0
    expect(applyRate(333_333n, 1500)).toBe(50_000n); // 49,999.95 → 50,000
    expect(applyRate(333_330n, 1500)).toBe(50_000n); // exactly 49,999.5 → rounds up
    expect(applyRate(333_329n, 1500)).toBe(49_999n); // 49,999.35 → rounds down
  });

  it("rejects non-bigint amounts, negatives, over-limit amounts and bad rates", () => {
    expect(() => applyRate(10.5 as unknown as bigint, 1500)).toThrow(TypeError);
    expect(() => applyRate(100 as unknown as bigint, 1500)).toThrow(TypeError);
    expect(() => applyRate(-1n, 1500)).toThrow(RangeError);
    expect(() => applyRate(MAX_MINOR_AMOUNT + 1n, 1500)).toThrow(RangeError);
    expect(() => applyRate(100n, 10_001)).toThrow(RangeError);
    expect(() => applyRate(100n, 15.5)).toThrow(RangeError);
  });
});

describe("large amounts (64-bit columns)", () => {
  it("handles amounts above the old 32-bit limit of 2,147,483,647 paisa (about Rs 2.1 crore)", () => {
    const rs100Crore = 100_000_000_000n; // Rs 100 crore = Rs 1,000,000,000 in paisa
    expect(rs100Crore).toBeGreaterThan(2_147_483_647n);
    expect(applyRate(rs100Crore, 1500)).toBe(15_000_000_000n);
  });

  it("stays exact above 2^53, where plain JavaScript numbers lose precision", () => {
    // 15% of 1,010,684,250,284,138,794 = 151,602,637,542,620,819.10 → …819 (checked by hand).
    const amount = 1_010_684_250_284_138_794n;
    expect(applyRate(amount, 1500)).toBe(151_602_637_542_620_819n);

    // The same sum with ordinary JavaScript numbers is wrong by several paisa:
    const viaNumber = BigInt(Math.floor((Number(amount) * 1500 + 5000) / 10_000));
    expect(viaNumber).not.toBe(151_602_637_542_620_819n);
  });

  it("accepts the largest storable amount and rejects anything above it", () => {
    expect(applyRate(MAX_MINOR_AMOUNT, 10_000)).toBe(MAX_MINOR_AMOUNT);
    expect(() =>
      calculateItemCharges({
        lines: [{ units: 2, unitPriceMinor: MAX_MINOR_AMOUNT }],
        commissionRateBps: 1500,
      }),
    ).toThrow(/line amount must be between 0 and/);
    expect(() =>
      calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: MAX_MINOR_AMOUNT }],
        taxRateBps: 1300,
        commissionRateBps: 1500,
      }),
    ).toThrow(/totalMinor must be between 0 and/);
  });

  it("calculates a Rs 100 crore bus-charter item and trip exactly", () => {
    const item = {
      ...calculateItemCharges({
        lines: [{ units: 2, unitPriceMinor: 50_000_000_000n }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    expect(item.subtotalMinor).toBe(100_000_000_000n);
    expect(item.commissionMinor).toBe(15_000_000_000n);
    expect(item.providerPayoutMinor).toBe(85_000_000_000n);

    const trip = summarizeTrip("NPR", [item, item]);
    expect(trip.totalMinor).toBe(200_000_000_000n);
    expect(trip.commissionTotalMinor).toBe(30_000_000_000n);
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
      lines: [{ units: 2, unitPriceMinor: 180_000n }],
      commissionRateBps: 1500,
    });
    expect(item).toMatchObject({
      quantity: 2,
      subtotalMinor: 360_000n,
      serviceChargeMinor: 0n,
      taxMinor: 0n,
      totalMinor: 360_000n,
      commissionMinor: 54_000n,
      providerPayoutMinor: 306_000n,
    });
  });

  it("hotel stay: 2 nights at different prices, 10% service charge, 13% VAT on top", () => {
    const item = calculateItemCharges({
      lines: [
        { units: 1, unitPriceMinor: 350_000n }, // night 1: Rs 3,500
        { units: 1, unitPriceMinor: 420_000n }, // night 2 (festival): Rs 4,200
      ],
      serviceChargeRateBps: 1000,
      taxRateBps: 1300,
      commissionRateBps: 1500,
    });
    // subtotal 7,700.00; service charge 770.00; VAT 13% of 8,470.00 = 1,101.10
    expect(item.subtotalMinor).toBe(770_000n);
    expect(item.serviceChargeMinor).toBe(77_000n);
    expect(item.taxMinor).toBe(110_110n);
    expect(item.totalMinor).toBe(957_110n);
    // Commission on the subtotal only: 15% of 7,700.00 = 1,155.00
    expect(item.commissionMinor).toBe(115_500n);
    expect(item.providerPayoutMinor).toBe(957_110n - 115_500n);
    expect(item.lines.map((l) => l.amountMinor)).toEqual([350_000n, 420_000n]);
  });

  it("uses a per-item commission rate when one is given", () => {
    const item = calculateItemCharges({
      lines: [{ units: 3, unitPriceMinor: 250_000n }],
      commissionRateBps: 1000,
    });
    expect(item.commissionMinor).toBe(75_000n);
  });

  it("rejects empty or invalid lines", () => {
    expect(() => calculateItemCharges({ lines: [], commissionRateBps: 1500 })).toThrow(RangeError);
    expect(() =>
      calculateItemCharges({
        lines: [{ units: 0, unitPriceMinor: 100n }],
        commissionRateBps: 1500,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: -5n }],
        commissionRateBps: 1500,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 100 as unknown as bigint }],
        commissionRateBps: 1500,
      }),
    ).toThrow(TypeError);
  });
});

describe("summarizeTrip", () => {
  it("sums rounded item amounts: commission per item, stored trip total", () => {
    // Three items whose commissions each round: 0.45 → 0, 1.5 → 2, 0.45 → 0 (paisa).
    const a = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 3n }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    const b = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 10n }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    const c = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 3n }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };

    const trip = summarizeTrip("NPR", [a, b, c]);

    expect(trip.subtotalMinor).toBe(16n);
    // Per-item rounding (0 + 2 + 0), NOT 15% of the trip subtotal (2.4 → 2 happens to match here):
    expect(trip.commissionTotalMinor).toBe(
      a.commissionMinor + b.commissionMinor + c.commissionMinor,
    );
  });

  it("Inaruwa → Shree Antu: bus + hotel in one trip", () => {
    const bus = {
      ...calculateItemCharges({
        lines: [{ units: 2, unitPriceMinor: 180_000n }],
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };
    const hotel = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 350_000n }],
        serviceChargeRateBps: 1000,
        taxRateBps: 1300,
        commissionRateBps: 1500,
      }),
      currency: "NPR",
    };

    const trip = summarizeTrip("NPR", [bus, hotel]);

    expect(trip).toEqual({
      currency: "NPR",
      subtotalMinor: 360_000n + 350_000n,
      serviceChargeMinor: 35_000n,
      taxMinor: 50_050n, // 13% of 3,850.00
      totalMinor: 360_000n + 435_050n,
      commissionTotalMinor: 54_000n + 52_500n,
    });
  });

  it("rejects mixed currencies (MVP: one currency per trip)", () => {
    const usd = {
      ...calculateItemCharges({
        lines: [{ units: 1, unitPriceMinor: 100n }],
        commissionRateBps: 1500,
      }),
      currency: "USD",
    };
    expect(() => summarizeTrip("NPR", [usd])).toThrow(/does not match trip currency/);
  });
});

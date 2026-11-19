import { describe, expect, it } from "vitest";
import {
  CurrencyMismatchError,
  paymentMethodOf,
  priceItem,
  statusesForPaymentMethod,
  summarizeQuote,
  type PricingListing,
} from "./trip-pricing.js";

const room: PricingListing = {
  currency: "NPR",
  basePriceMinor: 350_000n, // Rs 3,500 / night
  serviceChargeRateBps: 1000, // 10%
  taxRateBps: 1300, // 13% VAT
  commissionRateBps: null,
  providerCommissionRateBps: null,
};
const bus: PricingListing = {
  ...room,
  basePriceMinor: 180_000n,
  serviceChargeRateBps: 0,
  taxRateBps: 0,
};
const guide: PricingListing = { ...bus, basePriceMinor: 300_000n };

describe("priceItem", () => {
  it("hotel: one line per night, date overrides win, SC then VAT, commission on subtotal only", () => {
    const item = priceItem(
      room,
      [
        { date: "2027-01-10", priceOverrideMinor: null },
        { date: "2027-01-11", priceOverrideMinor: 420_000n },
      ],
      1,
    );
    expect(item.lines).toEqual([
      { date: "2027-01-10", units: 1, unitPriceMinor: 350_000n, amountMinor: 350_000n },
      { date: "2027-01-11", units: 1, unitPriceMinor: 420_000n, amountMinor: 420_000n },
    ]);
    // Rs 7,700 + 10% SC (770) + 13% VAT on 8,470 (1,101.10) = 9,571.10; commission 15% × 7,700 = 1,155.
    expect(item).toMatchObject({
      quantity: 2,
      subtotalMinor: 770_000n,
      serviceChargeMinor: 77_000n,
      taxMinor: 110_110n,
      totalMinor: 957_110n,
      commissionRateBps: 1500,
      commissionMinor: 115_500n,
      providerPayoutMinor: 841_610n,
      currency: "NPR",
    });
  });

  it("units per date multiply every line (2 rooms × 2 nights = 4 room-nights)", () => {
    const item = priceItem(
      room,
      [
        { date: "2027-01-10", priceOverrideMinor: null },
        { date: "2027-01-11", priceOverrideMinor: null },
      ],
      2,
    );
    expect(item.quantity).toBe(4);
    expect(item.subtotalMinor).toBe(1_400_000n);
  });

  it("uses listing → provider → 15% default for the commission rate", () => {
    const slot = [{ date: "2027-01-10", priceOverrideMinor: null }];
    expect(priceItem(bus, slot, 1).commissionRateBps).toBe(1500);
    expect(priceItem({ ...bus, providerCommissionRateBps: 1000 }, slot, 1).commissionRateBps).toBe(
      1000,
    );
    expect(
      priceItem({ ...bus, commissionRateBps: 800, providerCommissionRateBps: 1000 }, slot, 1)
        .commissionMinor,
    ).toBe(14_400n); // 8% of 1,800.00
  });

  it("rounds commission half-up to the paisa on odd amounts", () => {
    const slot = [{ date: "2027-01-10", priceOverrideMinor: 333_330n }]; // 15% = 49,999.5
    expect(priceItem(bus, slot, 1).commissionMinor).toBe(50_000n);
    const below = [{ date: "2027-01-10", priceOverrideMinor: 333_329n }]; // 15% = 49,999.35
    expect(priceItem(bus, below, 1).commissionMinor).toBe(49_999n);
  });
});

describe("summarizeQuote", () => {
  const hotelStay = {
    ...priceItem(
      room,
      [
        { date: "2027-01-10", priceOverrideMinor: null },
        { date: "2027-01-11", priceOverrideMinor: 420_000n },
      ],
      1,
    ),
    paymentMethod: "pay_at_property" as const,
  };
  const busSeats = {
    ...priceItem(bus, [{ date: "2027-01-10", priceOverrideMinor: null }], 2),
    paymentMethod: "online" as const,
  };
  const guideDays = {
    ...priceItem(
      guide,
      ["2027-01-11", "2027-01-12", "2027-01-13"].map((date) => ({
        date,
        priceOverrideMinor: null,
      })),
      1,
    ),
    paymentMethod: "online" as const,
  };

  it("multi-vertical, mixed payment: totals are item sums, split by payment method", () => {
    const totals = summarizeQuote("NPR", [hotelStay, busSeats, guideDays]);

    // Subtotals: hotel 7,700 + bus 3,600 + guide 9,000 = 20,300.
    expect(totals.subtotalMinor).toBe(2_030_000n);
    expect(totals.totalMinor).toBe(957_110n + 360_000n + 900_000n);
    // Commission per item: 1,155 + 540 + 1,350 = 3,045 (= 15% of 20,300 here, but summed per item).
    expect(totals.commissionTotalMinor).toBe(115_500n + 54_000n + 135_000n);

    expect(totals.payAtPropertyMinor).toBe(957_110n);
    expect(totals.payOnlineMinor).toBe(360_000n + 900_000n);
    expect(totals.commissionInvoicedMinor).toBe(115_500n); // pay-at-property: invoiced
    expect(totals.commissionFromPayoutsMinor).toBe(54_000n + 135_000n); // online: deducted
    expect(totals.providerPayoutsMinor).toBe(360_000n - 54_000n + 900_000n - 135_000n);
    expect(totals.payOnlineMinor + totals.payAtPropertyMinor).toBe(totals.totalMinor);
  });

  it("sums per-item rounded commissions (never 15% of the trip subtotal)", () => {
    const tiny = (price: bigint) => ({
      ...priceItem(bus, [{ date: "2027-01-10", priceOverrideMinor: price }], 1),
      paymentMethod: "online" as const,
    });
    // 15% of 10 paisa = 1.5 → 2, three times = 6; 15% of the 30-paisa total would be 4.5 → 5.
    const totals = summarizeQuote("NPR", [tiny(10n), tiny(10n), tiny(10n)]);
    expect(totals.commissionTotalMinor).toBe(6n);
  });

  it("rejects an item in another currency (one currency per trip)", () => {
    const usd = { ...busSeats, currency: "USD" };
    expect(() => summarizeQuote("NPR", [busSeats, usd])).toThrow(CurrencyMismatchError);
  });

  it("an empty trip quotes to zero", () => {
    const totals = summarizeQuote("NPR", []);
    expect(totals.totalMinor).toBe(0n);
    expect(totals.commissionTotalMinor).toBe(0n);
  });
});

describe("payment method ↔ statuses", () => {
  it("online: unpaid now, provider payout pending", () => {
    expect(statusesForPaymentMethod("online")).toEqual({
      paymentStatus: "UNPAID",
      payoutStatus: "PENDING",
    });
  });

  it("pay at property: no payout (provider collects), commission invoiced later", () => {
    expect(statusesForPaymentMethod("pay_at_property")).toEqual({
      paymentStatus: "PAY_AT_PROPERTY",
      payoutStatus: "NOT_APPLICABLE",
    });
  });

  it("round-trips through payment status", () => {
    expect(paymentMethodOf("PAY_AT_PROPERTY")).toBe("pay_at_property");
    expect(paymentMethodOf("UNPAID")).toBe("online");
    expect(paymentMethodOf("PAID")).toBe("online");
  });
});

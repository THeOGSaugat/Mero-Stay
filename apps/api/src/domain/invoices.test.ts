import { describe, expect, it } from "vitest";
import { draftInvoices, invoiceNumber } from "./invoices.js";
import { calculateItemCharges } from "./money.js";

describe("commission invoice drafts", () => {
  it("one invoice per provider; amount = sum of the items' commission (15% of subtotal, per item)", () => {
    // Homestay: 2 nights (Rs 3,500 + Rs 4,200) with 10% SC and 13% VAT: commission on the subtotal only.
    const stay = calculateItemCharges({
      lines: [
        { units: 1, unitPriceMinor: 350_000n },
        { units: 1, unitPriceMinor: 420_000n },
      ],
      serviceChargeRateBps: 1000,
      taxRateBps: 1300,
      commissionRateBps: 1500,
    });
    // A second item at the same provider with a commission that rounds (Rs 0.333… → half-up).
    const odd = calculateItemCharges({
      lines: [{ units: 1, unitPriceMinor: 2_223n }],
      commissionRateBps: 1500,
    });
    const tour = calculateItemCharges({
      lines: [{ units: 2, unitPriceMinor: 250_000n }],
      commissionRateBps: 1200,
    });
    expect([stay.commissionMinor, odd.commissionMinor, tour.commissionMinor]).toEqual([
      115_500n, // 15% of 7,70,000 paisa; VAT and SC excluded
      333n, // 333.45 → 333
      60_000n,
    ]);

    const drafts = draftInvoices([
      {
        id: "stay",
        providerId: "homestay",
        currency: "NPR",
        commissionMinor: stay.commissionMinor,
      },
      { id: "tour", providerId: "tours", currency: "NPR", commissionMinor: tour.commissionMinor },
      { id: "odd", providerId: "homestay", currency: "NPR", commissionMinor: odd.commissionMinor },
    ]);
    expect(drafts).toEqual([
      { providerId: "homestay", currency: "NPR", amountMinor: 115_833n, itemIds: ["stay", "odd"] },
      { providerId: "tours", currency: "NPR", amountMinor: 60_000n, itemIds: ["tour"] },
    ]);
  });

  it("nothing to invoice → no invoices", () => {
    expect(draftInvoices([])).toEqual([]);
  });

  it("rejects mixed currencies for one provider and invalid commission", () => {
    expect(() =>
      draftInvoices([
        { id: "a", providerId: "p", currency: "NPR", commissionMinor: 1n },
        { id: "b", providerId: "p", currency: "USD", commissionMinor: 1n },
      ]),
    ).toThrow(/two currencies/);
    expect(() =>
      draftInvoices([{ id: "a", providerId: "p", currency: "NPR", commissionMinor: -1n }]),
    ).toThrow(RangeError);
  });
});

describe("invoice number", () => {
  it("is INV-<Nepal issue date>-<8 unambiguous characters>", () => {
    const number = invoiceNumber("2026-11-21", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 30]));
    expect(number).toBe("INV-20261121-ABCDEFG9");
    expect(number).toMatch(/^INV-\d{8}-[A-HJKMNP-Z2-9]{8}$/);
  });

  it("rejects a malformed date or too little randomness", () => {
    expect(() => invoiceNumber("21/11/2026", new Uint8Array(8))).toThrow(RangeError);
    expect(() => invoiceNumber("2026-11-21", new Uint8Array(4))).toThrow(RangeError);
  });
});

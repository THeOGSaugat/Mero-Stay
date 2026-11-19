import type { PaymentStatus, PayoutStatus } from "../../generated/prisma/enums.js";
import {
  calculateItemCharges,
  resolveCommissionRateBps,
  summarizeTrip,
  type ItemCharges,
  type TripTotals,
} from "../../domain/money.js";

/**
 * Pure pricing for trips: no database, no HTTP. Used by add-item, update-item, quote and the
 * tests. All arithmetic is delegated to the Phase 2 helpers in src/domain/money.ts, which use the
 * same formulas the database CHECK constraints enforce, so a price computed here is exactly what
 * the database will accept.
 */

export const PAYMENT_METHODS = ["online", "pay_at_property"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export class CurrencyMismatchError extends Error {
  constructor(
    readonly tripCurrency: string,
    readonly itemCurrency: string,
  ) {
    super(`Item currency ${itemCurrency} does not match trip currency ${tripCurrency}`);
    this.name = "CurrencyMismatchError";
  }
}

/** Initial per-item statuses for a payment choice (Phase 2 model: the method lives in payment_status). */
export function statusesForPaymentMethod(method: PaymentMethod): {
  paymentStatus: PaymentStatus;
  payoutStatus: PayoutStatus;
} {
  return method === "pay_at_property"
    ? // The provider collects the money, so MeroStay pays nothing out; commission is invoiced.
      { paymentStatus: "PAY_AT_PROPERTY", payoutStatus: "NOT_APPLICABLE" }
    : // MeroStay collects online and later pays the provider total − commission.
      { paymentStatus: "UNPAID", payoutStatus: "PENDING" };
}

export function paymentMethodOf(paymentStatus: PaymentStatus): PaymentMethod {
  return paymentStatus === "PAY_AT_PROPERTY" ? "pay_at_property" : "online";
}

export interface PricingListing {
  currency: string;
  basePriceMinor: bigint;
  serviceChargeRateBps: number;
  taxRateBps: number;
  /** Listing-level commission override, or null to inherit. */
  commissionRateBps: number | null;
  /** Provider-level commission override, or null to inherit the platform default (15%). */
  providerCommissionRateBps: number | null;
}

export interface PricingSlot {
  /** "YYYY-MM-DD" */
  date: string;
  /** Date-specific price; null = listing base price. */
  priceOverrideMinor: bigint | null;
}

export interface PricedLine {
  date: string;
  units: number;
  unitPriceMinor: bigint;
  amountMinor: bigint;
}

export interface PricedItem extends Omit<ItemCharges, "lines"> {
  currency: string;
  lines: PricedLine[];
}

/**
 * Prices one booking item: one line per service date, unit price = the date's override or the
 * listing base price, then service charge, VAT, commission and provider payout per Phase 2 rules.
 */
export function priceItem(
  listing: PricingListing,
  slots: readonly PricingSlot[],
  unitsPerDate: number,
): PricedItem {
  const commissionRateBps = resolveCommissionRateBps({
    listingRateBps: listing.commissionRateBps,
    providerRateBps: listing.providerCommissionRateBps,
  });
  const charges = calculateItemCharges({
    lines: slots.map((slot) => ({
      units: unitsPerDate,
      unitPriceMinor: slot.priceOverrideMinor ?? listing.basePriceMinor,
    })),
    serviceChargeRateBps: listing.serviceChargeRateBps,
    taxRateBps: listing.taxRateBps,
    commissionRateBps,
  });
  return {
    ...charges,
    currency: listing.currency,
    lines: charges.lines.map((line, i) => ({ ...line, date: slots[i]?.date ?? "" })),
  };
}

export interface QuotableItem extends Pick<
  ItemCharges,
  | "subtotalMinor"
  | "serviceChargeMinor"
  | "taxMinor"
  | "totalMinor"
  | "commissionMinor"
  | "providerPayoutMinor"
> {
  currency: string;
  paymentMethod: PaymentMethod;
}

export interface TripQuoteTotals extends TripTotals {
  /** What the customer pays MeroStay online (sum of online item totals). */
  payOnlineMinor: bigint;
  /** What the customer pays providers on arrival (sum of pay-at-property item totals). */
  payAtPropertyMinor: bigint;
  /** Commission MeroStay will deduct from provider payouts (online items). */
  commissionFromPayoutsMinor: bigint;
  /** Commission MeroStay will invoice providers for (pay-at-property items). */
  commissionInvoicedMinor: bigint;
  /** What MeroStay will pay out to providers for online items (total − commission). */
  providerPayoutsMinor: bigint;
}

/** Trip totals = sums of item amounts (per-item rounding, Phase 2), split by payment method. */
export function summarizeQuote(
  tripCurrency: string,
  items: readonly QuotableItem[],
): TripQuoteTotals {
  for (const item of items) {
    if (item.currency !== tripCurrency)
      throw new CurrencyMismatchError(tripCurrency, item.currency);
  }
  const base = summarizeTrip(tripCurrency, items);
  const totals: TripQuoteTotals = {
    ...base,
    payOnlineMinor: 0n,
    payAtPropertyMinor: 0n,
    commissionFromPayoutsMinor: 0n,
    commissionInvoicedMinor: 0n,
    providerPayoutsMinor: 0n,
  };
  for (const item of items) {
    if (item.paymentMethod === "pay_at_property") {
      totals.payAtPropertyMinor += item.totalMinor;
      totals.commissionInvoicedMinor += item.commissionMinor;
    } else {
      totals.payOnlineMinor += item.totalMinor;
      totals.commissionFromPayoutsMinor += item.commissionMinor;
      totals.providerPayoutsMinor += item.providerPayoutMinor;
    }
  }
  return totals;
}

/**
 * Money rules for booking items and trips (ADR 0004, requirements §6).
 *
 * - Amounts are integers in minor units (paisa for NPR). Never floats.
 * - Rates are integer basis points: 1500 = 15%.
 * - x% of an amount rounds half-up to the nearest minor unit.
 * - Commission = rate × item SUBTOTAL (service charge and taxes excluded),
 *   deducted from the provider's share. The customer pays the item total.
 *
 * The database enforces the same formulas with CHECK constraints
 * (see the Phase 2 migration), so a wrong calculation cannot be stored.
 */

export const BPS_DENOMINATOR = 10_000;

/** Platform default commission: 15%. Overridable per provider and per listing. */
export const DEFAULT_COMMISSION_RATE_BPS = 1500;

function assertMinorAmount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer (minor units), got ${value}`);
  }
}

function assertRateBps(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > BPS_DENOMINATOR) {
    throw new RangeError(
      `${name} must be an integer between 0 and ${BPS_DENOMINATOR}, got ${value}`,
    );
  }
}

/** `rateBps` of `amountMinor`, rounded half-up to a whole minor unit. */
export function applyRate(amountMinor: number, rateBps: number): number {
  assertMinorAmount("amountMinor", amountMinor);
  assertRateBps("rateBps", rateBps);
  // Integer-only arithmetic: (a × r + 5000) / 10000, floored = half-up rounding for a ≥ 0.
  return Math.floor((amountMinor * rateBps + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
}

/** Commission rate for a booking: listing override → provider override → platform default. */
export function resolveCommissionRateBps(input: {
  listingRateBps?: number | null;
  providerRateBps?: number | null;
  platformDefaultBps?: number;
}): number {
  const rate =
    input.listingRateBps ??
    input.providerRateBps ??
    input.platformDefaultBps ??
    DEFAULT_COMMISSION_RATE_BPS;
  assertRateBps("commission rate", rate);
  return rate;
}

export interface PriceLineInput {
  /** Billable units on this date: rooms for a night, seats on a departure, guide-days, persons. */
  units: number;
  /** Price per unit for this date, in minor units. */
  unitPriceMinor: number;
}

export interface PriceLine extends PriceLineInput {
  amountMinor: number;
}

export interface ItemChargesInput {
  lines: readonly PriceLineInput[];
  serviceChargeRateBps?: number;
  taxRateBps?: number;
  commissionRateBps: number;
}

export interface ItemCharges {
  lines: PriceLine[];
  quantity: number;
  subtotalMinor: number;
  serviceChargeRateBps: number;
  serviceChargeMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  commissionRateBps: number;
  commissionMinor: number;
  providerPayoutMinor: number;
}

/**
 * All money fields of one booking item.
 *
 * Nepal billing order: service charge on the subtotal, then VAT on
 * (subtotal + service charge). Commission is on the subtotal only.
 */
export function calculateItemCharges(input: ItemChargesInput): ItemCharges {
  if (input.lines.length === 0) {
    throw new RangeError("a booking item needs at least one price line");
  }

  const lines = input.lines.map((line) => {
    if (!Number.isSafeInteger(line.units) || line.units <= 0) {
      throw new RangeError(`units must be a positive integer, got ${line.units}`);
    }
    assertMinorAmount("unitPriceMinor", line.unitPriceMinor);
    return { ...line, amountMinor: line.units * line.unitPriceMinor };
  });

  const serviceChargeRateBps = input.serviceChargeRateBps ?? 0;
  const taxRateBps = input.taxRateBps ?? 0;
  const { commissionRateBps } = input;

  const quantity = lines.reduce((sum, line) => sum + line.units, 0);
  const subtotalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const serviceChargeMinor = applyRate(subtotalMinor, serviceChargeRateBps);
  const taxMinor = applyRate(subtotalMinor + serviceChargeMinor, taxRateBps);
  const totalMinor = subtotalMinor + serviceChargeMinor + taxMinor;
  const commissionMinor = applyRate(subtotalMinor, commissionRateBps);

  return {
    lines,
    quantity,
    subtotalMinor,
    serviceChargeRateBps,
    serviceChargeMinor,
    taxRateBps,
    taxMinor,
    totalMinor,
    commissionRateBps,
    commissionMinor,
    providerPayoutMinor: totalMinor - commissionMinor,
  };
}

export interface TripTotals {
  currency: string;
  subtotalMinor: number;
  serviceChargeMinor: number;
  taxMinor: number;
  totalMinor: number;
  commissionTotalMinor: number;
}

/**
 * Trip-level totals = sums of the (already rounded) item amounts.
 * MVP rule: every item in a trip uses the trip's currency.
 */
export function summarizeTrip(
  currency: string,
  items: readonly (Pick<
    ItemCharges,
    "subtotalMinor" | "serviceChargeMinor" | "taxMinor" | "totalMinor" | "commissionMinor"
  > & { currency: string })[],
): TripTotals {
  const totals: TripTotals = {
    currency,
    subtotalMinor: 0,
    serviceChargeMinor: 0,
    taxMinor: 0,
    totalMinor: 0,
    commissionTotalMinor: 0,
  };
  for (const item of items) {
    if (item.currency !== currency) {
      throw new RangeError(
        `item currency ${item.currency} does not match trip currency ${currency}`,
      );
    }
    totals.subtotalMinor += item.subtotalMinor;
    totals.serviceChargeMinor += item.serviceChargeMinor;
    totals.taxMinor += item.taxMinor;
    totals.totalMinor += item.totalMinor;
    totals.commissionTotalMinor += item.commissionMinor;
  }
  return totals;
}

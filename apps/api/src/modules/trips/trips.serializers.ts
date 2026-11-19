import { fromDbDate } from "../../domain/dates.js";
import { currencyInfo, minorToString, toJsonSafe } from "../../lib/money-json.js";
import {
  paymentMethodOf,
  summarizeQuote,
  type PricedItem,
  type TripQuoteTotals,
} from "./trip-pricing.js";
import { ACTIVE_ITEM_STATUSES, type TripWithItems } from "./trips.repository.js";
import type { TripQuote } from "./trips.service.js";

/**
 * Trip and quote response shapes. Every money field is a digit string in minor units ("115500" =
 * Rs 1,155.00), next to `currency` and `currencyExponent` (ADR 0005). Never a JSON number.
 */

type Item = TripWithItems["items"][number];

function serializeMoney(priced: Omit<PricedItem, "lines" | "currency" | "quantity">) {
  return {
    subtotalMinor: minorToString(priced.subtotalMinor),
    serviceChargeRateBps: priced.serviceChargeRateBps,
    serviceChargeMinor: minorToString(priced.serviceChargeMinor),
    taxRateBps: priced.taxRateBps,
    taxMinor: minorToString(priced.taxMinor),
    totalMinor: minorToString(priced.totalMinor),
    commissionRateBps: priced.commissionRateBps,
    commissionMinor: minorToString(priced.commissionMinor),
    providerPayoutMinor: minorToString(priced.providerPayoutMinor),
  };
}

function serializeLines(lines: PricedItem["lines"]) {
  return lines.map((line) => ({
    date: line.date,
    units: line.units,
    unitPriceMinor: minorToString(line.unitPriceMinor),
    amountMinor: minorToString(line.amountMinor),
  }));
}

export function serializeTotals(totals: TripQuoteTotals) {
  return {
    subtotalMinor: minorToString(totals.subtotalMinor),
    serviceChargeMinor: minorToString(totals.serviceChargeMinor),
    taxMinor: minorToString(totals.taxMinor),
    totalMinor: minorToString(totals.totalMinor),
    commissionTotalMinor: minorToString(totals.commissionTotalMinor),
    payOnlineMinor: minorToString(totals.payOnlineMinor),
    payAtPropertyMinor: minorToString(totals.payAtPropertyMinor),
    commissionFromPayoutsMinor: minorToString(totals.commissionFromPayoutsMinor),
    commissionInvoicedMinor: minorToString(totals.commissionInvoicedMinor),
    providerPayoutsMinor: minorToString(totals.providerPayoutsMinor),
  };
}

export function serializeItem(item: Item) {
  return {
    id: item.id,
    status: item.status,
    listing: {
      id: item.listing.id,
      title: item.listing.title,
      slug: item.listing.slug,
      listingType: item.listing.listingTypeCode,
      provider: { id: item.listing.provider.id, name: item.listing.provider.displayName },
    },
    startDate: fromDbDate(item.startDate),
    endDate: item.endDate ? fromDbDate(item.endDate) : null,
    travellerCount: item.travellerCount,
    quantity: item.quantity,
    paymentMethod: paymentMethodOf(item.paymentStatus),
    paymentStatus: item.paymentStatus,
    commissionStatus: item.commissionStatus,
    payoutStatus: item.payoutStatus,
    ...currencyInfo(item.currency),
    lines: item.slots.map((slot) => ({
      date: fromDbDate(slot.serviceDate),
      units: slot.units,
      unitPriceMinor: minorToString(slot.unitPriceMinor),
      amountMinor: minorToString(slot.amountMinor),
    })),
    money: {
      ...serializeMoney(item),
      refundedMinor: minorToString(item.refundedMinor),
    },
    cancellationPolicy: toJsonSafe(item.cancellationPolicySnapshot),
    attributes: toJsonSafe(item.attributes),
    confirmedAt: item.confirmedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

export function serializeTrip(trip: TripWithItems) {
  const active = trip.items.filter((item) =>
    (ACTIVE_ITEM_STATUSES as readonly string[]).includes(item.status),
  );
  // Stored trip totals (sums of items) plus the split by payment method, derived from the items.
  const split = summarizeQuote(
    trip.currency,
    active.map((item) => ({ ...item, paymentMethod: paymentMethodOf(item.paymentStatus) })),
  );
  return {
    data: {
      id: trip.id,
      reference: trip.reference,
      status: trip.status,
      /** TEMPORARY until authentication: the trip owner as supplied when the trip was created. */
      userId: trip.customerId,
      ...currencyInfo(trip.currency),
      contact: { name: trip.contactName, phone: trip.contactPhone, email: trip.contactEmail },
      totals: {
        ...serializeTotals(split),
        // Stored aggregates are the source of truth for these five; they equal the item sums.
        subtotalMinor: minorToString(trip.subtotalMinor),
        serviceChargeMinor: minorToString(trip.serviceChargeMinor),
        taxMinor: minorToString(trip.taxMinor),
        totalMinor: minorToString(trip.totalMinor),
        commissionTotalMinor: minorToString(trip.commissionTotalMinor),
      },
      items: trip.items.map(serializeItem),
      expiresAt: trip.expiresAt?.toISOString() ?? null,
      confirmedAt: trip.confirmedAt?.toISOString() ?? null,
      createdAt: trip.createdAt.toISOString(),
      updatedAt: trip.updatedAt.toISOString(),
    },
  };
}

export function serializeQuote(quote: TripQuote) {
  return {
    data: {
      tripId: quote.trip.id,
      dryRun: true,
      ...currencyInfo(quote.trip.currency),
      lines: quote.lines.map((line) => ({
        itemId: line.itemId,
        candidateIndex: line.candidateIndex,
        listing: line.listing,
        paymentMethod: line.paymentMethod,
        startDate: line.startDate,
        endDate: line.endDate,
        quantity: line.quantity,
        available: line.available,
        unavailableDates: line.unavailableDates,
        priceChanged: line.priceChanged,
        lines: serializeLines(line.priced.lines),
        money: serializeMoney(line.priced),
        heldMoney: line.held ? serializeMoney(line.held) : null,
      })),
      totals: serializeTotals(quote.totals),
      allAvailable: quote.lines.every((line) => line.available),
    },
  };
}

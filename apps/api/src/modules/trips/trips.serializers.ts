import { fromDbDate } from "../../domain/dates.js";
import { currencyInfo, minorToString, toJsonSafe } from "../../lib/money-json.js";
import {
  paymentMethodOf,
  summarizeQuote,
  type PricedItem,
  type TripQuoteTotals,
} from "./trip-pricing.js";
import { ACTIVE_ITEM_STATUSES, type TripSummary, type TripWithItems } from "./trips.repository.js";
import type { TripQuote } from "./trips.service.js";

/**
 * Trip and quote response shapes for the CUSTOMER who owns the trip. Every money field is a digit
 * string in minor units ("115500" = Rs 1,155.00), next to `currency` and `currencyExponent`
 * (ADR 0005). Never a JSON number.
 *
 * Commission and provider-payout data are MeroStay/provider business information and are NOT part
 * of the customer view (ADR 0006): no commission rate/amount, provider payout, commission status
 * or payout status. They remain stored on each item; admin/partner views arrive with their phases.
 */

type Item = TripWithItems["items"][number];

/** Paid online towards an item so far (sum of allocations from succeeded charges). */
function paidMinor(item: Item): bigint {
  return item.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0n);
}

function serializeMoney(priced: Omit<PricedItem, "lines" | "currency" | "quantity">) {
  return {
    subtotalMinor: minorToString(priced.subtotalMinor),
    serviceChargeRateBps: priced.serviceChargeRateBps,
    serviceChargeMinor: minorToString(priced.serviceChargeMinor),
    taxRateBps: priced.taxRateBps,
    taxMinor: minorToString(priced.taxMinor),
    totalMinor: minorToString(priced.totalMinor),
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

/** What the customer pays: totals and the split between paying online and at the property. */
export function serializeTotals(totals: TripQuoteTotals) {
  return {
    subtotalMinor: minorToString(totals.subtotalMinor),
    serviceChargeMinor: minorToString(totals.serviceChargeMinor),
    taxMinor: minorToString(totals.taxMinor),
    totalMinor: minorToString(totals.totalMinor),
    payOnlineMinor: minorToString(totals.payOnlineMinor),
    payAtPropertyMinor: minorToString(totals.payAtPropertyMinor),
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
    ...currencyInfo(item.currency),
    lines: item.slots.map((slot) => ({
      date: fromDbDate(slot.serviceDate),
      units: slot.units,
      unitPriceMinor: minorToString(slot.unitPriceMinor),
      amountMinor: minorToString(slot.amountMinor),
    })),
    money: {
      ...serializeMoney(item),
      paidMinor: minorToString(paidMinor(item)),
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
  const paidOnline = active.reduce((sum, item) => sum + paidMinor(item), 0n);
  return {
    data: {
      id: trip.id,
      reference: trip.reference,
      status: trip.status,
      ...currencyInfo(trip.currency),
      contact: { name: trip.contactName, phone: trip.contactPhone, email: trip.contactEmail },
      totals: {
        ...serializeTotals(split),
        // Stored aggregates are the source of truth for these four; they equal the item sums.
        subtotalMinor: minorToString(trip.subtotalMinor),
        serviceChargeMinor: minorToString(trip.serviceChargeMinor),
        taxMinor: minorToString(trip.taxMinor),
        totalMinor: minorToString(trip.totalMinor),
      },
      // Online money received so far, and what is still to pay online (ADR 0007).
      onlinePayment: {
        paidMinor: minorToString(paidOnline),
        dueMinor: minorToString(split.payOnlineMinor - paidOnline),
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

/** GET /api/v1/trips: customer view summaries (no commission/payout), money as strings. */
export function serializeTripList(result: {
  trips: TripSummary[];
  total: number;
  page: number;
  pageSize: number;
}) {
  return {
    data: result.trips.map((trip) => ({
      id: trip.id,
      reference: trip.reference,
      status: trip.status,
      ...currencyInfo(trip.currency),
      totals: {
        subtotalMinor: minorToString(trip.subtotalMinor),
        serviceChargeMinor: minorToString(trip.serviceChargeMinor),
        taxMinor: minorToString(trip.taxMinor),
        totalMinor: minorToString(trip.totalMinor),
      },
      items: trip.items.map((item) => ({
        id: item.id,
        status: item.status,
        title: item.listing.title,
        listingType: item.listing.listingTypeCode,
        startDate: fromDbDate(item.startDate),
        endDate: item.endDate ? fromDbDate(item.endDate) : null,
      })),
      expiresAt: trip.expiresAt?.toISOString() ?? null,
      confirmedAt: trip.confirmedAt?.toISOString() ?? null,
      createdAt: trip.createdAt.toISOString(),
    })),
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / result.pageSize),
    },
  };
}

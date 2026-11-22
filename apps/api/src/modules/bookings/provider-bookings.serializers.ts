import { fromDbDate } from "../../domain/dates.js";
import { maskEmail, maskPhone } from "../../domain/masking.js";
import { currencyInfo, minorToString, toJsonSafe } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import { paymentMethodOf } from "../trips/trip-pricing.js";
import type { ProviderBooking } from "./provider-bookings.service.js";

/**
 * The provider's view of a booking item. Unlike the customer view it includes commission and
 * payout figures (that is MeroStay ↔ provider data). The customer is shown by NAME only; email and
 * phone are masked (ADR 0008). Money is digit strings with currency (ADR 0005).
 */

function customerOf(item: ProviderBooking) {
  const { trip } = item;
  return {
    name: trip.contactName ?? trip.customer.fullName,
    emailMasked: maskEmail(trip.contactEmail ?? trip.customer.email),
    phoneMasked: maskPhone(trip.contactPhone ?? trip.customer.phone),
  };
}

export function serializeProviderBooking(item: ProviderBooking) {
  const paid = item.allocations.reduce((sum, a) => sum + a.amountMinor, 0n);
  return {
    id: item.id,
    tripReference: item.trip.reference,
    status: item.status,
    listing: {
      id: item.listing.id,
      title: item.listing.title,
      listingType: item.listing.listingTypeCode,
    },
    startDate: fromDbDate(item.startDate),
    endDate: item.endDate ? fromDbDate(item.endDate) : null,
    quantity: item.quantity,
    travellerCount: item.travellerCount,
    customer: customerOf(item),
    paymentMethod: paymentMethodOf(item.paymentStatus),
    paymentStatus: item.paymentStatus,
    commissionStatus: item.commissionStatus,
    payoutStatus: item.payoutStatus,
    ...currencyInfo(item.currency),
    money: {
      subtotalMinor: minorToString(item.subtotalMinor),
      serviceChargeMinor: minorToString(item.serviceChargeMinor),
      taxMinor: minorToString(item.taxMinor),
      totalMinor: minorToString(item.totalMinor),
      commissionRateBps: item.commissionRateBps,
      commissionMinor: minorToString(item.commissionMinor),
      providerPayoutMinor: minorToString(item.providerPayoutMinor),
      paidOnlineMinor: minorToString(paid),
      refundedMinor: minorToString(item.refundedMinor),
    },
    commissionInvoice: item.commissionInvoice,
    settledAt: item.paymentSettledAt?.toISOString() ?? null,
    confirmedAt: item.confirmedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

export function serializeProviderBookingDetail(item: ProviderBooking) {
  return {
    data: {
      ...serializeProviderBooking(item),
      lines: item.slots.map((slot) => ({
        date: fromDbDate(slot.serviceDate),
        units: slot.units,
        unitPriceMinor: minorToString(slot.unitPriceMinor),
        amountMinor: minorToString(slot.amountMinor),
      })),
      cancellationPolicy: toJsonSafe(item.cancellationPolicySnapshot),
      attributes: toJsonSafe(item.attributes),
    },
  };
}

export function serializeProviderBookingList(items: ProviderBooking[], total: number, page: Page) {
  return { data: items.map(serializeProviderBooking), page: pageInfo(page, total) };
}

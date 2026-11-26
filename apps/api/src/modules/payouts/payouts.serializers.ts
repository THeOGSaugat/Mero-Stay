import { fromDbDate } from "../../domain/dates.js";
import { maskReference } from "../../domain/payouts.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import { periodOf, type PayoutItemRow, type PayoutRow } from "./payouts.service.js";

/**
 * Payout batches as partners and admins see them (ADR 0018). Money as digit strings with the
 * currency (ADR 0005); the bank reference only ever masked; the account only as its masked label.
 */
export function serializePayout(payout: PayoutRow) {
  return {
    id: payout.id,
    provider: { id: payout.provider.id, name: payout.provider.displayName },
    period: periodOf(payout),
    periodStart: fromDbDate(payout.periodStart),
    periodEnd: fromDbDate(payout.periodEnd),
    status: payout.status,
    ...currencyInfo(payout.currency),
    grossMinor: minorToString(payout.grossMinor),
    commissionMinor: minorToString(payout.commissionMinor),
    netMinor: minorToString(payout.amountMinor),
    itemCount: payout.itemCount,
    payoutAccountLabel: payout.payoutAccountLabel,
    bankReferenceMasked: maskReference(payout.reference),
    scheduledAt: payout.scheduledAt?.toISOString() ?? null,
    paidAt: payout.paidAt?.toISOString() ?? null,
    failedAt: payout.failedAt?.toISOString() ?? null,
    failureReason: payout.failureReason,
    createdAt: payout.createdAt.toISOString(),
  };
}

export function serializePayoutItem(item: PayoutItemRow) {
  return {
    id: item.id,
    trip: { id: item.trip.id, reference: item.trip.reference },
    listing: {
      id: item.listing.id,
      title: item.listing.title,
      listingType: item.listing.listingTypeCode,
    },
    startDate: fromDbDate(item.startDate),
    endDate: item.endDate ? fromDbDate(item.endDate) : null,
    quantity: item.quantity,
    ...currencyInfo(item.currency),
    totalMinor: minorToString(item.totalMinor),
    commissionMinor: minorToString(item.commissionMinor),
    netMinor: minorToString(item.providerPayoutMinor),
  };
}

export function serializePayoutPage(rows: PayoutRow[], total: number, page: Page) {
  return { data: rows.map(serializePayout), page: pageInfo(page, total) };
}

export function serializePayoutDetail(payout: PayoutRow, items: PayoutItemRow[]) {
  return { data: { ...serializePayout(payout), items: items.map(serializePayoutItem) } };
}

export function serializePayoutChanges(changes: { payout: PayoutRow; changed: boolean }[]) {
  return { data: changes.map((c) => ({ changed: c.changed, payout: serializePayout(c.payout) })) };
}

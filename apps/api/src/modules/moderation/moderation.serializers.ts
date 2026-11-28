import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import type { ReviewEntry } from "./moderation.service.js";

/** A listing as the admin review queue shows it (ADR 0018), with the type-rule hint. */
export function serializeReviewEntry({ listing, typeRule }: ReviewEntry) {
  return {
    id: listing.id,
    title: listing.title,
    status: listing.status,
    listingType: { code: listing.listingType.code, isActive: listing.listingType.isActive },
    provider: {
      id: listing.provider.id,
      name: listing.provider.displayName,
      providerType: listing.provider.providerTypeCode,
      status: listing.provider.status,
    },
    location: listing.location
      ? { id: listing.location.id, name: listing.location.name, slug: listing.location.slug }
      : null,
    reviewedAt: listing.reviewedAt?.toISOString() ?? null,
    reviewNote: listing.reviewNote,
    submittedAt: listing.updatedAt.toISOString(),
    typeRule,
  };
}

export function serializeReviewPage(entries: ReviewEntry[], total: number, page: Page) {
  return { data: entries.map(serializeReviewEntry), page: pageInfo(page, total) };
}

export function serializeVoid(result: {
  tripId: string;
  items: {
    itemId: string;
    changed: boolean;
    refundRequests: number;
    invoiceAdjusted: boolean;
    /** Paid-out items (gap 39): what the provider owes back, minor units. */
    clawbackMinor: bigint | null;
    currency: string;
  }[];
}) {
  return {
    data: {
      tripId: result.tripId,
      items: result.items.map(({ currency, clawbackMinor, ...item }) => ({
        ...item,
        // Present only for a paid-out item (gap 39), with its currency.
        ...(clawbackMinor === null
          ? {}
          : { ...currencyInfo(currency), clawbackMinor: minorToString(clawbackMinor) }),
      })),
    },
  };
}

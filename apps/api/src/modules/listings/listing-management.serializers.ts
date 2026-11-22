import { currencyInfo, minorToString, toJsonSafe } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import { DETAIL_RELATIONS } from "./listings.repository.js";
import type { ManagedListing } from "./listing-management.service.js";

/** The partner's view of their own listing: every status, money as strings (ADR 0005). */
export function serializeManagedListing(listing: ManagedListing) {
  const relation = DETAIL_RELATIONS.find((key) => listing[key] !== null);
  const details = relation ? (toJsonSafe(listing[relation]) as Record<string, unknown>) : null;
  if (details) delete details.listingId;
  return {
    id: listing.id,
    status: listing.status,
    listingType: {
      code: listing.listingType.code,
      name: listing.listingType.name,
      unitLabel: listing.listingType.unitLabel,
      isBookable: listing.listingType.isBookable,
    },
    title: listing.title,
    slug: listing.slug,
    description: listing.description,
    parent: listing.parent,
    location: listing.location,
    addressLine: listing.addressLine,
    ...currencyInfo(listing.currency),
    basePriceMinor: minorToString(listing.basePriceMinor),
    serviceChargeRateBps: listing.serviceChargeRateBps,
    taxRateBps: listing.taxRateBps,
    /** Set by MeroStay (null = provider/platform default); read-only for partners. */
    commissionRateBps: listing.commissionRateBps,
    defaultCancellationPolicyId: listing.defaultCancellationPolicyId,
    attributes: toJsonSafe(listing.attributes),
    details,
    publishedAt: listing.publishedAt?.toISOString() ?? null,
    createdAt: listing.createdAt.toISOString(),
    updatedAt: listing.updatedAt.toISOString(),
  };
}

export function serializeManagedListingList(listings: ManagedListing[], total: number, page: Page) {
  return { data: listings.map(serializeManagedListing), page: pageInfo(page, total) };
}

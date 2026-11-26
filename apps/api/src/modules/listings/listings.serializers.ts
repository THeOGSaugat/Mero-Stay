import { currencyInfo, minorToString, toJsonSafe } from "../../lib/money-json.js";
import { resolveCancellationPolicy } from "../../domain/cancellation-policy.js";
import { serializeResolvedPolicy } from "../cancellation-policies/cancellation-policies.serializers.js";
import { DETAIL_RELATIONS } from "./listings.repository.js";
import type {
  ListingAvailability,
  getListingDetailService,
  getListingTypes,
  searchListingsService,
} from "./listings.service.js";

/**
 * Response shapes for listing endpoints. Every money field is a digit string in minor units, next
 * to `currency` and `currencyExponent` (ADR 0005).
 */

type ListingTypeRow = Awaited<ReturnType<typeof getListingTypes>>[number];
type SearchResult = Awaited<ReturnType<typeof searchListingsService>>;
type SearchRow = SearchResult["items"][number];
type DetailResult = Awaited<ReturnType<typeof getListingDetailService>>;

export function serializeListingType(type: ListingTypeRow) {
  return {
    code: type.code,
    name: type.name,
    unitLabel: type.unitLabel,
    isBookable: type.isBookable,
    isActive: type.isActive,
  };
}

function serializeAvailability(availability: ListingAvailability | undefined) {
  if (!availability) return null;
  return {
    startDate: availability.startDate,
    endDate: availability.endDate,
    quantity: availability.quantity,
    dates: availability.dates,
    minAvailable: availability.minAvailable,
    estimatedSubtotalMinor: minorToString(availability.estimatedSubtotalMinor),
  };
}

export function serializeListingSummary(row: SearchRow, availability?: ListingAvailability) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    listingType: {
      code: row.listingType.code,
      name: row.listingType.name,
      unitLabel: row.listingType.unitLabel,
    },
    provider: { id: row.provider.id, name: row.provider.displayName },
    location: row.location,
    parent: row.parent,
    ...currencyInfo(row.currency),
    basePriceMinor: minorToString(row.basePriceMinor),
    serviceChargeRateBps: row.serviceChargeRateBps,
    taxRateBps: row.taxRateBps,
    attributes: toJsonSafe(row.attributes),
    availability: serializeAvailability(availability),
  };
}

export function serializeSearchResult(result: SearchResult) {
  return {
    data: result.items.map((item) =>
      serializeListingSummary(item, result.availability.get(item.id)),
    ),
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  };
}

/** The type-specific detail row (whichever detail table this listing uses), or null. */
function pickDetails(listing: DetailResult["listing"]): unknown {
  for (const relation of DETAIL_RELATIONS) {
    const detail = listing[relation] as Record<string, unknown> | null;
    if (detail) {
      const { listingId: _listingId, ...fields } = detail;
      return toJsonSafe(fields);
    }
  }
  return null;
}

export function serializeListingDetail(result: DetailResult) {
  const { listing } = result;
  return {
    data: {
      id: listing.id,
      title: listing.title,
      slug: listing.slug,
      description: listing.description,
      listingType: {
        code: listing.listingType.code,
        name: listing.listingType.name,
        unitLabel: listing.listingType.unitLabel,
        isBookable: result.isBookable,
      },
      provider: {
        id: listing.provider.id,
        name: listing.provider.displayName,
        providerType: listing.provider.providerTypeCode,
      },
      location: listing.location,
      parent: listing.parent,
      addressLine: listing.addressLine,
      latitude: listing.latitude?.toString() ?? null,
      longitude: listing.longitude?.toString() ?? null,
      ...currencyInfo(listing.currency),
      basePriceMinor: minorToString(listing.basePriceMinor),
      serviceChargeRateBps: listing.serviceChargeRateBps,
      taxRateBps: listing.taxRateBps,
      details: pickDetails(listing),
      attributes: toJsonSafe(listing.attributes),
      // The policy that applies now: the listing's, else the provider's default, else null
      // (shown as "no cancellation policy"). A booking keeps its own frozen copy (ADR 0015).
      cancellationPolicy: serializeResolvedPolicy(
        resolveCancellationPolicy(
          listing.defaultCancellationPolicy,
          listing.provider.defaultCancellationPolicy,
        ),
      ),
      children: listing.children.map((child) => ({
        id: child.id,
        title: child.title,
        slug: child.slug,
        listingType: child.listingTypeCode,
        ...currencyInfo(child.currency),
        basePriceMinor: minorToString(child.basePriceMinor),
      })),
      calendar: {
        from: result.calendar.from,
        to: result.calendar.to,
        ...currencyInfo(listing.currency),
        slots: result.calendar.slots.map((slot) => ({
          date: slot.date,
          status: slot.status,
          available: slot.available,
          unitPriceMinor: minorToString(slot.unitPriceMinor),
        })),
      },
    },
  };
}

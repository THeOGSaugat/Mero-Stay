import type { ListingType } from "./api-types";
import { isMinorString, majorInputToMinor } from "./money";

/**
 * Search filters (ADR 0010). The /search page URL holds what the person chose (prices in
 * rupees, as typed); `toApiQuery` turns it into the API query (prices in minor units, as digit
 * strings). Pure functions: unit-tested, no network.
 */

export interface SearchFilters {
  type?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  quantity?: string;
  /** As typed, in major units (rupees). */
  minPrice?: string;
  maxPrice?: string;
  currency?: string;
  sort?: string;
  page?: string;
}

const FILTER_KEYS: readonly (keyof SearchFilters)[] = [
  "type",
  "location",
  "startDate",
  "endDate",
  "quantity",
  "minPrice",
  "maxPrice",
  "currency",
  "sort",
  "page",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPE_CODE = /^[a-z_]{2,40}$/;
const SORTS = new Set(["price_asc", "price_desc", "title"]);

/** The filters a person can choose from: active AND bookable listing types only (no flights). */
export function selectableListingTypes(types: readonly ListingType[]): ListingType[] {
  return types.filter((type) => type.isActive && type.isBookable);
}

/** Reads the page's searchParams (Next.js gives string | string[] | undefined). */
export function filtersFromSearchParams(
  params: Record<string, string | string[] | undefined>,
): SearchFilters {
  const filters: SearchFilters = {};
  for (const key of FILTER_KEYS) {
    const raw = params[key];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value) filters[key] = value;
  }
  return filters;
}

export interface ApiQueryResult {
  query: URLSearchParams;
  /** Filters that were ignored because they were invalid (shown to the person). */
  problems: string[];
}

/**
 * The API query for GET /listings. Invalid values are dropped and reported instead of being
 * sent (the API would answer 400). Prices are converted to minor units with string operations.
 */
export function toApiQuery(filters: SearchFilters, currencyExponent = 2): ApiQueryResult {
  const query = new URLSearchParams();
  const problems: string[] = [];

  if (filters.type) {
    if (TYPE_CODE.test(filters.type)) query.set("type", filters.type);
    else problems.push("Unknown listing type.");
  }
  if (filters.location) {
    const slug = filters.location.toLowerCase().replace(/\s+/g, "-");
    if (SLUG.test(slug)) query.set("location", slug);
    else problems.push("Location must be a place name such as pokhara or kaski.");
  }
  const validStart = filters.startDate && ISO_DATE.test(filters.startDate);
  const validEnd = filters.endDate && ISO_DATE.test(filters.endDate);
  if (filters.startDate && !validStart) problems.push("Check-in date is not a valid date.");
  if (filters.endDate && !validEnd) problems.push("Check-out date is not a valid date.");
  if (validStart) query.set("startDate", filters.startDate!);
  if (validEnd) {
    if (!validStart) problems.push("Choose a start date as well as an end date.");
    else if (filters.endDate! <= filters.startDate!)
      problems.push("The end date must be after the start date.");
    else query.set("endDate", filters.endDate!);
  }
  if (filters.quantity) {
    if (/^[1-9]\d{0,2}$/.test(filters.quantity)) query.set("quantity", filters.quantity);
    else problems.push("Guests / quantity must be a whole number from 1.");
  }
  for (const [key, label] of [
    ["minPrice", "Minimum price"],
    ["maxPrice", "Maximum price"],
  ] as const) {
    const value = filters[key];
    if (!value) continue;
    const minor = majorInputToMinor(value, currencyExponent);
    if (minor !== null && isMinorString(minor)) query.set(key, minor);
    else problems.push(`${label} must be an amount such as 1500 or 1500.50.`);
  }
  if (filters.currency) {
    if (/^[A-Z]{3}$/.test(filters.currency)) query.set("currency", filters.currency);
    else problems.push("Currency must be a 3-letter code such as NPR.");
  }
  if (filters.sort) {
    if (SORTS.has(filters.sort)) query.set("sort", filters.sort);
    else problems.push("Unknown sort order.");
  }
  if (filters.page && /^[1-9]\d{0,3}$/.test(filters.page)) query.set("page", filters.page);
  return { query, problems };
}

/** The /search URL for the same filters on another page. */
export function searchPageHref(filters: SearchFilters, page: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = key === "page" ? undefined : filters[key];
    if (value) params.set(key, value);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

/**
 * Whether bookings of this unit cover a date RANGE ([start, end): nights, guide days) or a single
 * date (bus seat, tour departure). Decided by the listing type's unit label: data, not code per
 * vertical.
 */
export function usesDateRange(unitLabel: string): boolean {
  return unitLabel === "night" || unitLabel === "day";
}

/** "2026-12-31" + 1 → "2027-01-01" (calendar dates, UTC arithmetic; no time zones involved). */
export function addIsoDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The listing calendar window for the dates a person searched for: [startDate, endDate) for a
 * range, or just the start date's day. The API's `to` is exclusive and at most 60 days after
 * `from`; anything else falls back to the API's default window (null).
 */
export function calendarWindow(
  startDate: string | undefined,
  endDate: string | undefined,
): { from: string; to: string } | null {
  if (!startDate || !ISO_DATE.test(startDate)) return null;
  const to =
    endDate && ISO_DATE.test(endDate) && endDate > startDate ? endDate : addIsoDays(startDate, 1);
  return to <= addIsoDays(startDate, 60) ? { from: startDate, to } : null;
}

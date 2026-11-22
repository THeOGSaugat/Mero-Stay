import Link from "next/link";
import type { ListingSummary, ListingType, Pagination } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import {
  filtersFromSearchParams,
  searchPageHref,
  toApiQuery,
  type SearchFilters,
} from "@/lib/search";
import { serverApi } from "@/lib/server-api";
import { Alert, buttonSecondary } from "../ui/primitives";
import { SearchForm } from "./search-form";

function currencyExponentOf(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function listingHref(listing: ListingSummary, filters: SearchFilters): string {
  const params = new URLSearchParams();
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.quantity) params.set("quantity", filters.quantity);
  const query = params.toString();
  return `/listings/${listing.id}${query ? `?${query}` : ""}`;
}

function ResultCard({ listing, filters }: { listing: ListingSummary; filters: SearchFilters }) {
  const price = formatMoney(listing.basePriceMinor, listing.currency, listing.currencyExponent);
  const availability = listing.availability;
  return (
    <li className="rounded-xl border border-mist bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
            {listing.listingType.name}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-navy">
            <Link href={listingHref(listing, filters)} className="hover:underline">
              {listing.title}
            </Link>
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {listing.parent ? `${listing.parent.title} · ` : ""}
            {listing.provider.name}
            {listing.location ? ` · ${listing.location.name}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-navy" data-testid="listing-price">
            {price}
          </p>
          <p className="text-xs text-slate-600">
            per {listing.listingType.unitLabel}, before taxes
          </p>
        </div>
      </div>
      {availability ? (
        <p className="mt-3 rounded-lg bg-mist px-3 py-2 text-sm text-ink">
          {availability.minAvailable} available ·{" "}
          {formatMoney(
            availability.estimatedSubtotalMinor,
            listing.currency,
            listing.currencyExponent,
          )}{" "}
          for {availability.quantity} × {availability.dates} {listing.listingType.unitLabel}
          {availability.dates === 1 ? "" : "s"} (before service charge and VAT)
        </p>
      ) : null}
    </li>
  );
}

/** Reads the URL's filters, asks the API, renders form + results. Request-time (inside Suspense). */
export async function SearchResults({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = filtersFromSearchParams(await searchParams);
  const typesResult = await serverApi<{ data: ListingType[] }>("/listing-types");
  const types = typesResult.ok ? typesResult.data.data : [];
  const { query, problems } = toApiQuery(filters, currencyExponentOf(filters.currency ?? "NPR"));
  const result = await serverApi<{ data: ListingSummary[]; pagination: Pagination }>(
    `/listings${query.size ? `?${query.toString()}` : ""}`,
  );

  return (
    <div className="space-y-6">
      <SearchForm types={types} filters={filters} />
      {problems.length > 0 ? (
        <Alert tone="info">Some filters were ignored: {problems.join(" ")}</Alert>
      ) : null}
      {!result.ok ? (
        <Alert>
          {result.code === "UNKNOWN_LOCATION"
            ? "We don't know that place yet. Try a town or district name, such as pokhara or kaski."
            : result.status === 400
              ? "Some search filters are not valid. Check them and try again."
              : "Search is not available right now. Please try again shortly."}
        </Alert>
      ) : result.data.data.length === 0 ? (
        <Alert tone="info">
          Nothing matches these filters yet. Try other dates or a wider area.
        </Alert>
      ) : (
        <section aria-labelledby="results-heading">
          <h2 id="results-heading" className="mb-3 text-sm font-semibold text-slate-600">
            {result.data.pagination.total} result{result.data.pagination.total === 1 ? "" : "s"}
          </h2>
          <ul className="space-y-3">
            {result.data.data.map((listing) => (
              <ResultCard key={listing.id} listing={listing} filters={filters} />
            ))}
          </ul>
          {result.data.pagination.totalPages > 1 ? (
            <nav aria-label="Result pages" className="mt-6 flex items-center justify-between gap-3">
              {result.data.pagination.page > 1 ? (
                <Link
                  className={buttonSecondary}
                  href={searchPageHref(filters, result.data.pagination.page - 1)}
                >
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-slate-600">
                Page {result.data.pagination.page} of {result.data.pagination.totalPages}
              </span>
              {result.data.pagination.page < result.data.pagination.totalPages ? (
                <Link
                  className={buttonSecondary}
                  href={searchPageHref(filters, result.data.pagination.page + 1)}
                >
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </section>
      )}
    </div>
  );
}

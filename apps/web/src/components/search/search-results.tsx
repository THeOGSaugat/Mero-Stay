import Image from "next/image";
import Link from "next/link";
import type { ListingSummary, ListingType, Pagination } from "@/lib/api-types";
import { categoryById, categoryOfType, resolveCategories, searchTitle } from "@/lib/categories";
import {
  filtersFromSearchParams,
  searchPageHref,
  toApiQuery,
  type SearchFilters,
} from "@/lib/search";
import { serverApi } from "@/lib/server-api";
import { IconMap } from "../ui/icons";
import { Alert, buttonSecondary } from "../ui/primitives";
import { ListingCard } from "./listing-card";
import { ResultFilters, SearchForm } from "./search-form";

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

/** Reads the URL's filters, asks the API, renders form + results. Request-time (inside Suspense). */
export async function SearchResults({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const filters = filtersFromSearchParams(raw);
  const typesResult = await serverApi<{ data: ListingType[] }>("/listing-types");
  const types = typesResult.ok ? typesResult.data.data : [];
  // Header links say ?category=stays; resolve it to the category's first offered type.
  const resolved = resolveCategories(types);
  if (!filters.type && typeof raw.category === "string") {
    const wanted = categoryById(raw.category);
    const match = resolved.find((c) => c.id === wanted?.id);
    if (match) filters.type = match.types[0]!.code;
  }
  const currentType = types.find((t) => t.code === filters.type);
  const currentCategory = resolved.find((c) => c.types.some((t) => t.code === filters.type));
  const { query, problems } = toApiQuery(filters, currencyExponentOf(filters.currency ?? "NPR"));
  const result = await serverApi<{ data: ListingSummary[]; pagination: Pagination }>(
    `/listings${query.size ? `?${query.toString()}` : ""}`,
  );

  const heroImage = categoryOfType(currentType)?.image ?? "/images/pokhara-lake-boats.jpg";
  const total = result.ok ? result.data.pagination.total : 0;

  return (
    <div>
      <section className="relative isolate overflow-hidden bg-primary">
        <Image
          src={heroImage}
          alt=""
          fill
          preload
          sizes="100vw"
          className="-z-10 object-cover opacity-45"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-primary via-primary/80 to-primary/30" />
        <div className="mx-auto w-full max-w-6xl px-4 pt-10 pb-24 sm:px-6">
          <h1 className="font-display text-3xl font-bold text-white sm:text-4xl">
            {searchTitle(currentType, filters.location)}
          </h1>
          <p className="mt-2 text-white/90">Prices are per unit, before service charge and VAT.</p>
        </div>
      </section>
      <div className="relative z-10 mx-auto -mt-16 w-full max-w-6xl px-4 sm:px-6">
        <SearchForm types={types} filters={filters} />
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[16rem_1fr]">
        <aside aria-label="Filters" className="space-y-4">
          <div className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 text-sm text-muted">
            <IconMap className="size-6 shrink-0 text-primary" />
            <span>Map view is not available yet.</span>
          </div>
          <details className="rounded-card border border-line bg-white p-4 shadow-card" open>
            <summary className="cursor-pointer font-display text-lg font-semibold text-primary">
              Filter results
            </summary>
            <div className="mt-3">
              <ResultFilters filters={filters} />
            </div>
          </details>
          {problems.length > 0 ? (
            <Alert tone="info">Some filters were ignored: {problems.join(" ")}</Alert>
          ) : null}
        </aside>

        <div className="min-w-0">
          {currentCategory && currentCategory.types.length > 1 ? (
            <nav
              aria-label={`Kinds of ${currentCategory.label.toLowerCase()}`}
              className="mb-4 flex flex-wrap gap-2"
            >
              {currentCategory.types.map((t) => (
                <Link
                  key={t.code}
                  href={searchPageHref({ ...filters, type: t.code }, 1)}
                  aria-current={t.code === filters.type ? "page" : undefined}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    t.code === filters.type
                      ? "border-primary bg-primary text-white"
                      : "border-line text-primary hover:bg-surface"
                  }`}
                >
                  {t.name}
                </Link>
              ))}
            </nav>
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
              <h2 id="results-heading" className="mb-3 text-sm font-semibold text-muted">
                {total} result{total === 1 ? "" : "s"}
              </h2>
              <ul className="space-y-4">
                {result.data.data.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    href={listingHref(listing, filters)}
                  />
                ))}
              </ul>
              {result.data.pagination.totalPages > 1 ? (
                <nav
                  aria-label="Result pages"
                  className="mt-6 flex items-center justify-between gap-3"
                >
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
                  <span className="text-sm text-muted">
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
      </div>
    </div>
  );
}

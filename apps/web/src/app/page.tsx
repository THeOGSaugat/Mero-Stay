import { Suspense } from "react";
import { SearchForm } from "@/components/search/search-form";
import { SystemStatus, SystemStatusSkeleton } from "@/components/system-status";
import type { ListingType } from "@/lib/api-types";
import { serverApi } from "@/lib/server-api";

/** The search form needs the listing types (only active, bookable ones are offered). */
async function HomeSearch() {
  const types = await serverApi<{ data: ListingType[] }>("/listing-types");
  return <SearchForm types={types.ok ? types.data.data : []} compact />;
}

export default function HomePage() {
  return (
    <>
      <section className="bg-surface">
        <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold tracking-wide text-primary uppercase">
              Stays · Buses · Guides · Tours
            </p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-balance text-primary sm:text-5xl">
              Find your stay anywhere in Nepal
            </h1>
            <p className="mt-4 text-lg text-pretty text-ink">
              Hotels and homestays, bus seats and local guides, from Kathmandu to Pokhara and
              beyond: planned and booked as one trip.
            </p>
          </div>
          <div className="mt-8">
            <Suspense fallback={<p className="text-sm text-muted">Loading search…</p>}>
              <HomeSearch />
            </Suspense>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <section
          aria-labelledby="system-status-heading"
          className="max-w-md rounded-card border border-line p-5 shadow-card"
        >
          <h2 id="system-status-heading" className="text-base font-semibold text-primary">
            System status
          </h2>
          <Suspense fallback={<SystemStatusSkeleton />}>
            <SystemStatus />
          </Suspense>
        </section>
      </div>
    </>
  );
}

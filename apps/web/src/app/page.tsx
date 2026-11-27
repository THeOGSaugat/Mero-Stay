import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { ListingCard } from "@/components/search/listing-card";
import { SearchForm } from "@/components/search/search-form";
import { SystemStatus, SystemStatusSkeleton } from "@/components/system-status";
import { IconArrowRight, IconChat, IconPin, IconShield, IconTag } from "@/components/ui/icons";
import { SectionHeading } from "@/components/ui/primitives";
import type { ListingSummary, ListingType, Pagination } from "@/lib/api-types";
import { categoryHref, DESTINATIONS, resolveCategories } from "@/lib/categories";
import { serverApi } from "@/lib/server-api";

/** The search card needs the listing types (only active, bookable ones are offered). */
async function HomeSearch() {
  const types = await serverApi<{ data: ListingType[] }>("/listing-types");
  return <SearchForm types={types.ok ? types.data.data : []} />;
}

/**
 * Popular destinations: only places MeroStay knows, with the real number of listings there
 * (owner decision: no invented data). Unknown places and empty ones are left out.
 */
async function PopularDestinations() {
  const results = await Promise.all(
    DESTINATIONS.map(async (destination) => {
      const result = await serverApi<{ data: ListingSummary[]; pagination: Pagination }>(
        `/listings?location=${destination.slug}&pageSize=1`,
      );
      return { destination, total: result.ok ? result.data.pagination.total : 0 };
    }),
  );
  const known = results.filter((r) => r.total > 0);
  if (known.length === 0) return null;
  return (
    <section
      aria-labelledby="destinations-heading"
      className="mx-auto w-full max-w-6xl px-4 pt-12 sm:px-6"
    >
      <SectionHeading id="destinations-heading" title="Popular destinations" />
      <ul className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 lg:grid-cols-6">
        {known.map(({ destination, total }) => (
          <li key={destination.slug} className="w-40 shrink-0 snap-start sm:w-auto">
            <Link
              href={`/search?location=${destination.slug}`}
              className="group relative block aspect-[4/5] overflow-hidden rounded-card shadow-card"
            >
              <Image
                src={destination.image}
                alt=""
                fill
                sizes="(min-width: 1024px) 12rem, (min-width: 640px) 33vw, 10rem"
                className="object-cover transition-transform duration-300 group-hover:scale-105"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
              <span className="absolute right-3 bottom-3 left-3 text-white">
                <span className="flex items-center gap-1 font-semibold">
                  <IconPin className="size-4 text-accent" />
                  {destination.name}
                </span>
                <span className="text-xs text-white/85">{total} to book</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A few real listings per category, cheapest first; a category with none is left out. */
async function CategoryPicks() {
  const typesResult = await serverApi<{ data: ListingType[] }>("/listing-types");
  const sections = await Promise.all(
    resolveCategories(typesResult.ok ? typesResult.data.data : []).map(async (category) => {
      const result = await serverApi<{ data: ListingSummary[]; pagination: Pagination }>(
        `/listings?type=${category.types[0]!.code}&pageSize=3&sort=price_asc`,
      );
      return { category, listings: result.ok ? result.data.data : [] };
    }),
  );
  const shown = sections.filter((s) => s.listings.length > 0);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map(({ category, listings }) => (
        <section
          key={category.id}
          aria-labelledby={`picks-${category.id}`}
          className="mx-auto w-full max-w-6xl px-4 pt-12 sm:px-6"
        >
          <SectionHeading
            id={`picks-${category.id}`}
            title={`${category.label} to book now`}
            action={
              <Link
                href={categoryHref(category.id)}
                className="inline-flex items-center gap-1 text-sm font-semibold text-accent-strong hover:underline"
              >
                See all {category.label.toLowerCase()}
                <IconArrowRight className="size-4" />
              </Link>
            }
          />
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {listings.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                href={`/listings/${listing.id}`}
                layout="column"
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

const TRUST = [
  {
    icon: <IconTag className="size-6" />,
    title: "Prices from the provider",
    text: "What you see is what is booked",
  },
  {
    icon: <IconShield className="size-6" />,
    title: "Secure payment",
    text: "eSewa, Khalti or pay at the property",
  },
  {
    icon: <IconPin className="size-6" />,
    title: "Local businesses",
    text: "Verified Nepali providers",
  },
  {
    icon: <IconChat className="size-6" />,
    title: "One trip",
    text: "Stays, buses and guides together",
  },
];

export default function HomePage() {
  return (
    <>
      <section className="relative isolate overflow-hidden bg-primary">
        <Image
          src="/images/hero-himalaya-temple.jpg"
          alt=""
          fill
          preload
          sizes="100vw"
          className="-z-10 object-cover object-[70%_center]"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-primary/90 via-primary/55 to-transparent" />
        <div className="mx-auto w-full max-w-6xl px-4 pt-14 pb-28 sm:px-6 sm:pt-20 sm:pb-36">
          <div className="max-w-xl text-white">
            <p className="text-xs font-semibold tracking-[0.2em] text-accent uppercase">
              Explore · Experience · Stay
            </p>
            <h1 className="mt-3 font-display text-4xl leading-tight font-bold text-balance sm:text-6xl">
              Discover Nepal, your way
            </h1>
            <p className="mt-4 text-lg text-pretty text-white/90">
              Book hotels and homestays, bus seats, local guides and experiences, all in one trip.
            </p>
          </div>
        </div>
      </section>

      <div className="relative z-10 mx-auto -mt-20 w-full max-w-6xl px-4 sm:px-6">
        <Suspense
          fallback={
            <div className="h-40 rounded-card bg-white shadow-float" aria-label="Loading search" />
          }
        >
          <HomeSearch />
        </Suspense>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6">
        <ul className="grid gap-4 rounded-card border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
          {TRUST.map((item) => (
            <li key={item.title} className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                {item.icon}
              </span>
              <span>
                <span className="block text-sm font-semibold text-primary">{item.title}</span>
                <span className="block text-xs text-muted">{item.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Suspense fallback={null}>
        <PopularDestinations />
      </Suspense>
      <Suspense fallback={null}>
        <CategoryPicks />
      </Suspense>

      <div className="mx-auto w-full max-w-6xl px-4 pt-12 sm:px-6">
        <section
          aria-labelledby="system-status-heading"
          className="max-w-md rounded-card border border-line bg-white p-5 shadow-card"
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

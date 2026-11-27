import { CancellationTerms } from "@/components/ui/cancellation-terms";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ListingDetail as Detail } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { calendarWindow } from "@/lib/search";
import { serverApi } from "@/lib/server-api";
import { detailValueText, formatServiceDate, humanizeKey } from "@/lib/trip-display";
import { AddToTrip } from "../trip/add-to-trip";
import { IconPin } from "../ui/icons";
import { Alert } from "../ui/primitives";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Calendar window: the dates the person searched for, else the API's default (next 14 days). */
function calendarQuery(params: Record<string, string | string[] | undefined>): string {
  const window = calendarWindow(first(params.startDate), first(params.endDate));
  return window ? `?from=${window.from}&to=${window.to}` : "";
}

function DetailList({ title, values }: { title: string; values: Record<string, unknown> | null }) {
  const entries = Object.entries(values ?? {}).filter(([key]) => !key.endsWith("Id"));
  if (entries.length === 0) return null;
  return (
    <section
      aria-labelledby={`${title}-heading`}
      className="rounded-card border border-line bg-white p-5 shadow-card"
    >
      <h2 id={`${title}-heading`} className="font-display text-xl font-semibold text-primary">
        {title}
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key} className="flex justify-between gap-3 border-b border-line py-1 text-sm">
            <dt className="text-muted">{humanizeKey(key)}</dt>
            <dd className="text-right font-medium text-ink">{detailValueText(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Listing details, rendered on the server at request time (inside Suspense). */
export async function ListingDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const rawParams = await searchParams;
  const query = calendarQuery(rawParams);
  // Child listings (e.g. rooms of a hotel) keep the dates the person searched for.
  const keep = new URLSearchParams();
  for (const key of ["startDate", "endDate", "quantity"]) {
    const value = first(rawParams[key]);
    if (value) keep.set(key, value);
  }
  const childQuery = keep.size ? `?${keep.toString()}` : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await serverApi<{ data: Detail }>(`/listings/${id}${query}`);
  if (!result.ok && result.status === 404) notFound();
  if (!result.ok)
    return <Alert>This listing could not be loaded right now. Please try again shortly.</Alert>;
  const listing = result.data.data;
  const money = { currency: listing.currency, currencyExponent: listing.currencyExponent };

  // The supplied per-type photos are small (~200-400 px wide); the banner uses the one large,
  // neutral scenic photo instead so it is not stretched blurry. Still illustrative.
  const banner = {
    image: "/images/hero-himalaya-temple.jpg",
    imageAlt: "Illustrative photo: the Himalaya above a Nepali temple",
  };
  const bookable = listing.listingType.isBookable;

  return (
    <article>
      <div className="relative aspect-[16/7] overflow-hidden rounded-card bg-surface shadow-card sm:aspect-[16/5]">
        <Image
          src={banner.image}
          alt={banner.imageAlt}
          fill
          preload
          sizes="(min-width: 1152px) 72rem, 100vw"
          className="object-cover object-[60%_35%]"
        />
        <span className="absolute bottom-3 left-3 rounded bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
          Illustrative photo
        </span>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem] lg:gap-8">
        <header className="lg:col-start-1">
          <p className="text-xs font-semibold tracking-wide text-accent-strong uppercase">
            {listing.listingType.name}
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-primary sm:text-4xl">
            {listing.title}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-1 text-muted">
            <IconPin className="size-4 text-accent-strong" />
            {listing.parent ? (
              <>
                <Link href={`/listings/${listing.parent.id}`} className="underline">
                  {listing.parent.title}
                </Link>
                {" · "}
              </>
            ) : null}
            {listing.provider.name}
            {listing.location ? ` · ${listing.location.name}` : ""}
          </p>
          {listing.description ? <p className="mt-4 text-ink">{listing.description}</p> : null}
        </header>

        {bookable ? (
          <aside className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <div className="space-y-4 lg:sticky lg:top-6">
              <section
                aria-labelledby="book-heading"
                id="book"
                className="rounded-card border border-line bg-white p-5 shadow-card"
              >
                <p className="text-2xl font-bold text-primary">
                  {formatMoney(listing.basePriceMinor, listing.currency, listing.currencyExponent)}{" "}
                  <span className="text-sm font-normal text-muted">
                    per {listing.listingType.unitLabel}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Before service charge ({listing.serviceChargeRateBps / 100}%) and VAT (
                  {listing.taxRateBps / 100}%)
                </p>
                <h2
                  id="book-heading"
                  className="mt-4 mb-3 font-display text-lg font-semibold text-primary"
                >
                  Add to your trip
                </h2>
                <AddToTrip
                  listing={{
                    id: listing.id,
                    title: listing.title,
                    unitLabel: listing.listingType.unitLabel,
                    currency: listing.currency,
                  }}
                />
              </section>
            </div>
          </aside>
        ) : null}

        <div className="space-y-6 lg:col-start-1">
          <DetailList title="Details" values={listing.details} />
          <DetailList title="More information" values={listing.attributes} />

          {listing.children.length > 0 ? (
            <section aria-labelledby="children-heading">
              <h2 id="children-heading" className="font-display text-xl font-semibold text-primary">
                Rooms and options
              </h2>
              <ul className="mt-3 space-y-2">
                {listing.children.map((child) => (
                  <li
                    key={child.id}
                    className="flex items-center justify-between gap-3 rounded-card border border-line bg-white p-4 shadow-card"
                  >
                    <Link
                      href={`/listings/${child.id}${childQuery}`}
                      className="font-semibold text-primary underline"
                    >
                      {child.title}
                    </Link>
                    <span className="text-sm font-semibold text-primary">
                      {formatMoney(child.basePriceMinor, child.currency, child.currencyExponent)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {listing.calendar && bookable ? (
            <section aria-labelledby="calendar-heading">
              <h2 id="calendar-heading" className="font-display text-xl font-semibold text-primary">
                Availability and prices
              </h2>
              {listing.calendar.slots.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No dates are open in this period.</p>
              ) : (
                <div className="mt-3 overflow-x-auto rounded-card border border-line bg-white">
                  <table className="w-full min-w-72 text-left text-sm">
                    <thead className="bg-surface text-primary">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-semibold">
                          Date
                        </th>
                        <th scope="col" className="px-3 py-2 font-semibold">
                          Available
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">
                          Price per {listing.listingType.unitLabel}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {listing.calendar.slots.map((slot) => (
                        <tr key={slot.date} className="border-t border-line">
                          <td className="px-3 py-2">{formatServiceDate(slot.date)}</td>
                          <td className="px-3 py-2">
                            {slot.status === "OPEN" ? slot.available : "Closed"}
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {formatMoney(
                              slot.unitPriceMinor,
                              money.currency,
                              money.currencyExponent,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          <CancellationTerms terms={listing.cancellationPolicy} context="listing" />
        </div>
      </div>
    </article>
  );
}

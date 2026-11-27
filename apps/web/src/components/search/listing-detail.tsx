import { CancellationTerms } from "@/components/ui/cancellation-terms";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ListingDetail as Detail } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { calendarWindow } from "@/lib/search";
import { serverApi } from "@/lib/server-api";
import { detailValueText, formatServiceDate, humanizeKey } from "@/lib/trip-display";
import { AddToTrip } from "../trip/add-to-trip";
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
    <section aria-labelledby={`${title}-heading`} className="rounded-card border border-line p-4">
      <h2 id={`${title}-heading`} className="text-base font-semibold text-primary">
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

  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {listing.listingType.name}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-primary sm:text-3xl">
          {listing.title}
        </h1>
        <p className="mt-2 text-muted">
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
        {listing.listingType.isBookable ? (
          <p className="mt-3 text-lg font-bold text-primary">
            {formatMoney(listing.basePriceMinor, listing.currency, listing.currencyExponent)}{" "}
            <span className="text-sm font-normal text-muted">
              per {listing.listingType.unitLabel}, before service charge (
              {listing.serviceChargeRateBps / 100}%) and VAT ({listing.taxRateBps / 100}%)
            </span>
          </p>
        ) : null}
        {listing.description ? <p className="mt-3 text-ink">{listing.description}</p> : null}
      </header>

      <DetailList title="Details" values={listing.details} />
      <DetailList title="More information" values={listing.attributes} />

      {listing.children.length > 0 ? (
        <section aria-labelledby="children-heading">
          <h2 id="children-heading" className="text-base font-semibold text-primary">
            Rooms and options
          </h2>
          <ul className="mt-3 space-y-2">
            {listing.children.map((child) => (
              <li
                key={child.id}
                className="flex items-center justify-between gap-3 rounded-control border border-line p-3"
              >
                <Link
                  href={`/listings/${child.id}${childQuery}`}
                  className="font-medium text-primary underline"
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

      {listing.calendar && listing.listingType.isBookable ? (
        <section aria-labelledby="calendar-heading">
          <h2 id="calendar-heading" className="text-base font-semibold text-primary">
            Availability and prices
          </h2>
          {listing.calendar.slots.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No dates are open in this period.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-72 text-left text-sm">
                <thead className="bg-surface text-slate-700">
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
                    <tr key={slot.date} className="border-b border-line">
                      <td className="px-3 py-2">{formatServiceDate(slot.date)}</td>
                      <td className="px-3 py-2">
                        {slot.status === "OPEN" ? slot.available : "Closed"}
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        {formatMoney(slot.unitPriceMinor, money.currency, money.currencyExponent)}
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

      {listing.listingType.isBookable ? (
        <section
          aria-labelledby="book-heading"
          className="rounded-card border border-primary-light/40 bg-surface/60 p-4"
        >
          <h2 id="book-heading" className="mb-3 text-base font-semibold text-primary">
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
      ) : null}
    </article>
  );
}

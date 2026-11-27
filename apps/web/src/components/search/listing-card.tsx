import Image from "next/image";
import Link from "next/link";
import type { ListingSummary } from "@/lib/api-types";
import { illustrationFor } from "@/lib/categories";
import { formatMoney } from "@/lib/money";
import { IconPin } from "../ui/icons";
import { buttonAccent } from "../ui/primitives";

/**
 * A listing as a result card (Phase 13 design, mockups "Hotels in Pokhara" / "Bus Tickets").
 * Only real API data: no ratings, amenities or counts the API does not have (owner decision).
 * The photo is ILLUSTRATIVE (listings have no photos yet) and says so.
 */
export function ListingCard({
  listing,
  href,
  layout = "row",
}: {
  listing: ListingSummary;
  href: string;
  layout?: "row" | "column";
}) {
  const price = formatMoney(listing.basePriceMinor, listing.currency, listing.currencyExponent);
  const availability = listing.availability;
  const illustration = illustrationFor(listing.listingType);
  const titleId = `listing-title-${listing.id}`;
  const row = layout === "row";
  return (
    <li
      className={`overflow-hidden rounded-card border border-line bg-white shadow-card ${
        row ? "sm:flex" : "flex flex-col"
      }`}
    >
      <div
        className={`relative shrink-0 bg-surface ${row ? "aspect-[16/9] sm:aspect-auto sm:w-56" : "aspect-[16/9]"}`}
      >
        <Image
          src={illustration.image}
          alt={illustration.imageAlt}
          fill
          sizes={
            row
              ? "(min-width: 640px) 14rem, 100vw"
              : "(min-width: 1024px) 22rem, (min-width: 640px) 50vw, 100vw"
          }
          className="object-cover"
        />
        <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[0.65rem] font-medium text-white">
          Illustrative photo
        </span>
      </div>
      <div
        className={`flex min-w-0 flex-1 flex-col gap-3 p-4 ${row ? "sm:flex-row sm:justify-between" : ""}`}
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-accent-strong uppercase">
            {listing.listingType.name}
          </p>
          <h2 id={titleId} className="mt-1 font-display text-lg font-semibold text-primary">
            <Link href={href} className="hover:underline">
              {listing.title}
            </Link>
          </h2>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted">
            <IconPin className="size-4 shrink-0 text-accent-strong" />
            <span>
              {listing.parent ? `${listing.parent.title} · ` : ""}
              {listing.provider.name}
              {listing.location ? ` · ${listing.location.name}` : ""}
            </span>
          </p>
          {availability ? (
            <p className="mt-3 rounded-control bg-primary-soft px-3 py-2 text-sm text-primary-dark">
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
        </div>
        <div
          className={`flex shrink-0 items-end justify-between gap-3 ${row ? "sm:flex-col sm:items-end sm:text-right" : ""}`}
        >
          <div>
            <p className="text-lg font-bold text-primary" data-testid="listing-price">
              {price}
            </p>
            <p className="text-xs text-muted">per {listing.listingType.unitLabel}, before taxes</p>
          </div>
          <Link href={href} className={`${buttonAccent} min-h-10 px-4`} aria-describedby={titleId}>
            Book now
          </Link>
        </div>
      </div>
    </li>
  );
}

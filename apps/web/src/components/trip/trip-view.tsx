import { CancellationTerms } from "@/components/ui/cancellation-terms";
import { policySummary } from "@/lib/cancellation-policy";
import type { ReactNode } from "react";
import type { Trip, TripItem } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { itemStartLabel } from "@/lib/refunds-display";
import {
  formatDateRange,
  formatServiceDate,
  paymentMethodLabel,
  paymentStatusLabel,
  statusLabel,
  totalsRows,
} from "@/lib/trip-display";
import { StatusPill, statusTone } from "../ui/primitives";

/**
 * A trip as the customer sees it: items, per-date lines, money and statuses, all formatted from
 * the API's strings. No commission or payout data exists in this view (the API never sends it).
 */

function ItemCard({ item, actions }: { item: TripItem; actions?: ReactNode }) {
  const f = (minor: string) => formatMoney(minor, item.currency, item.currencyExponent);
  return (
    <li
      className="rounded-card border border-line bg-white p-4 shadow-card"
      data-testid="trip-item"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {item.listing.listingType.replace(/_/g, " ")}
          </p>
          <h3 className="mt-1 font-semibold text-primary">{item.listing.title}</h3>
          <p className="text-sm text-muted">
            {item.listing.provider.name} · {formatDateRange(item.startDate, item.endDate)} ·{" "}
            {item.quantity} per date
          </p>
          {item.serviceStartsAtNepal ? (
            <p className="text-sm text-muted" data-testid="item-starts">
              {itemStartLabel(item)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill label={statusLabel(item.status)} tone={statusTone(item.status)} />
          <StatusPill
            label={paymentStatusLabel(item.paymentStatus)}
            tone={statusTone(item.paymentStatus)}
          />
        </div>
      </div>
      <p className="mt-2 text-sm text-ink">{paymentMethodLabel(item.paymentMethod)}</p>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-primary">Price per date</summary>
        <ul className="mt-2 space-y-1">
          {item.lines.map((line) => (
            <li key={line.date} className="flex justify-between gap-3">
              <span>
                {formatServiceDate(line.date)} · {line.units} × {f(line.unitPriceMinor)}
              </span>
              <span className="font-medium">{f(line.amountMinor)}</span>
            </li>
          ))}
        </ul>
      </details>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-muted">Subtotal</dt>
        <dd className="text-right sm:text-left">{f(item.money.subtotalMinor)}</dd>
        <dt className="text-muted">Service charge</dt>
        <dd className="text-right sm:text-left">{f(item.money.serviceChargeMinor)}</dd>
        <dt className="text-muted">VAT</dt>
        <dd className="text-right sm:text-left">{f(item.money.taxMinor)}</dd>
        <dt className="font-semibold text-primary">Total</dt>
        <dd className="text-right font-semibold text-primary sm:text-left" data-testid="item-total">
          {f(item.money.totalMinor)}
        </dd>
      </dl>
      <details className="mt-2 text-sm" data-testid="item-cancellation">
        <summary className="cursor-pointer text-primary">
          {item.cancellationPolicy
            ? `Cancellation: ${policySummary(item.cancellationPolicy)} (fixed when booked)`
            : "No cancellation policy"}
        </summary>
        <div className="mt-2">
          <CancellationTerms terms={item.cancellationPolicy} context="booking" headingLevel={3} />
        </div>
      </details>
      {actions ? <div className="mt-3 border-t border-line pt-3">{actions}</div> : null}
    </li>
  );
}

export function TripTotals({ trip }: { trip: Trip }) {
  return (
    <dl
      className="rounded-card border border-line bg-surface/50 p-4 text-sm"
      data-testid="trip-totals"
    >
      {totalsRows(trip.totals, trip).map((row) => (
        <div key={row.label} className="flex justify-between gap-3 py-1">
          <dt className={row.emphasis ? "font-semibold text-primary" : "text-slate-700"}>
            {row.label}
          </dt>
          <dd className={row.emphasis ? "font-bold text-primary" : "font-medium"}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TripView({
  trip,
  itemActions,
}: {
  trip: Trip;
  itemActions?: (item: TripItem) => ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted">
          Reference <span className="font-semibold text-ink">{trip.reference}</span>
        </p>
        <StatusPill label={statusLabel(trip.status)} tone={statusTone(trip.status)} />
      </div>
      {trip.items.length === 0 ? (
        <p className="text-sm text-muted">No items yet.</p>
      ) : (
        <ul className="space-y-3">
          {trip.items.map((item) => (
            <ItemCard key={item.id} item={item} actions={itemActions?.(item)} />
          ))}
        </ul>
      )}
      <TripTotals trip={trip} />
    </div>
  );
}

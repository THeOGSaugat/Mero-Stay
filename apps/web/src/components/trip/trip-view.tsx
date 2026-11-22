import type { ReactNode } from "react";
import type { Trip, TripItem } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import {
  describeCancellationRule,
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
    <li className="rounded-xl border border-mist bg-white p-4 shadow-sm" data-testid="trip-item">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
            {item.listing.listingType.replace(/_/g, " ")}
          </p>
          <h3 className="mt-1 font-semibold text-navy">{item.listing.title}</h3>
          <p className="text-sm text-slate-600">
            {item.listing.provider.name} · {formatDateRange(item.startDate, item.endDate)} ·{" "}
            {item.quantity} per date
          </p>
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
        <summary className="cursor-pointer text-navy">Price per date</summary>
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
        <dt className="text-slate-600">Subtotal</dt>
        <dd className="text-right sm:text-left">{f(item.money.subtotalMinor)}</dd>
        <dt className="text-slate-600">Service charge</dt>
        <dd className="text-right sm:text-left">{f(item.money.serviceChargeMinor)}</dd>
        <dt className="text-slate-600">VAT</dt>
        <dd className="text-right sm:text-left">{f(item.money.taxMinor)}</dd>
        <dt className="font-semibold text-navy">Total</dt>
        <dd className="text-right font-semibold text-navy sm:text-left" data-testid="item-total">
          {f(item.money.totalMinor)}
        </dd>
      </dl>
      {item.cancellationPolicy?.rules && item.cancellationPolicy.rules.length > 0 ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-navy">
            Cancellation policy
            {item.cancellationPolicy.name ? `: ${item.cancellationPolicy.name}` : ""} (fixed when
            booked)
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {item.cancellationPolicy.rules.map((rule, i) => (
              <li key={i}>{describeCancellationRule(rule)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {actions ? <div className="mt-3 border-t border-mist pt-3">{actions}</div> : null}
    </li>
  );
}

export function TripTotals({ trip }: { trip: Trip }) {
  return (
    <dl className="rounded-xl border border-mist bg-mist/50 p-4 text-sm" data-testid="trip-totals">
      {totalsRows(trip.totals, trip).map((row) => (
        <div key={row.label} className="flex justify-between gap-3 py-1">
          <dt className={row.emphasis ? "font-semibold text-navy" : "text-slate-700"}>
            {row.label}
          </dt>
          <dd className={row.emphasis ? "font-bold text-navy" : "font-medium"}>{row.value}</dd>
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
        <p className="text-sm text-slate-600">
          Reference <span className="font-semibold text-ink">{trip.reference}</span>
        </p>
        <StatusPill label={statusLabel(trip.status)} tone={statusTone(trip.status)} />
      </div>
      {trip.items.length === 0 ? (
        <p className="text-sm text-slate-600">No items yet.</p>
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

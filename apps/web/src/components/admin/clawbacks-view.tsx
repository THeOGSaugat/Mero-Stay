"use client";

import { formatMoney } from "@/lib/money";
import { formatTimestamp } from "@/lib/partner-display";
import { clawbackSettled, type Clawback } from "@/lib/refunds-display";
import { Panel } from "../ui/data";
import { StatusPill } from "../ui/primitives";

/**
 * Clawbacks of paid-out bookings that were voided (gap 39, ADR 0020): what each provider owes
 * back, deducted from their next payouts (never below zero). Shared by the admin console (all
 * providers) and the partner dashboard (own only). Past payouts are never edited.
 */
export function ClawbackList({
  rows,
  showProvider,
  emptyText,
}: {
  rows: Clawback[];
  showProvider: boolean;
  emptyText: string;
}) {
  return (
    <Panel title="Clawbacks">
      {rows.length === 0 ? <p className="text-sm text-muted">{emptyText}</p> : null}
      <ul className="space-y-2">
        {rows.map((row) => {
          const f = (minor: string) => formatMoney(minor, row.currency, row.currencyExponent);
          const settled = clawbackSettled(row);
          return (
            <li
              key={row.id}
              className="rounded-control border border-line p-3 text-sm"
              data-testid="clawback"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium text-ink">
                  {showProvider ? `${row.provider.name} · ` : ""}
                  {row.bookingItem.title} · trip {row.bookingItem.tripReference}
                </p>
                <StatusPill
                  label={settled ? "Recovered" : "Being deducted"}
                  tone={settled ? "good" : "wait"}
                />
              </div>
              <p className="text-muted">
                {row.reason} · {formatTimestamp(row.createdAt)}
              </p>
              <p className="mt-1">
                Owed {f(row.amountMinor)} · recovered {f(row.recoveredMinor)} ·{" "}
                <strong data-testid="clawback-outstanding">
                  still owed {f(row.outstandingMinor)}
                </strong>
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

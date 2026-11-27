"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest, describeApiError } from "@/lib/api-client";
import type { Quote, Trip, TripItem } from "@/lib/api-types";
import { quoteRows, totalsRows } from "@/lib/trip-display";
import { findDraftTrip } from "@/lib/trips-client";
import { useAuth } from "../auth/auth-provider";
import { Alert, buttonPrimary, buttonSecondary, inputClass, labelClass } from "../ui/primitives";
import { TripView } from "./trip-view";

/**
 * The customer's draft trip: edit or remove items, get a quote, confirm. Every amount on this
 * page comes from the API (the quote is the API's dry run; nothing is computed here).
 */
export function TripBuilder() {
  const { state } = useAuth();
  const router = useRouter();
  const csrfToken = state.status === "authenticated" ? state.csrfToken : null;
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    findDraftTrip()
      .then((draft) => {
        if (!cancelled) setTrip(draft);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(describeApiError(err));
        setTrip(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  if (trip === undefined) return <p className="text-sm text-muted">Loading your trip…</p>;
  if (trip === null) {
    return (
      <div className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <Alert tone="info">
          Your trip is empty. Find a stay, a bus or a guide and choose &ldquo;Add to trip&rdquo;.
        </Alert>
        <Link href="/search" className={buttonPrimary}>
          Start searching
        </Link>
      </div>
    );
  }
  const current = trip;

  const updateItem = (item: TripItem) => async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      const body: Record<string, unknown> = {
        quantity: Number.parseInt(String(form.get("quantity") ?? item.quantity), 10),
        startDate: String(form.get("startDate") ?? item.startDate),
      };
      if (item.endDate) body.endDate = String(form.get("endDate") ?? item.endDate);
      const res = await apiRequest<{ data: Trip }>(`/trips/${current.id}/items/${item.id}`, {
        method: "PATCH",
        body,
        csrfToken,
      });
      setTrip(res.data);
      setQuote(null);
    });
  };

  const removeItem = (item: TripItem) => () =>
    run(async () => {
      const res = await apiRequest<{ data: Trip }>(`/trips/${current.id}/items/${item.id}`, {
        method: "DELETE",
        csrfToken,
      });
      setTrip(res.data);
      setQuote(null);
    });

  const getQuote = () =>
    run(async () => {
      const res = await apiRequest<{ data: Quote }>(`/trips/${current.id}/quote`, {
        method: "POST",
        body: {},
        csrfToken,
      });
      setQuote(res.data);
    });

  const confirm = () =>
    run(async () => {
      await apiRequest<{ data: Trip }>(`/trips/${current.id}/confirm`, {
        method: "POST",
        csrfToken,
      });
      router.push(`/trips/${current.id}?confirmed=1`);
    });

  return (
    <div className="space-y-6">
      {error ? <Alert>{error}</Alert> : null}
      <TripView
        trip={current}
        itemActions={(item) => (
          <form
            onSubmit={updateItem(item)}
            className="flex flex-wrap items-end gap-3"
            aria-label={`Change ${item.listing.title}`}
          >
            <div>
              <label className={labelClass} htmlFor={`start-${item.id}`}>
                {item.endDate ? "From" : "Date"}
              </label>
              <input
                id={`start-${item.id}`}
                name="startDate"
                type="date"
                defaultValue={item.startDate}
                className={inputClass}
              />
            </div>
            {item.endDate ? (
              <div>
                <label className={labelClass} htmlFor={`end-${item.id}`}>
                  Until
                </label>
                <input
                  id={`end-${item.id}`}
                  name="endDate"
                  type="date"
                  defaultValue={item.endDate}
                  className={inputClass}
                />
              </div>
            ) : null}
            <div className="w-24">
              <label className={labelClass} htmlFor={`qty-${item.id}`}>
                Quantity
              </label>
              <input
                id={`qty-${item.id}`}
                name="quantity"
                type="number"
                min={1}
                max={50}
                defaultValue={item.quantity}
                className={inputClass}
              />
            </div>
            <button type="submit" disabled={busy} className={buttonSecondary}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={removeItem(item)}
              className={buttonSecondary}
            >
              Remove
            </button>
          </form>
        )}
      />

      {current.items.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={getQuote} disabled={busy} className={buttonSecondary}>
            Get quote
          </button>
          <button type="button" onClick={confirm} disabled={busy} className={buttonPrimary}>
            Confirm trip
          </button>
        </div>
      ) : null}

      {quote ? (
        <section aria-labelledby="quote-heading" className="space-y-3">
          <h2 id="quote-heading" className="text-lg font-semibold text-primary">
            Quote (today&rsquo;s prices, nothing booked yet)
          </h2>
          {!quote.allAvailable ? (
            <Alert>
              Some items are no longer available for their dates. Change or remove them.
            </Alert>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm" data-testid="quote-table">
              <thead className="bg-surface text-slate-700">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Item
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Subtotal
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Service charge
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    VAT
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {quoteRows(quote).map((row) => (
                  <tr key={row.key} className="border-b border-line align-top">
                    <td className="px-3 py-2">
                      <span className="font-medium text-ink">{row.title}</span>
                      <br />
                      <span className="text-muted">
                        {row.dates} · {row.quantity} per date · {row.payment}
                      </span>
                      {!row.available ? (
                        <span className="block text-red-800">
                          Not available: {row.unavailableDates.join(", ")}
                        </span>
                      ) : null}
                      {row.heldTotal ? (
                        <span className="block text-amber-900">
                          Price changed since you added it (was {row.heldTotal}).
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{row.subtotal}</td>
                    <td className="px-3 py-2 text-right">{row.serviceCharge}</td>
                    <td className="px-3 py-2 text-right">{row.tax}</td>
                    <td className="px-3 py-2 text-right font-semibold">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="rounded-card border border-line p-4 text-sm" data-testid="quote-totals">
            {totalsRows(quote.totals, quote).map((row) => (
              <div key={row.label} className="flex justify-between gap-3 py-1">
                <dt className={row.emphasis ? "font-semibold text-primary" : "text-slate-700"}>
                  {row.label}
                </dt>
                <dd className={row.emphasis ? "font-bold text-primary" : "font-medium"}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

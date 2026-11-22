"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiRequest, ApiError, describeApiError } from "@/lib/api-client";
import type { Pagination, Trip, TripListEntry } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { confirmOutcome, formatDateRange, statusLabel } from "@/lib/trip-display";
import { Alert, buttonSecondary, StatusPill, statusTone } from "../ui/primitives";
import { TripView } from "./trip-view";

/** The customer's trips (GET /trips: owner-scoped by the API), newest first. */
export function TripList() {
  const search = useSearchParams();
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const [result, setResult] = useState<{ data: TripListEntry[]; pagination: Pagination } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: TripListEntry[]; pagination: Pagination }>(`/trips?page=${page}&pageSize=20`)
      .then((body) => !cancelled && setResult(body))
      .catch((err: unknown) => !cancelled && setError(describeApiError(err)));
    return () => {
      cancelled = true;
    };
  }, [page]);

  if (error) return <Alert>{error}</Alert>;
  if (!result) return <p className="text-sm text-slate-600">Loading your trips…</p>;
  if (result.data.length === 0) return <Alert tone="info">You have no trips yet.</Alert>;

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {result.data.map((trip) => (
          <li key={trip.id} className="rounded-xl border border-mist bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Link
                  href={`/trips/${trip.id}`}
                  className="font-semibold text-navy hover:underline"
                >
                  Trip {trip.reference}
                </Link>
                <p className="mt-1 text-sm text-slate-600">
                  {trip.items.length === 0
                    ? "No items"
                    : trip.items
                        .map((i) => `${i.title} (${formatDateRange(i.startDate, i.endDate)})`)
                        .join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <StatusPill label={statusLabel(trip.status)} tone={statusTone(trip.status)} />
                <p className="mt-1 font-semibold text-navy">
                  {formatMoney(trip.totals.totalMinor, trip.currency, trip.currencyExponent)}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {result.pagination.totalPages > 1 ? (
        <nav aria-label="Trip pages" className="flex items-center justify-between">
          {page > 1 ? (
            <Link className={buttonSecondary} href={`/trips?page=${page - 1}`}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-slate-600">
            Page {result.pagination.page} of {result.pagination.totalPages}
          </span>
          {page < result.pagination.totalPages ? (
            <Link className={buttonSecondary} href={`/trips?page=${page + 1}`}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * One trip. The API answers 404 for a trip that does not exist AND for someone else's trip, so
 * this page never knows (or shows) whether another customer's trip exists.
 */
export function TripDetail() {
  const params = useParams<{ id: string }>();
  const confirmed = useSearchParams().get("confirmed") === "1";
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: Trip }>(`/trips/${encodeURIComponent(params.id)}`)
      .then((body) => !cancelled && setTrip(body.data))
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404 ? "Trip not found." : describeApiError(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="space-y-4">
        <Alert>{error}</Alert>
        <Link href="/trips" className={buttonSecondary}>
          Back to your trips
        </Link>
      </div>
    );
  }
  if (!trip) return <p className="text-sm text-slate-600">Loading trip…</p>;
  return (
    <div className="space-y-4">
      {confirmed ? <Alert tone="success">{confirmOutcome(trip)}</Alert> : null}
      <TripView trip={trip} />
      {trip.status === "PENDING" ? (
        <Alert tone="info">
          Online payment opens in a later release. Items paid at the property are already confirmed.
        </Alert>
      ) : null}
    </div>
  );
}

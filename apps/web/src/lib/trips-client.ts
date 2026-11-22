import { apiRequest } from "./api-client";
import type { Trip, TripListEntry } from "./api-types";

/**
 * The customer's current draft trip (the "basket"). Found through GET /trips?status=DRAFT, the
 * owner-scoped list: the API decides whose trips exist. A draft whose hold has passed is treated
 * as gone (the hold-release job will expire it); a new draft is started instead.
 */

export function isExpired(trip: { expiresAt: string | null }, now: Date = new Date()): boolean {
  return trip.expiresAt !== null && new Date(trip.expiresAt).getTime() <= now.getTime();
}

export async function findDraftTrip(): Promise<Trip | null> {
  const list = await apiRequest<{ data: TripListEntry[] }>("/trips?status=DRAFT&pageSize=5");
  const live = list.data.find((trip) => !isExpired(trip));
  if (!live) return null;
  const full = await apiRequest<{ data: Trip }>(`/trips/${live.id}`);
  return full.data;
}

/** The current draft, or a new one in `currency`. */
export async function ensureDraftTrip(currency: string, csrfToken: string): Promise<Trip> {
  const existing = await findDraftTrip();
  if (existing) return existing;
  const created = await apiRequest<{ data: Trip }>("/trips", {
    method: "POST",
    body: { currency },
    csrfToken,
  });
  return created.data;
}

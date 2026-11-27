"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiRequest, describeApiError } from "@/lib/api-client";
import type { PaymentMethod, Trip } from "@/lib/api-types";
import { loginHref } from "@/lib/auth-state";
import { usesDateRange } from "@/lib/search";
import { ensureDraftTrip } from "@/lib/trips-client";
import { useAuth } from "../auth/auth-provider";
import { Alert, buttonPrimary, inputClass, labelClass } from "../ui/primitives";

export interface AddToTripListing {
  id: string;
  title: string;
  unitLabel: string;
  currency: string;
}

/**
 * "Add to trip". Logged-out visitors are sent to log in and brought back to this page. The API
 * prices the item and reserves inventory; this form never sends money.
 */
export function AddToTrip({ listing }: { listing: AddToTripListing }) {
  const { state } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams();
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const range = usesDateRange(listing.unitLabel);

  if (state.status === "loading") return <p className="text-sm text-muted">Loading…</p>;
  if (state.status === "anonymous") {
    const query = search.toString();
    return (
      <Link href={loginHref(query ? `${pathname}?${query}` : pathname)} className={buttonPrimary}>
        Log in to add to your trip
      </Link>
    );
  }
  const csrfToken = state.csrfToken;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const startDate = String(form.get("startDate") ?? "");
    const endDate = String(form.get("endDate") ?? "");
    setBusy(true);
    setMessage(null);
    try {
      const trip = await ensureDraftTrip(listing.currency, csrfToken);
      await apiRequest<{ data: Trip }>(`/trips/${trip.id}/items`, {
        method: "POST",
        csrfToken,
        body: {
          listingId: listing.id,
          startDate,
          ...(range && endDate ? { endDate } : {}),
          quantity: Number.parseInt(String(form.get("quantity") ?? "1"), 10),
          paymentMethod: String(form.get("paymentMethod") ?? "online") as PaymentMethod,
        },
      });
      setMessage({ tone: "success", text: `${listing.title} was added to your trip.` });
    } catch (err) {
      setMessage({ tone: "error", text: describeApiError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Add to trip">
      {message ? (
        <Alert tone={message.tone}>
          {message.text}{" "}
          {message.tone === "success" ? (
            <Link href="/trip" className="font-semibold underline">
              View your trip
            </Link>
          ) : null}
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="add-start" className={labelClass}>
            {range ? "From" : "Date"}
          </label>
          <input
            id="add-start"
            name="startDate"
            type="date"
            required
            defaultValue={search.get("startDate") ?? ""}
            className={inputClass}
          />
        </div>
        {range ? (
          <div>
            <label htmlFor="add-end" className={labelClass}>
              Until <span className="font-normal text-slate-500">(not included)</span>
            </label>
            <input
              id="add-end"
              name="endDate"
              type="date"
              required
              defaultValue={search.get("endDate") ?? ""}
              className={inputClass}
            />
          </div>
        ) : null}
        <div>
          <label htmlFor="add-quantity" className={labelClass}>
            Quantity ({listing.unitLabel}s per date)
          </label>
          <input
            id="add-quantity"
            name="quantity"
            type="number"
            min={1}
            max={50}
            required
            defaultValue={search.get("quantity") ?? "1"}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="add-payment" className={labelClass}>
            Payment
          </label>
          <select
            id="add-payment"
            name="paymentMethod"
            defaultValue="online"
            className={inputClass}
          >
            <option value="online">Pay online</option>
            <option value="pay_at_property">Pay at the property</option>
          </select>
        </div>
      </div>
      <button type="submit" disabled={busy} className={buttonPrimary}>
        {busy ? "Adding…" : "Add to trip"}
      </button>
    </form>
  );
}

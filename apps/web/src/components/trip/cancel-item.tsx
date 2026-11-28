"use client";

import { useState } from "react";
import { apiRequest, ApiError, describeApiError } from "@/lib/api-client";
import type { Trip, TripItem } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { cancellationSummary, percentOfBps, type CancellationPreview } from "@/lib/refunds-display";
import { useAuth } from "../auth/auth-provider";
import { Alert, buttonPrimary, buttonSecondary } from "../ui/primitives";

/**
 * Cancelling one confirmed booking (Phase 14, ADR 0020). The customer first sees what cancelling
 * NOW gives back (the API computes it from the policy frozen on the booking and the exact start
 * time); confirming sends that amount back, and the API refuses if it changed meanwhile (a tier
 * boundary passed), so the customer never gets a different refund from the one shown.
 */
export function CancelItem({
  trip,
  item,
  onCancelled,
}: {
  trip: Trip;
  item: TripItem;
  onCancelled: (trip: Trip) => void;
}) {
  const { state } = useAuth();
  const csrfToken = state.status === "authenticated" ? state.csrfToken : null;
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/trips/${encodeURIComponent(trip.id)}/items/${encodeURIComponent(item.id)}`;

  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      const body = await apiRequest<{ data: CancellationPreview }>(`${base}/cancellation`);
      setPreview(body.data);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await apiRequest<{ data: Trip }>(`${base}/cancel`, {
        method: "POST",
        body: { expectedRefundMinor: preview.refundMinor },
        csrfToken,
      });
      onCancelled(body.data);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CANCELLATION_TERMS_CHANGED") {
        setNotice("The refund for cancelling now has changed. Please check it again.");
        await loadPreview();
        return;
      }
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => void loadPreview()}
          disabled={busy}
          data-testid="cancel-item-start"
        >
          Cancel this booking…
        </button>
        {error ? <Alert>{error}</Alert> : null}
      </div>
    );
  }

  const summary = cancellationSummary(preview);
  const refund = formatMoney(preview.refundMinor, preview.currency, preview.currencyExponent);
  return (
    <section
      aria-label={`Cancel ${item.listing.title}`}
      className="space-y-2 rounded-control border border-line bg-surface p-3 text-sm"
      data-testid="cancel-item"
    >
      <p className="font-semibold text-primary">Cancel this booking?</p>
      <p>{summary.startLine}</p>
      {summary.startNote ? <p className="text-muted">{summary.startNote}</p> : null}
      <p>{summary.policyLine}</p>
      <p className="font-semibold text-primary" data-testid="cancel-item-refund">
        {summary.refundLine}
      </p>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {preview.cancellable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => void confirm()}
            disabled={busy}
            data-testid="cancel-item-confirm"
          >
            {preview.refundMinor === "0"
              ? "Cancel without refund"
              : `Cancel and get ${refund} back`}
          </button>
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => setPreview(null)}
            disabled={busy}
          >
            Keep the booking
          </button>
        </div>
      ) : (
        <Alert tone="info">{preview.refusal?.message ?? "This booking cannot be cancelled."}</Alert>
      )}
    </section>
  );
}

/** What a cancelled booking shows: the tier that applied and what goes back. */
export function CancelledNote({ item }: { item: TripItem }) {
  if (!item.cancellation) return null;
  const refund = formatMoney(item.cancellation.refundMinor, item.currency, item.currencyExponent);
  return (
    <p className="text-sm text-ink" data-testid="item-cancelled-note">
      You cancelled this booking
      {item.cancellation.refundMinor === "0"
        ? ": no refund."
        : `: ${refund} (${percentOfBps(item.cancellation.refundBps)}) is being refunded to how you paid.`}
    </p>
  );
}

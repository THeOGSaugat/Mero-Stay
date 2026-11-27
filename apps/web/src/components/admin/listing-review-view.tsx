"use client";

import { useState } from "react";
import { describeAdminError } from "@/lib/admin-access";
import { typeRuleText, type ReviewListing } from "@/lib/admin-ops";
import { formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

/**
 * The listing review queue (Phase 12, gap 15, ADR 0018). Approving re-checks, on the server, that
 * the listing's type is allowed for the provider's kind of business (ADR 0013); the hint shown
 * here is only a preview of that rule. A rejection needs a reason the partner will see.
 */
export function ListingReviewQueue() {
  const { data, error, reload } = useAdminData<Paged<ReviewListing>>(
    "/listings?status=PENDING_REVIEW&pageSize=50",
  );
  if (error) return <AdminError view={error} />;
  if (!data) return <p className="text-sm text-muted">Loading listings to review…</p>;
  if (data.data.length === 0) return <Alert tone="info">No listings are waiting for review.</Alert>;
  return (
    <ul className="space-y-3">
      {data.data.map((listing) => (
        <ReviewCard key={listing.id} listing={listing} onDecided={reload} />
      ))}
    </ul>
  );
}

function ReviewCard({ listing, onDecided }: { listing: ReviewListing; onDecided: () => void }) {
  const request = useAdminRequest();
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setProblem(null);
    try {
      await request(`/listings/${listing.id}/${decision}`, {
        method: "POST",
        body: decision === "reject" ? { reason: reason.trim() } : {},
      });
      onDecided();
    } catch (err) {
      setProblem(describeAdminError(err));
      setBusy(false);
    }
  }

  return (
    <li
      className="rounded-card border border-line bg-white p-4 shadow-card"
      data-testid="review-listing"
      data-listing={listing.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-primary">{listing.title}</h2>
          <p className="text-sm text-muted">
            {listing.listingType.code.replace(/_/g, " ")} · {listing.provider.name} (
            {listing.provider.providerType.replace(/_/g, " ")}) ·{" "}
            {listing.location?.name ?? "no location"} · submitted{" "}
            {formatTimestamp(listing.submittedAt)}
          </p>
        </div>
        <StatusPill
          label={listing.typeRule.allowed ? "Type allowed" : "Type not allowed"}
          tone={listing.typeRule.allowed ? "good" : "bad"}
        />
      </div>
      <p className="mt-2 text-sm text-ink" data-testid="review-type-rule">
        {typeRuleText(listing.typeRule)}
      </p>
      {problem ? (
        <div className="mt-2">
          <Alert>{problem}</Alert>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <button
          type="button"
          className={buttonPrimary}
          disabled={busy}
          onClick={() => void decide("approve")}
        >
          Approve
        </button>
        {rejecting ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void decide("reject");
            }}
          >
            <label className={labelClass}>
              Reason (the partner sees it)
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
                required
                className={inputClass}
              />
            </label>
            <button type="submit" className={buttonSecondary} disabled={busy}>
              Reject listing
            </button>
          </form>
        ) : (
          <button type="button" className={buttonSecondary} onClick={() => setRejecting(true)}>
            Reject…
          </button>
        )}
      </div>
    </li>
  );
}

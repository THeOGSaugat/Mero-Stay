"use client";

import { useState } from "react";
import { describeAdminError } from "@/lib/admin-access";
import { formatMoney } from "@/lib/money";
import { formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import { settlementKindLabel, type SettlementEntry } from "@/lib/refunds-display";
import { formatDateRange } from "@/lib/trip-display";
import { Alert, buttonSecondary, inputClass, labelClass, StatusPill } from "../ui/primitives";
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

/**
 * Pay-at-property settlement reconciliation (gap 36, ADR 0020): where what a partner recorded
 * (paid at the property, and when) disagrees with what the commission invoices expect. Nothing here
 * moves money: an admin looks into each one (undo a settlement or void a booking with the existing
 * tools if needed) and records what was done.
 */
export function SettlementReconciliation() {
  const [state, setState] = useState<"open" | "resolved">("open");
  const { data, error, reload } = useAdminData<Paged<SettlementEntry>>(
    `/settlement-reconciliation?state=${state}&pageSize=50`,
  );
  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="group" aria-label="Show">
        {(["open", "resolved"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`rounded-full border px-3 py-1 text-sm ${state === s ? "border-primary bg-primary text-white" : "border-line text-primary"}`}
            aria-pressed={state === s}
            onClick={() => setState(s)}
          >
            {s === "open" ? "To look into" : "Handled"}
          </button>
        ))}
      </div>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-muted">Loading settlements…</p> : null}
      {data && data.data.length === 0 ? (
        <Alert tone="info">
          {state === "open" ? "No settlement mismatches to look into." : "Nothing handled yet."}
        </Alert>
      ) : null}
      <ul className="space-y-3">
        {data?.data.map((entry) => (
          <SettlementCard key={entry.itemId} entry={entry} onChanged={reload} />
        ))}
      </ul>
    </div>
  );
}

function SettlementCard({ entry, onChanged }: { entry: SettlementEntry; onChanged: () => void }) {
  const f = (minor: string) => formatMoney(minor, entry.currency, entry.currencyExponent);
  return (
    <li
      className="rounded-card border border-line bg-white p-4 shadow-card"
      data-testid="settlement-mismatch"
    >
      <p className="font-semibold text-primary">
        {entry.listing.title} · {entry.provider.name}
      </p>
      <p className="text-sm text-muted">
        Trip {entry.trip.reference} · {formatDateRange(entry.startDate, entry.endDate)} · total{" "}
        {f(entry.totalMinor)} · commission {f(entry.commissionMinor)}
        {entry.invoice ? ` · invoice ${entry.invoice.number}` : " · no invoice"}
      </p>
      <p className="text-sm text-muted">
        {entry.paymentSettledAt
          ? `Recorded as paid at the property ${formatTimestamp(entry.paymentSettledAt)}`
          : "Not recorded as paid"}
      </p>
      <ul className="mt-2 space-y-2">
        {entry.mismatches.map((m) => (
          <MismatchRow key={m.kind} itemId={entry.itemId} mismatch={m} onChanged={onChanged} />
        ))}
      </ul>
    </li>
  );
}

function MismatchRow({
  itemId,
  mismatch,
  onChanged,
}: {
  itemId: string;
  mismatch: SettlementEntry["mismatches"][number];
  onChanged: () => void;
}) {
  const request = useAdminRequest();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function resolve() {
    setBusy(true);
    setProblem(null);
    try {
      await request(`/settlement-reconciliation/${itemId}/resolve`, {
        method: "POST",
        body: { kind: mismatch.kind, note: note.trim() },
      });
      onChanged();
    } catch (err) {
      setProblem(describeAdminError(err));
      setBusy(false);
    }
  }

  return (
    <li className="rounded-control border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{settlementKindLabel(mismatch.kind)}</span>
        <StatusPill
          label={mismatch.resolution ? "Handled" : "To look into"}
          tone={mismatch.resolution ? "good" : "wait"}
        />
      </div>
      {mismatch.resolution ? (
        <p className="mt-1 text-ink">
          Note: {mismatch.resolution.note} · {formatTimestamp(mismatch.resolution.resolvedAt)}
        </p>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void resolve();
          }}
        >
          <label className={labelClass}>
            What was found and done
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonSecondary} disabled={busy}>
            Mark as handled
          </button>
        </form>
      )}
      {problem ? (
        <div className="mt-2">
          <Alert>{problem}</Alert>
        </div>
      ) : null}
    </li>
  );
}

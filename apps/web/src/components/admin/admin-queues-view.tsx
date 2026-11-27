"use client";

import { useState } from "react";
import { describeAdminError } from "@/lib/admin-access";
import {
  gatewayName,
  reconciliationReasonLabel,
  refundStatusLabel,
  type LatePayment,
  type RefundRequestRow,
} from "@/lib/admin-ops";
import { formatMoney } from "@/lib/money";
import { formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import { Alert, buttonSecondary, inputClass, labelClass, StatusPill } from "../ui/primitives";
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

/**
 * Admin queues (Phase 12, gap 34, ADR 0018): money a gateway confirmed that could not be applied
 * (late, different amount, duplicate; Phase 11 records it, never drops it), and refund requests
 * (recorded only: refunds are executed in the Cancellations & refunds phase).
 */
export function LatePaymentsQueue() {
  const [status, setStatus] = useState<"OPEN" | "RESOLVED">("OPEN");
  const { data, error, reload } = useAdminData<Paged<LatePayment>>(
    `/payment-reconciliations?status=${status}&pageSize=50`,
  );
  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="group" aria-label="Show">
        {(["OPEN", "RESOLVED"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`rounded-full border px-3 py-1 text-sm ${status === s ? "border-primary bg-primary text-white" : "border-line text-primary"}`}
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
          >
            {s === "OPEN" ? "To handle" : "Handled"}
          </button>
        ))}
      </div>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-muted">Loading late payments…</p> : null}
      {data && data.data.length === 0 ? (
        <Alert tone="info">
          {status === "OPEN" ? "No late payments to handle." : "Nothing handled yet."}
        </Alert>
      ) : null}
      <ul className="space-y-3">
        {data?.data.map((row) => (
          <LatePaymentCard key={row.id} row={row} onHandled={reload} />
        ))}
      </ul>
    </div>
  );
}

function LatePaymentCard({ row, onHandled }: { row: LatePayment; onHandled: () => void }) {
  const request = useAdminRequest();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function resolve() {
    setBusy(true);
    setProblem(null);
    try {
      await request(`/payment-reconciliations/${row.id}/resolve`, {
        method: "POST",
        body: { note: note.trim() },
      });
      onHandled();
    } catch (err) {
      setProblem(describeAdminError(err));
      setBusy(false);
    }
  }

  return (
    <li
      className="rounded-card border border-line bg-white p-4 shadow-card"
      data-testid="late-payment"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-primary" data-testid="late-payment-amount">
            {formatMoney(row.amountMinor, row.currency, row.currencyExponent)} via{" "}
            {gatewayName(row.gateway)}
          </p>
          <p className="text-sm text-muted">
            Trip {row.trip.reference} · {reconciliationReasonLabel(row.reason)} ·{" "}
            {formatTimestamp(row.createdAt)}
          </p>
          <p className="text-xs text-muted">Gateway transaction {row.gatewayTransactionId}</p>
        </div>
        <StatusPill
          label={row.status === "OPEN" ? "To handle" : "Handled"}
          tone={row.status === "OPEN" ? "wait" : "good"}
        />
      </div>
      {row.status === "RESOLVED" ? (
        <p className="mt-2 text-sm text-ink">Note: {row.note}</p>
      ) : (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void resolve();
          }}
        >
          <label className={labelClass}>
            What was done
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

export function RefundRequestsQueue() {
  const { data, error } = useAdminData<Paged<RefundRequestRow>>("/refund-requests?pageSize=50");
  return (
    <div className="space-y-4">
      <Alert tone="info">
        Refunds are recorded, not executed yet: make the refund in the gateway&apos;s merchant
        portal (Khalti also has a refund API, used from the Cancellations &amp; refunds phase).
      </Alert>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-muted">Loading refund requests…</p> : null}
      {data && data.data.length === 0 ? <Alert tone="info">No refund requests.</Alert> : null}
      <ul className="space-y-3">
        {data?.data.map((row) => (
          <li
            key={row.id}
            className="rounded-card border border-line bg-white p-4 shadow-card"
            data-testid="refund-request"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-semibold text-primary" data-testid="refund-request-amount">
                {formatMoney(row.amountMinor, row.currency, row.currencyExponent)} ·{" "}
                {gatewayName(row.gateway)}
              </p>
              <StatusPill label={refundStatusLabel(row.status)} tone="wait" />
            </div>
            <p className="mt-1 text-sm text-ink">{row.reason}</p>
            <p className="text-xs text-muted">
              {row.bookingItemId ? "For a booking" : "For a late payment"} ·{" "}
              {formatTimestamp(row.createdAt)} · {row.gatewayRefundCapability.note}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

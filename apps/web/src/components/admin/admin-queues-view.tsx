"use client";

import { useState } from "react";
import { describeAdminError } from "@/lib/admin-access";
import {
  gatewayName,
  reconciliationReasonLabel,
  type LatePayment,
  type RefundRequestRow,
} from "@/lib/admin-ops";
import {
  executeLabel,
  refundActions,
  refundStatusText,
  refundStatusTone,
} from "@/lib/refunds-display";
import { formatMoney } from "@/lib/money";
import { formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import {
  Alert,
  buttonGhost,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

/**
 * Admin queues (Phase 12, gap 34, ADR 0018): money a gateway confirmed that could not be applied
 * (late, different amount, duplicate; Phase 11 records it, never drops it), and refunds
 * (executed since Phase 14, ADR 0020).
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

const REFUND_FILTERS = [
  { status: "", label: "All" },
  { status: "REQUESTED", label: "To approve" },
  { status: "APPROVED", label: "Approved" },
  { status: "PROCESSING", label: "Being refunded" },
  { status: "FAILED", label: "Failed" },
  { status: "COMPLETED", label: "Refunded" },
  { status: "REJECTED", label: "Rejected" },
] as const;

/**
 * Refunds (Phase 14, gap 31, ADR 0020): approve → execute (Khalti: its refund API; eSewa: by hand
 * in the merchant portal, then record the reference) → refunded. Every step is idempotent on the
 * API, so a double click changes nothing.
 */
export function RefundRequestsQueue() {
  const [status, setStatus] = useState<string>("");
  const { data, error, reload } = useAdminData<Paged<RefundRequestRow>>(
    `/refund-requests?pageSize=50${status ? `&status=${status}` : ""}`,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
        {REFUND_FILTERS.map((f) => (
          <button
            key={f.status || "all"}
            type="button"
            className={`rounded-full border px-3 py-1 text-sm ${status === f.status ? "border-primary bg-primary text-white" : "border-line text-primary"}`}
            aria-pressed={status === f.status}
            onClick={() => setStatus(f.status)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-muted">Loading refund requests…</p> : null}
      {data && data.data.length === 0 ? <Alert tone="info">No refund requests.</Alert> : null}
      <ul className="space-y-3">
        {data?.data.map((row) => (
          <RefundCard key={row.id} row={row} onChanged={reload} />
        ))}
      </ul>
    </div>
  );
}

function RefundCard({ row, onChanged }: { row: RefundRequestRow; onChanged: () => void }) {
  const request = useAdminRequest();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [reference, setReference] = useState("");
  const actions = refundActions(row);

  async function act(path: string, body: object, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await request(`/refund-requests/${row.id}/${path}`, { method: "POST", body });
      setMessage({ tone: "success", text: done });
      onChanged();
    } catch (err) {
      setMessage({ tone: "error", text: describeAdminError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="rounded-card border border-line bg-white p-4 shadow-card"
      data-testid="refund-request"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-semibold text-primary" data-testid="refund-request-amount">
          {formatMoney(row.amountMinor, row.currency, row.currencyExponent)} ·{" "}
          {gatewayName(row.gateway)}
        </p>
        <span data-testid="refund-request-status">
          <StatusPill label={refundStatusText(row)} tone={refundStatusTone(row.status)} />
        </span>
      </div>
      <p className="mt-1 text-sm text-ink">{row.reason}</p>
      <p className="text-xs text-muted">
        {row.trip ? `Trip ${row.trip.reference} · ` : ""}
        {row.item
          ? row.item.title
          : row.bookingItemId
            ? "For a booking"
            : "For a late payment"} · {formatTimestamp(row.createdAt)} ·{" "}
        {row.gatewayRefundCapability.note}
      </p>
      {row.gatewayRefundReferenceMasked ? (
        <p className="text-xs text-muted">
          Gateway reference {row.gatewayRefundReferenceMasked}
          {row.completedAt ? ` · refunded ${formatTimestamp(row.completedAt)}` : ""}
        </p>
      ) : null}
      {row.note ? <p className="mt-1 text-sm text-ink">Note: {row.note}</p> : null}
      {row.failureReason && row.status === "FAILED" ? (
        <p className="mt-1 text-sm text-red-800">Failed: {row.failureReason}</p>
      ) : null}
      {message ? (
        <div className="mt-2">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {actions.includes("approve") ? (
          <button
            type="button"
            className={buttonPrimary}
            disabled={busy}
            onClick={() => void act("approve", {}, "Approved.")}
          >
            Approve
          </button>
        ) : null}
        {actions.includes("execute") ? (
          <button
            type="button"
            className={buttonPrimary}
            disabled={busy}
            onClick={() => void act("execute", {}, "Sent. See the status above.")}
          >
            {executeLabel(row)}
          </button>
        ) : null}
        {actions.includes("check") ? (
          <button
            type="button"
            className={buttonSecondary}
            disabled={busy}
            onClick={() => void act("check", {}, "Checked with the gateway.")}
          >
            Ask {gatewayName(row.gateway)} what happened
          </button>
        ) : null}
      </div>
      {actions.includes("complete") ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act("complete", { reference: reference.trim() }, "Recorded as refunded.");
          }}
        >
          <label className={labelClass}>
            {gatewayName(row.gateway)} refund reference
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              minLength={3}
              maxLength={200}
              required
              autoComplete="off"
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonSecondary} disabled={busy}>
            Record as refunded
          </button>
        </form>
      ) : null}
      {actions.includes("reject") ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act("reject", { note: rejectNote.trim() }, "Rejected.");
          }}
        >
          <label className={labelClass}>
            Why not refunded
            <input
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              maxLength={1000}
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonGhost} disabled={busy}>
            Reject
          </button>
        </form>
      ) : null}
    </li>
  );
}

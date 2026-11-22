"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useReducer } from "react";
import { formatMoney } from "@/lib/money";
import { describePartnerError } from "@/lib/partner-access";
import {
  bpsToPercentText,
  commissionStatusLabel,
  formatTimestamp,
  invoiceStatusLabel,
  payoutStatusLabel,
} from "@/lib/partner-display";
import type { Paged, ProviderBooking, ProviderBookingDetail } from "@/lib/partner-types";
import {
  canSettleAtProperty,
  INITIAL_SETTLE_STATE,
  newSettleKey,
  settleOutcomeText,
  settleReducer,
} from "@/lib/settle-state";
import {
  describeCancellationRule,
  formatDateRange,
  formatServiceDate,
  paymentMethodLabel,
  paymentStatusLabel,
  statusLabel,
} from "@/lib/trip-display";
import {
  Alert,
  buttonPrimary,
  inputClass,
  labelClass,
  StatusPill,
  statusTone,
} from "../ui/primitives";
import { usePartner } from "./partner-context";
import {
  Facts,
  Pager,
  Panel,
  PartnerError,
  tableClass,
  tdClass,
  thClass,
  usePartnerData,
} from "./partner-ui";

const BOOKING_STATUSES = [
  "",
  "PENDING",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "EXPIRED",
];

/** Partner booking statuses: "PENDING" here means waiting for the customer's online payment. */
function bookingStatusLabel(status: string): string {
  return status === "PENDING" ? "Awaiting payment" : statusLabel(status);
}

/**
 * /partner/bookings: booking items of submitted trips for this business only (the API scopes
 * them). Customers appear by name; contact details arrive masked and are shown as they are.
 */
export function BookingList() {
  const search = useSearchParams();
  const router = useRouter();
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const status = search.get("status") ?? "";
  const query = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (status) query.set("status", status);
  const { data, error } = usePartnerData<Paged<ProviderBooking>>(`/bookings?${query.toString()}`);

  return (
    <div className="space-y-4">
      <label className={`${labelClass} max-w-xs`}>
        Status
        <select
          className={inputClass}
          value={status}
          onChange={(e) =>
            router.push(
              e.target.value ? `/partner/bookings?status=${e.target.value}` : "/partner/bookings",
            )
          }
        >
          {BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s ? bookingStatusLabel(s) : "All"}
            </option>
          ))}
        </select>
      </label>
      {error ? <PartnerError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-slate-600">Loading bookings…</p> : null}
      {data && data.data.length === 0 ? <Alert tone="info">No bookings yet.</Alert> : null}
      {data && data.data.length > 0 ? (
        <ul className="space-y-3" data-testid="partner-bookings">
          {data.data.map((b) => (
            <li
              key={b.id}
              className="rounded-xl border border-mist bg-white p-4 shadow-sm"
              data-testid="partner-booking"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link
                    href={`/partner/bookings/${b.id}`}
                    className="font-semibold text-navy hover:underline"
                  >
                    {b.listing.title}
                  </Link>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatDateRange(b.startDate, b.endDate)} · {b.quantity} × · {b.customer.name} ·
                    Trip {b.tripReference}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {paymentMethodLabel(b.paymentMethod)} · {paymentStatusLabel(b.paymentStatus)}
                  </p>
                </div>
                <div className="text-right">
                  <StatusPill label={bookingStatusLabel(b.status)} tone={statusTone(b.status)} />
                  <p className="mt-1 font-semibold text-navy">
                    {formatMoney(b.money.totalMinor, b.currency, b.currencyExponent)}
                  </p>
                  <p className="text-xs text-slate-600">
                    Your share{" "}
                    {formatMoney(b.money.providerPayoutMinor, b.currency, b.currencyExponent)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {data ? (
        <Pager
          page={data.page}
          hrefFor={(p) => `/partner/bookings?page=${p}${status ? `&status=${status}` : ""}`}
        />
      ) : null}
    </div>
  );
}

/**
 * "Payment received at the property". One Idempotency-Key per attempt, kept until the API
 * confirms, so a retry after a lost response is applied once (lib/settle-state.ts).
 */
function SettleAction({
  booking,
  onSettled,
}: {
  booking: ProviderBooking;
  onSettled: (booking: ProviderBooking) => void;
}) {
  const { request } = usePartner();
  const [state, dispatch] = useReducer(settleReducer, INITIAL_SETTLE_STATE);
  const outcome = settleOutcomeText(state);

  async function settle() {
    if (state.phase === "sending" || state.phase === "done") return;
    const key = state.key ?? newSettleKey(booking.id);
    dispatch({ type: "start", newKey: () => key });
    try {
      const body = await request<{ data: { replayed: boolean; booking: ProviderBooking } }>(
        `/bookings/${booking.id}/settle-at-property`,
        { method: "POST", body: {}, headers: { "Idempotency-Key": key } },
      );
      dispatch({ type: "succeeded", replayed: body.data.replayed });
      onSettled(body.data.booking);
    } catch (err) {
      dispatch({ type: "failed", message: describePartnerError(err) });
    }
  }

  if (outcome) {
    return (
      <div data-testid="settle-outcome">
        <Alert tone="success">{outcome}</Alert>
      </div>
    );
  }
  if (!canSettleAtProperty(booking)) return null;
  return (
    <div className="space-y-3" data-testid="settle-action">
      <p className="text-sm text-slate-600">
        When the guest pays you on arrival, record it here. No money moves through MeroStay; the
        commission stays on your invoice.
      </p>
      {state.phase === "failed" ? (
        <Alert>{state.message} Trying again is safe: it will be recorded only once.</Alert>
      ) : null}
      <button
        type="button"
        className={buttonPrimary}
        disabled={state.phase === "sending"}
        onClick={() => void settle()}
      >
        {state.phase === "sending"
          ? "Recording…"
          : state.phase === "failed"
            ? "Try again"
            : "Record payment received at the property"}
      </button>
    </div>
  );
}

/** /partner/bookings/[id]: one booking with its frozen money and policy. Not ours → "Not found". */
export function BookingDetailView() {
  const params = useParams<{ id: string }>();
  const { data, error, setData } = usePartnerData<{ data: ProviderBookingDetail }>(
    `/bookings/${encodeURIComponent(params.id)}`,
  );
  if (error)
    return <PartnerError view={error} backHref="/partner/bookings" backLabel="Back to bookings" />;
  if (!data) return <p className="text-sm text-slate-600">Loading booking…</p>;
  const b = data.data;
  const f = (minor: string) => formatMoney(minor, b.currency, b.currencyExponent);
  const rules = Array.isArray(b.cancellationPolicy?.rules) ? b.cancellationPolicy.rules : [];

  return (
    <div className="space-y-4">
      <Panel
        title={b.listing.title}
        actions={<StatusPill label={bookingStatusLabel(b.status)} tone={statusTone(b.status)} />}
      >
        <Facts
          rows={[
            { label: "Trip", value: b.tripReference },
            { label: "Dates", value: formatDateRange(b.startDate, b.endDate) },
            { label: "Quantity", value: `${b.quantity}` },
            { label: "Travellers", value: `${b.travellerCount}` },
            { label: "Guest", value: b.customer.name },
            { label: "Guest email", value: b.customer.emailMasked ?? "—" },
            { label: "Guest phone", value: b.customer.phoneMasked ?? "—" },
            {
              label: "Payment",
              value: `${paymentMethodLabel(b.paymentMethod)} · ${paymentStatusLabel(b.paymentStatus)}`,
            },
            { label: "Commission", value: commissionStatusLabel(b.commissionStatus) },
            { label: "Payout", value: payoutStatusLabel(b.payoutStatus) },
            {
              label: "Invoice",
              value: b.commissionInvoice ? (
                <Link href="/partner/invoices" className="text-navy underline">
                  {b.commissionInvoice.number} ({invoiceStatusLabel(b.commissionInvoice.status)})
                </Link>
              ) : (
                "—"
              ),
            },
          ]}
        />
      </Panel>

      <Panel title="Money (frozen when booked)">
        <dl
          className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm"
          data-testid="booking-money"
        >
          {[
            ["Subtotal", f(b.money.subtotalMinor)],
            ["Service charge", f(b.money.serviceChargeMinor)],
            ["VAT", f(b.money.taxMinor)],
            ["Booking total", f(b.money.totalMinor)],
            [
              `MeroStay commission (${bpsToPercentText(b.money.commissionRateBps)} of subtotal)`,
              f(b.money.commissionMinor),
            ],
            ["Your share", f(b.money.providerPayoutMinor)],
            ["Paid online so far", f(b.money.paidOnlineMinor)],
            ["Refunded", f(b.money.refundedMinor)],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className={label === "Your share" ? "font-semibold text-navy" : "text-slate-600"}>
                {label}
              </dt>
              <dd
                className={`text-right ${label === "Your share" ? "font-semibold text-navy" : "text-ink"}`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {b.lines.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Units</th>
                  <th className={thClass}>Price</th>
                  <th className={thClass}>Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-mist">
                {b.lines.map((line) => (
                  <tr key={line.date}>
                    <td className={tdClass}>{formatServiceDate(line.date)}</td>
                    <td className={tdClass}>{line.units}</td>
                    <td className={tdClass}>{f(line.unitPriceMinor)}</td>
                    <td className={tdClass}>{f(line.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <Panel title="Cancellation policy (as booked)">
        {b.cancellationPolicy ? (
          <>
            {b.cancellationPolicy.name ? (
              <p className="font-medium text-ink">{b.cancellationPolicy.name}</p>
            ) : null}
            {rules.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-sm text-ink">
                {rules.map((rule, i) => (
                  <li key={i}>{describeCancellationRule(rule)}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-600">No refund rules.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-600">No cancellation policy was attached.</p>
        )}
      </Panel>

      {b.paymentMethod === "pay_at_property" ? (
        <Panel title="Payment at the property">
          {b.settledAt ? (
            <p className="mb-3 text-sm text-ink" data-testid="settled-record">
              Recorded as paid on {formatTimestamp(b.settledAt)}
              {b.settledBy ? ` by ${b.settledBy.name}` : ""}.
            </p>
          ) : null}
          <SettleAction booking={b} onSettled={(next) => setData({ data: { ...b, ...next } })} />
        </Panel>
      ) : null}
    </div>
  );
}

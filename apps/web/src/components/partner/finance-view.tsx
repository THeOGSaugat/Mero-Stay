"use client";

import { useSearchParams } from "next/navigation";
import { formatMoney } from "@/lib/money";
import {
  bpsToPercentText,
  commissionStatusLabel,
  formatPeriod,
  formatTimestamp,
  invoiceStatusLabel,
  payoutStatusLabel,
} from "@/lib/partner-display";
import type { CommissionInvoice, Paged, PayoutSummaryRow } from "@/lib/partner-types";
import { formatServiceDate, paymentStatusLabel } from "@/lib/trip-display";
import { Alert, StatusPill } from "../ui/primitives";
import {
  Pager,
  Panel,
  PartnerError,
  tableClass,
  tdClass,
  thClass,
  usePartnerData,
} from "./partner-ui";

function pageOf(search: URLSearchParams): number {
  return Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
}

/**
 * /partner/invoices: MeroStay's commission invoices to this business (one per trip with
 * pay-at-property items, issued when the trip is confirmed). Amounts are the API's strings.
 */
export function InvoiceList() {
  const page = pageOf(useSearchParams());
  const { data, error } = usePartnerData<Paged<CommissionInvoice>>(
    `/invoices?page=${page}&pageSize=20`,
  );
  if (error) return <PartnerError view={error} />;
  if (!data) return <p className="text-sm text-slate-600">Loading invoices…</p>;
  if (data.data.length === 0) return <Alert tone="info">No invoices yet.</Alert>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        When guests pay you at the property, MeroStay invoices its commission. Online payments have
        the commission deducted from your payout instead.
      </p>
      <ul className="space-y-3" data-testid="partner-invoices">
        {data.data.map((inv) => (
          <li key={inv.id} data-testid="partner-invoice">
            <Panel
              title={inv.number}
              actions={
                <StatusPill
                  label={invoiceStatusLabel(inv.status)}
                  tone={inv.status === "PAID" ? "good" : inv.status === "VOID" ? "neutral" : "wait"}
                />
              }
            >
              <p className="text-sm text-slate-600">
                Issued {formatTimestamp(inv.issuedAt)}
                {inv.dueOn ? ` · due ${formatServiceDate(inv.dueOn)}` : ""}
                {inv.paidAt ? ` · paid ${formatTimestamp(inv.paidAt)}` : ""}
              </p>
              <p className="mt-2 text-xl font-semibold text-navy" data-testid="invoice-amount">
                {formatMoney(inv.amountMinor, inv.currency, inv.currencyExponent)}
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th className={thClass}>Item</th>
                      <th className={thClass}>Payment</th>
                      <th className={thClass}>Subtotal</th>
                      <th className={thClass}>Rate</th>
                      <th className={thClass}>Commission</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-mist">
                    {inv.items.map((item) => (
                      <tr key={item.id}>
                        <td className={tdClass}>{item.listingType.replace(/_/g, " ")}</td>
                        <td className={tdClass}>
                          {paymentStatusLabel(item.paymentStatus)}
                          <span className="block text-xs text-slate-600">
                            {commissionStatusLabel(item.commissionStatus)}
                          </span>
                        </td>
                        <td className={tdClass}>
                          {formatMoney(item.subtotalMinor, inv.currency, inv.currencyExponent)}
                        </td>
                        <td className={tdClass}>{bpsToPercentText(item.commissionRateBps)}</td>
                        <td className={tdClass}>
                          {formatMoney(item.commissionMinor, inv.currency, inv.currencyExponent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </li>
        ))}
      </ul>
      <Pager page={data.page} hrefFor={(p) => `/partner/invoices?page=${p}`} />
    </div>
  );
}

/**
 * /partner/payouts: read-only summary of online-paid bookings whose payout is pending, per
 * service month. Your payout = total − commission per item (ADR 0008), computed by the API.
 * Nothing is paid out yet (operational gap 16).
 */
export function PayoutSummary() {
  const page = pageOf(useSearchParams());
  const { data, error } = usePartnerData<Paged<PayoutSummaryRow>>(
    `/payouts?page=${page}&pageSize=20`,
  );
  if (error) return <PartnerError view={error} />;
  if (!data) return <p className="text-sm text-slate-600">Loading payouts…</p>;
  return (
    <div className="space-y-4">
      <Alert tone="info">
        What MeroStay owes you for bookings paid online and not yet paid out: each booking&apos;s
        total minus MeroStay&apos;s commission. Once a booking&apos;s service is over, it is paid by
        bank transfer in the next monthly payout (below).
      </Alert>
      {data.data.length === 0 ? (
        <p className="text-sm text-slate-600">No online-paid bookings waiting for a payout.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-mist bg-white">
          <table className={tableClass} data-testid="partner-payouts">
            <thead>
              <tr>
                <th className={thClass}>Month</th>
                <th className={thClass}>Bookings</th>
                <th className={thClass}>Total</th>
                <th className={thClass}>Commission</th>
                <th className={thClass}>Your payout</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist">
              {data.data.map((row) => {
                const f = (minor: string) => formatMoney(minor, row.currency, row.currencyExponent);
                return (
                  <tr key={`${row.period}-${row.currency}`} data-testid="payout-row">
                    <td className={tdClass}>{formatPeriod(row.period)}</td>
                    <td className={tdClass}>{row.items}</td>
                    <td className={tdClass}>{f(row.totalMinor)}</td>
                    <td className={tdClass}>{f(row.commissionMinor)}</td>
                    <td className={`${tdClass} font-semibold text-navy`}>
                      {f(row.providerPayoutMinor)}
                    </td>
                    <td className={tdClass}>
                      <StatusPill label={payoutStatusLabel(row.payoutStatus)} tone="wait" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={data.page} hrefFor={(p) => `/partner/payouts?page=${p}`} />
    </div>
  );
}

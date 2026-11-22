"use client";

import Form from "next/form";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { AdminProviderSummary } from "@/lib/admin-types";
import { formatMoney } from "@/lib/money";
import {
  formatPeriod,
  formatTimestamp,
  invoiceStatusLabel,
  payoutStatusLabel,
} from "@/lib/partner-display";
import type { CommissionInvoice, Paged, PayoutSummaryRow } from "@/lib/partner-types";
import { formatServiceDate } from "@/lib/trip-display";
import { Pager, tableClass, tdClass, thClass } from "../ui/data";
import { Alert, buttonSecondary, inputClass, labelClass, StatusPill } from "../ui/primitives";
import { AdminError, useAdminData } from "./admin-ui";

/** The filters present in the URL, and the query for the API (empty values dropped). */
function filtersFrom(search: URLSearchParams, keys: readonly string[]) {
  const values: Record<string, string> = {};
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = (search.get(key) ?? "").trim();
    values[key] = value;
    if (value) query.set(key, value);
  }
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  query.set("page", String(page));
  query.set("pageSize", "20");
  return { values, query, page };
}

function hrefFor(base: string, values: Record<string, string>, page: number): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v) q.set(k, v);
  q.set("page", String(page));
  return `${base}?${q.toString()}`;
}

/** A provider filter: the first 100 providers by name (the API's page limit). */
function ProviderSelect({ value }: { value: string }) {
  const { data } = useAdminData<Paged<AdminProviderSummary>>("/providers?pageSize=100");
  return (
    <label className={labelClass}>
      Provider
      <select
        name="providerId"
        defaultValue={value}
        key={`${value}-${data ? "loaded" : "loading"}`}
        className={inputClass}
      >
        <option value="">All providers</option>
        {data?.data
          .slice()
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
      </select>
    </label>
  );
}

const INVOICE_KEYS = ["providerId", "status", "from", "to"] as const;

/** /admin/invoices: every commission invoice; filters provider / status / issued date. */
export function AdminInvoiceList() {
  const { values, query } = filtersFrom(useSearchParams(), INVOICE_KEYS);
  const { data, error } = useAdminData<Paged<CommissionInvoice>>(`/invoices?${query.toString()}`);
  return (
    <div className="space-y-4">
      <Form action="/admin/invoices" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <ProviderSelect value={values.providerId ?? ""} />
        <label className={labelClass}>
          Status
          <select name="status" defaultValue={values.status} className={inputClass}>
            <option value="">All</option>
            {["ISSUED", "PAID", "VOID", "DRAFT"].map((s) => (
              <option key={s} value={s}>
                {invoiceStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Issued from
          <input name="from" type="date" defaultValue={values.from} className={inputClass} />
        </label>
        <label className={labelClass}>
          Issued before
          <input name="to" type="date" defaultValue={values.to} className={inputClass} />
        </label>
        <button type="submit" className={buttonSecondary}>
          Filter
        </button>
      </Form>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-slate-600">Loading invoices…</p> : null}
      {data && data.data.length === 0 ? <Alert tone="info">No invoices match.</Alert> : null}
      {data && data.data.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-mist bg-white">
          <table className={tableClass} data-testid="admin-invoices">
            <thead>
              <tr>
                <th className={thClass}>Invoice</th>
                <th className={thClass}>Provider</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Issued</th>
                <th className={thClass}>Items</th>
                <th className={thClass}>Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist">
              {data.data.map((inv) => (
                <tr key={inv.id} data-testid="admin-invoice-row" data-invoice={inv.id}>
                  <td className={tdClass}>
                    {inv.number}
                    {inv.dueOn ? (
                      <span className="block text-slate-600">
                        Due {formatServiceDate(inv.dueOn)}
                      </span>
                    ) : null}
                  </td>
                  <td className={tdClass}>
                    <Link
                      href={`/admin/providers/${inv.provider.id}`}
                      className="text-navy hover:underline"
                    >
                      {inv.provider.name}
                    </Link>
                  </td>
                  <td className={tdClass}>
                    <StatusPill
                      label={invoiceStatusLabel(inv.status)}
                      tone={
                        inv.status === "PAID" ? "good" : inv.status === "VOID" ? "neutral" : "wait"
                      }
                    />
                  </td>
                  <td className={tdClass}>{formatTimestamp(inv.issuedAt)}</td>
                  <td className={tdClass}>{inv.items.length}</td>
                  <td
                    className={`${tdClass} font-semibold text-navy`}
                    data-testid="admin-invoice-amount"
                  >
                    {formatMoney(inv.amountMinor, inv.currency, inv.currencyExponent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? (
        <Pager page={data.page} hrefFor={(p) => hrefFor("/admin/invoices", values, p)} />
      ) : null}
    </div>
  );
}

const PAYOUT_KEYS = ["providerId", "from", "to"] as const;

/**
 * /admin/payouts: read-only summary across providers of online-paid items whose payout is
 * pending, per service month. Payout = total − commission per item (ADR 0008), from the API.
 * Nothing is executed (gap 16).
 */
export function AdminPayoutSummary() {
  const { values, query } = filtersFrom(useSearchParams(), PAYOUT_KEYS);
  const { data, error } = useAdminData<Paged<PayoutSummaryRow>>(`/payouts?${query.toString()}`);
  return (
    <div className="space-y-4">
      <Alert tone="info">
        Read-only: payouts are not executed yet. Each provider&apos;s payout is its bookings&apos;
        total minus MeroStay&apos;s commission.
      </Alert>
      <Form action="/admin/payouts" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ProviderSelect value={values.providerId ?? ""} />
        <label className={labelClass}>
          Service from
          <input name="from" type="date" defaultValue={values.from} className={inputClass} />
        </label>
        <label className={labelClass}>
          Service before
          <input name="to" type="date" defaultValue={values.to} className={inputClass} />
        </label>
        <button type="submit" className={buttonSecondary}>
          Filter
        </button>
      </Form>
      {error ? <AdminError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-slate-600">Loading payouts…</p> : null}
      {data && data.data.length === 0 ? (
        <Alert tone="info">Nothing is waiting for a payout.</Alert>
      ) : null}
      {data && data.data.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-mist bg-white">
          <table className={tableClass} data-testid="admin-payouts">
            <thead>
              <tr>
                <th className={thClass}>Provider</th>
                <th className={thClass}>Month</th>
                <th className={thClass}>Bookings</th>
                <th className={thClass}>Total</th>
                <th className={thClass}>Commission</th>
                <th className={thClass}>Payout</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist">
              {data.data.map((row) => {
                const f = (minor: string) => formatMoney(minor, row.currency, row.currencyExponent);
                return (
                  <tr
                    key={`${row.provider.id}-${row.period}-${row.currency}`}
                    data-testid="admin-payout-row"
                    data-provider={row.provider.id}
                  >
                    <td className={tdClass}>{row.provider.name}</td>
                    <td className={tdClass}>{formatPeriod(row.period)}</td>
                    <td className={tdClass}>{row.items}</td>
                    <td className={tdClass}>{f(row.totalMinor)}</td>
                    <td className={tdClass}>{f(row.commissionMinor)}</td>
                    <td
                      className={`${tdClass} font-semibold text-navy`}
                      data-testid="admin-payout-amount"
                    >
                      {f(row.providerPayoutMinor)}
                    </td>
                    <td className={tdClass}>
                      <StatusPill
                        label={`${payoutStatusLabel(row.payoutStatus)} · not executed`}
                        tone="wait"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? (
        <Pager page={data.page} hrefFor={(p) => hrefFor("/admin/payouts", values, p)} />
      ) : null}
    </div>
  );
}

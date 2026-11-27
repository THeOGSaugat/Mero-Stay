"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { describeAdminError } from "@/lib/admin-access";
import {
  isMonth,
  payoutActions,
  payoutBatchStatusLabel,
  payoutBatchTone,
  previousMonth,
  type PayoutBatch,
  type PayoutBatchDetail,
} from "@/lib/admin-ops";
import { formatMoney } from "@/lib/money";
import { formatPeriod, formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import { formatDateRange } from "@/lib/trip-display";
import { Pager, Panel, tableClass, tdClass, thClass } from "../ui/data";
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
 * Payout batches (Phase 12, gap 16, ADR 0018): MeroStay pays providers by MANUAL bank transfer and
 * records it here. Generate a month → schedule (needs a verified bank account) → after making the
 * transfer, record it as paid with the bank's reference (or as failed). Nothing calls a bank.
 */

const todayNepal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());

export function AdminPayoutBatches() {
  const search = useSearchParams();
  const status = search.get("status") ?? "";
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const query = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (status) query.set("status", status);
  const { data, error, reload } = useAdminData<Paged<PayoutBatch>>(
    `/payout-batches?${query.toString()}`,
  );
  const request = useAdminRequest();
  const [month, setMonth] = useState(() => previousMonth(todayNepal()));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!isMonth(month)) {
      setMessage({ tone: "error", text: "Choose a month." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const body = await request<{ data: unknown[] }>("/payout-batches/generate", {
        method: "POST",
        body: { period: month },
      });
      setMessage({
        tone: "success",
        text:
          body.data.length === 0
            ? `Nothing new to pay out for ${formatPeriod(month)}.`
            : `${body.data.length} payout batch${body.data.length === 1 ? "" : "es"} ready for ${formatPeriod(month)}.`,
      });
      reload();
    } catch (err) {
      setMessage({ tone: "error", text: describeAdminError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Payout batches">
      <p className="text-sm text-muted">
        Bookings whose service is over (Nepal time), paid online and not cancelled, grouped per
        provider and month. Net = total − commission. Transfers are made outside MeroStay and
        recorded here.
      </p>
      <form onSubmit={(e) => void generate(e)} className="mt-3 flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Service month
          <input
            type="month"
            name="period"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={inputClass}
            required
          />
        </label>
        <button type="submit" className={buttonPrimary} disabled={busy}>
          {busy ? "Preparing…" : "Prepare payouts"}
        </button>
      </form>
      {message ? (
        <div className="mt-3" data-testid="payout-generate-outcome">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      ) : null}

      <nav aria-label="Payout status" className="mt-4 flex flex-wrap gap-2 text-sm">
        {["", "PENDING", "SCHEDULED", "PAID", "FAILED"].map((s) => (
          <Link
            key={s || "all"}
            href={s ? `/admin/payouts?status=${s}` : "/admin/payouts"}
            className={`rounded-full border px-3 py-1 ${status === s ? "border-primary bg-primary text-white" : "border-line text-primary"}`}
            aria-current={status === s ? "page" : undefined}
          >
            {s ? payoutBatchStatusLabel(s) : "All"}
          </Link>
        ))}
      </nav>

      <div className="mt-3">
        {error ? <AdminError view={error} /> : null}
        {!data && !error ? <p className="text-sm text-muted">Loading payout batches…</p> : null}
        {data && data.data.length === 0 ? <Alert tone="info">No payout batches here.</Alert> : null}
        {data && data.data.length > 0 ? (
          <div className="overflow-x-auto rounded-card border border-line bg-white">
            <table className={tableClass} data-testid="payout-batches">
              <thead>
                <tr>
                  <th className={thClass}>Provider</th>
                  <th className={thClass}>Month</th>
                  <th className={thClass}>Bookings</th>
                  <th className={thClass}>Total</th>
                  <th className={thClass}>Commission</th>
                  <th className={thClass}>Net payout</th>
                  <th className={thClass}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.data.map((batch) => {
                  const f = (minor: string) =>
                    formatMoney(minor, batch.currency, batch.currencyExponent);
                  return (
                    <tr
                      key={batch.id}
                      data-testid="payout-batch-row"
                      data-provider={batch.provider.id}
                    >
                      <td className={tdClass}>
                        {/* First column: reachable on a phone without scrolling the table sideways. */}
                        <button
                          type="button"
                          className="text-left font-semibold text-primary underline"
                          onClick={() => setOpenId(openId === batch.id ? null : batch.id)}
                          aria-expanded={openId === batch.id}
                          aria-label={`${openId === batch.id ? "Close" : "Open"} payout for ${batch.provider.name}`}
                        >
                          {batch.provider.name}
                        </button>
                      </td>
                      <td className={tdClass}>{formatPeriod(batch.period)}</td>
                      <td className={tdClass}>{batch.itemCount}</td>
                      <td className={tdClass}>{f(batch.grossMinor)}</td>
                      <td className={tdClass}>{f(batch.commissionMinor)}</td>
                      <td
                        className={`${tdClass} font-semibold text-primary`}
                        data-testid="payout-batch-net"
                      >
                        {f(batch.netMinor)}
                      </td>
                      <td className={tdClass}>
                        <StatusPill
                          label={payoutBatchStatusLabel(batch.status)}
                          tone={payoutBatchTone(batch.status)}
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
          <div className="mt-3">
            <Pager
              page={data.page}
              hrefFor={(p) =>
                `/admin/payouts?${new URLSearchParams({ ...(status ? { status } : {}), page: String(p) }).toString()}`
              }
            />
          </div>
        ) : null}
        {openId ? <PayoutBatchPanel id={openId} onChanged={reload} /> : null}
      </div>
    </Panel>
  );
}

function PayoutBatchPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, reload } = useAdminData<{ data: PayoutBatchDetail }>(
    `/payout-batches/${id}`,
  );
  const request = useAdminRequest();
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (error) return <AdminError view={error} />;
  if (!data) return <p className="mt-3 text-sm text-muted">Loading payout…</p>;
  const batch = data.data;
  const f = (minor: string) => formatMoney(minor, batch.currency, batch.currencyExponent);

  async function act(path: string, body: object, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await request(`/payout-batches/${id}/${path}`, { method: "POST", body });
      setMessage({ tone: "success", text: done });
      reload();
      onChanged();
    } catch (err) {
      setMessage({ tone: "error", text: describeAdminError(err) });
    } finally {
      setBusy(false);
    }
  }

  const actions = payoutActions(batch.status);
  return (
    <section
      aria-label={`Payout for ${batch.provider.name}`}
      className="mt-4 space-y-3 rounded-card border border-line bg-white p-4"
      data-testid="payout-batch-detail"
    >
      <h3 className="font-semibold text-primary">
        {batch.provider.name} · {formatPeriod(batch.period)}
      </h3>
      <p className="text-sm text-ink">
        Net payout <strong data-testid="payout-detail-net">{f(batch.netMinor)}</strong> (
        {f(batch.grossMinor)} − {f(batch.commissionMinor)} commission) ·{" "}
        {payoutBatchStatusLabel(batch.status)}
      </p>
      {batch.payoutAccountLabel ? (
        <p className="text-sm text-muted">To: {batch.payoutAccountLabel}</p>
      ) : null}
      {batch.bankReferenceMasked ? (
        <p className="text-sm text-muted">
          Bank reference {batch.bankReferenceMasked} · paid {formatTimestamp(batch.paidAt)}
        </p>
      ) : null}
      {batch.failureReason ? (
        <p className="text-sm text-red-800">Failed: {batch.failureReason}</p>
      ) : null}
      <ul className="space-y-1 text-sm">
        {batch.items.map((item) => (
          <li key={item.id} className="flex flex-wrap justify-between gap-2">
            <span>
              {item.listing.title} · trip {item.trip.reference} ·{" "}
              {formatDateRange(item.startDate, item.endDate)}
            </span>
            <span className="font-medium">{f(item.netMinor)}</span>
          </li>
        ))}
      </ul>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {actions.includes("schedule") ? (
        <button
          type="button"
          className={buttonPrimary}
          disabled={busy}
          onClick={() =>
            void act("schedule", {}, "Scheduled: make the bank transfer, then record it here.")
          }
        >
          Schedule transfer
        </button>
      ) : null}
      {actions.includes("mark-paid") ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act("mark-paid", { bankReference: reference.trim() }, "Recorded as paid.");
          }}
        >
          <label className={labelClass}>
            Bank transfer reference
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              minLength={3}
              maxLength={100}
              required
              autoComplete="off"
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonPrimary} disabled={busy}>
            Record as paid
          </button>
        </form>
      ) : null}
      {actions.includes("mark-failed") ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              "mark-failed",
              { reason: reason.trim() },
              "Recorded as failed: its bookings can be paid out again.",
            );
          }}
        >
          <label className={labelClass}>
            Why the transfer failed
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonSecondary} disabled={busy}>
            Record as failed
          </button>
        </form>
      ) : null}
    </section>
  );
}

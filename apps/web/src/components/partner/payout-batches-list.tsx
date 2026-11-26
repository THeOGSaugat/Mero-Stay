"use client";

import { payoutBatchStatusLabel, payoutBatchTone, type PayoutBatch } from "@/lib/admin-ops";
import { formatMoney } from "@/lib/money";
import { formatPeriod, formatTimestamp } from "@/lib/partner-display";
import type { Paged } from "@/lib/partner-types";
import { Panel, tableClass, tdClass, thClass } from "../ui/data";
import { StatusPill } from "../ui/primitives";
import { PartnerError, usePartnerData } from "./partner-ui";

/** The partner's own payout transfers (Phase 12, ADR 0018): read-only, reference masked. */
export function PartnerPayoutBatches() {
  const { data, error } = usePartnerData<Paged<PayoutBatch>>("/payout-batches?pageSize=24");
  return (
    <Panel title="Payout transfers">
      {error ? <PartnerError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-slate-600">Loading transfers…</p> : null}
      {data && data.data.length === 0 ? (
        <p className="text-sm text-slate-600">No payout transfers yet.</p>
      ) : null}
      {data && data.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className={tableClass} data-testid="partner-payout-batches">
            <thead>
              <tr>
                <th className={thClass}>Month</th>
                <th className={thClass}>Bookings</th>
                <th className={thClass}>Net payout</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist">
              {data.data.map((batch) => (
                <tr key={batch.id} data-testid="partner-payout-batch">
                  <td className={tdClass}>{formatPeriod(batch.period)}</td>
                  <td className={tdClass}>{batch.itemCount}</td>
                  <td className={`${tdClass} font-semibold text-navy`}>
                    {formatMoney(batch.netMinor, batch.currency, batch.currencyExponent)}
                  </td>
                  <td className={tdClass}>
                    <StatusPill
                      label={payoutBatchStatusLabel(batch.status)}
                      tone={payoutBatchTone(batch.status)}
                    />
                  </td>
                  <td className={tdClass}>
                    {batch.bankReferenceMasked
                      ? `${batch.bankReferenceMasked} · ${formatTimestamp(batch.paidAt)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}

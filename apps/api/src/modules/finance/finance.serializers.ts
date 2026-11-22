import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import { serializeInvoices } from "../payments/payments.serializers.js";
import type { InvoiceWithItems } from "./invoices.service.js";
import type { PayoutSummaryRow } from "./finance.service.js";

/** Commission invoices (partner: own; admin: all). Money as digit strings (ADR 0005). */
export function serializeInvoicePage(invoices: InvoiceWithItems[], total: number, page: Page) {
  return { ...serializeInvoices(invoices), page: pageInfo(page, total) };
}

/** Read-only payout summary. `executed: false`: nothing is paid out in this phase. */
export function serializePayoutSummary(rows: PayoutSummaryRow[], total: number, page: Page) {
  return {
    data: rows.map((row) => ({
      provider: { id: row.providerId, name: row.providerName },
      period: row.period,
      ...currencyInfo(row.currency),
      items: row.items,
      subtotalMinor: minorToString(row.subtotalMinor),
      serviceChargeMinor: minorToString(row.serviceChargeMinor),
      taxMinor: minorToString(row.taxMinor),
      totalMinor: minorToString(row.totalMinor),
      commissionMinor: minorToString(row.commissionMinor),
      providerPayoutMinor: minorToString(row.providerPayoutMinor),
      payoutStatus: "PENDING" as const,
      executed: false,
    })),
    page: pageInfo(page, total),
  };
}

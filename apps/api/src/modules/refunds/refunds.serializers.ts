import type { RefundRequest } from "../../generated/prisma/client.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import type { RefundCapability } from "../../lib/payment-gateways/index.js";
import type { ReconciliationRow } from "./refunds.service.js";

/** Admin views of late payments and refund requests. Money as digit strings (ADR 0005). */

export function serializeReconciliation(row: ReconciliationRow) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    trip: { id: row.tripId, reference: row.trip.reference },
    gateway: row.gateway,
    gatewayTransactionId: row.gatewayTransactionId,
    ...currencyInfo(row.currency),
    amountMinor: minorToString(row.amountMinor),
    reason: row.reason,
    status: row.status,
    gatewayResponse: row.gatewayResponse ?? null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedById: row.resolvedById,
  };
}

export function serializeReconciliationPage(rows: ReconciliationRow[], total: number, page: Page) {
  return { data: rows.map(serializeReconciliation), page: pageInfo(page, total) };
}

/** `executed: false`: refunds are recorded, never sent to the gateway, in this phase. */
export function serializeRefundRequest(
  row: RefundRequest,
  capability: (gateway: string) => RefundCapability,
) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    bookingItemId: row.bookingItemId,
    paymentReconciliationId: row.paymentReconciliationId,
    gateway: row.gateway,
    gatewayRefundCapability: capability(row.gateway),
    ...currencyInfo(row.currency),
    amountMinor: minorToString(row.amountMinor),
    reason: row.reason,
    status: row.status,
    executed: false,
    requestedById: row.requestedById,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeRefundRequestPage(
  rows: RefundRequest[],
  total: number,
  page: Page,
  capability: (gateway: string) => RefundCapability,
) {
  return {
    data: rows.map((row) => serializeRefundRequest(row, capability)),
    page: pageInfo(page, total),
  };
}

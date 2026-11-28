import type { RefundRequest } from "../../generated/prisma/client.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { pageInfo, type Page } from "../../lib/pagination.js";
import type { RefundCapability } from "../../lib/payment-gateways/index.js";
import { maskReference } from "../../domain/payouts.js";
import type { ReconciliationRow, RefundRow } from "./refunds.service.js";

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

/**
 * A refund as the admin queue shows it (ADR 0020). `executed` = the money went back (COMPLETED).
 * The gateway's refund reference is returned masked; the gateway's raw answer is not returned.
 */
export function serializeRefundRequest(
  row: RefundRequest & Partial<Pick<RefundRow, "payment" | "bookingItem">>,
  capability: (gateway: string) => RefundCapability,
) {
  return {
    id: row.id,
    paymentId: row.paymentId,
    bookingItemId: row.bookingItemId,
    paymentReconciliationId: row.paymentReconciliationId,
    trip: row.payment ? { id: row.payment.trip.id, reference: row.payment.trip.reference } : null,
    item: row.bookingItem
      ? {
          id: row.bookingItem.id,
          title: row.bookingItem.listing.title,
          status: row.bookingItem.status,
          paymentStatus: row.bookingItem.paymentStatus,
          payoutStatus: row.bookingItem.payoutStatus,
        }
      : null,
    gateway: row.gateway,
    gatewayRefundCapability: capability(row.gateway),
    ...currencyInfo(row.currency),
    amountMinor: minorToString(row.amountMinor),
    reason: row.reason,
    status: row.status,
    executed: row.status === "COMPLETED",
    executionMode: row.executionMode,
    attempts: row.attempts,
    gatewayRefundReferenceMasked: maskReference(row.gatewayRefundReference),
    note: row.note,
    failureReason: row.failureReason,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    executedById: row.executedById,
    completedById: row.completedById,
    rejectedById: row.rejectedById,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    processingAt: row.processingAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
  };
}

export function serializeRefundRequestPage(
  rows: RefundRow[],
  total: number,
  page: Page,
  capability: (gateway: string) => RefundCapability,
) {
  return {
    data: rows.map((row) => serializeRefundRequest(row, capability)),
    page: pageInfo(page, total),
  };
}

/** The result of an execution step: the refund, and whether this call changed it. */
export function serializeRefundChange(
  result: { refund: RefundRow; changed: boolean },
  capability: (gateway: string) => RefundCapability,
) {
  return { data: serializeRefundRequest(result.refund, capability), changed: result.changed };
}

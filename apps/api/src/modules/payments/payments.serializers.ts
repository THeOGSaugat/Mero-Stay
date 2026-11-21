import type { DueLine } from "../../domain/payments.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import type { InvoiceWithItems } from "../finance/invoices.service.js";
import type { PaymentWithAllocations } from "./payments.repository.js";
import type { PaymentConfirmation, PaymentIntent, SettledItem } from "./payments.service.js";

/**
 * Payment and invoice response shapes. Every money field is a digit string in minor units next to
 * `currency` and `currencyExponent` (ADR 0005), never a JSON number.
 *
 * The customer view of a payment contains only the customer's own money: what was requested,
 * captured and allocated to each of their items. No commission or provider-payout data (ADR 0006).
 */

export function serializePayment(payment: PaymentWithAllocations) {
  return {
    id: payment.id,
    tripId: payment.tripId,
    kind: payment.kind,
    gateway: payment.gateway,
    status: payment.status,
    ...currencyInfo(payment.currency),
    amountMinor: minorToString(payment.amountMinor),
    capturedMinor: minorToString(payment.capturedMinor),
    gatewayTransactionId: payment.gatewayTransactionId,
    allocations: payment.allocations.map((a) => ({
      itemId: a.bookingItemId,
      amountMinor: minorToString(a.amountMinor),
    })),
    createdAt: payment.createdAt.toISOString(),
    completedAt: payment.completedAt?.toISOString() ?? null,
  };
}

function serializeDue(lines: readonly DueLine[]) {
  return {
    lines: lines.map((line) => ({ itemId: line.itemId, dueMinor: minorToString(line.dueMinor) })),
    totalDueMinor: minorToString(lines.reduce((sum, line) => sum + line.dueMinor, 0n)),
  };
}

export function serializeIntent(intent: PaymentIntent) {
  return {
    data: {
      created: intent.created,
      ...currencyInfo(intent.payment.currency),
      payment: serializePayment(intent.payment),
      due: serializeDue(intent.lines),
    },
  };
}

export function serializeConfirmation(confirmation: PaymentConfirmation) {
  return {
    data: {
      replayed: confirmation.replayed,
      payment: serializePayment(confirmation.payment),
    },
  };
}

export function serializePaymentList(currency: string, payments: PaymentWithAllocations[]) {
  return { data: { ...currencyInfo(currency), payments: payments.map(serializePayment) } };
}

export function serializeSettlement(tripId: string, items: SettledItem[]) {
  return {
    data: {
      tripId,
      items: items.map((item) => ({
        id: item.id,
        status: item.status,
        paymentMethod: "pay_at_property" as const,
        paymentStatus: item.paymentStatus,
        changed: item.changed,
      })),
    },
  };
}

/** ADMIN view: invoices are MeroStay ↔ provider data, so commission figures are included. */
export function serializeInvoices(invoices: InvoiceWithItems[]) {
  return {
    data: invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      tripId: invoice.tripId,
      provider: { id: invoice.provider.id, name: invoice.provider.displayName },
      ...currencyInfo(invoice.currency),
      amountMinor: minorToString(invoice.amountMinor),
      issuedAt: invoice.issuedAt?.toISOString() ?? null,
      dueOn: invoice.dueOn ? invoice.dueOn.toISOString().slice(0, 10) : null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      items: invoice.bookingItems.map((item) => ({
        id: item.id,
        listingId: item.listingId,
        listingType: item.listingTypeCode,
        paymentStatus: item.paymentStatus,
        commissionStatus: item.commissionStatus,
        subtotalMinor: minorToString(item.subtotalMinor),
        commissionRateBps: item.commissionRateBps,
        commissionMinor: minorToString(item.commissionMinor),
      })),
    })),
  };
}

import { randomBytes } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  PAY_AT_PROPERTY_STATUSES,
  assertCommissionTransition,
} from "../../domain/booking-item-status.js";
import { todayInKathmandu } from "../../domain/dates.js";
import { draftInvoices, invoiceNumber } from "../../domain/invoices.js";

/**
 * Commission invoices for pay-at-property items (ADR 0007). The provider collects the customer's
 * money on arrival, so MeroStay invoices the provider for the commission.
 *
 * Creation rule: when a trip is confirmed, every confirmed pay-at-property item whose commission is
 * still PENDING is invoiced, one invoice per (trip, provider), and its commission becomes INVOICED
 * in the same transaction. Provider-facing invoice endpoints arrive with the partner dashboards;
 * this phase has an internal (admin) read only.
 */

/** Items that have been booked and can be invoiced (not drafts, not cancelled/expired). */
const INVOICEABLE_ITEM_STATUSES = ["CONFIRMED", "IN_PROGRESS", "COMPLETED"] as const;

export interface IssuedInvoice {
  id: string;
  number: string;
  providerId: string;
  amountMinor: bigint;
  itemIds: string[];
}

/**
 * Issues the missing commission invoices for one trip. Must run inside the transaction that holds
 * the trip's row lock.
 *
 * Idempotent: it only picks items with commission PENDING and no invoice, so a second call finds
 * nothing and creates nothing. The partial unique index `provider_invoices_one_live_per_trip_provider`
 * makes a second live invoice for the same trip and provider impossible even if this were bypassed,
 * and a trigger rejects issuing an invoice whose amount differs from its items' commission.
 */
export async function issueCommissionInvoices(
  tx: Prisma.TransactionClient,
  tripId: string,
  issuedAt: Date,
): Promise<IssuedInvoice[]> {
  const items = await tx.bookingItem.findMany({
    where: {
      tripId,
      status: { in: [...INVOICEABLE_ITEM_STATUSES] },
      paymentStatus: { in: [...PAY_AT_PROPERTY_STATUSES] },
      commissionStatus: "PENDING",
      commissionInvoiceId: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      providerId: true,
      currency: true,
      commissionMinor: true,
      commissionStatus: true,
      paymentStatus: true,
    },
  });
  for (const item of items) {
    assertCommissionTransition(item.commissionStatus, "INVOICED", item.paymentStatus);
  }

  const issued: IssuedInvoice[] = [];
  for (const draft of draftInvoices(items)) {
    // Trips cannot gain items after confirmation (MVP), so a live invoice for this provider means
    // the data is inconsistent: fail loudly rather than issue a second invoice.
    const existing = await tx.providerInvoice.findFirst({
      where: { tripId, providerId: draft.providerId, status: { not: "VOID" } },
      select: { id: true },
    });
    if (existing) {
      throw new Error(`trip ${tripId} already has a live invoice for provider ${draft.providerId}`);
    }

    const invoice = await tx.providerInvoice.create({
      data: {
        number: invoiceNumber(todayInKathmandu(issuedAt), randomBytes(8)),
        providerId: draft.providerId,
        tripId,
        status: "DRAFT",
        currency: draft.currency,
        amountMinor: draft.amountMinor,
        // Payment terms (due date) are a business decision still open: left empty.
      },
      select: { id: true, number: true },
    });
    const linked = await tx.bookingItem.updateMany({
      where: { id: { in: draft.itemIds }, commissionStatus: "PENDING", commissionInvoiceId: null },
      data: { commissionStatus: "INVOICED", commissionInvoiceId: invoice.id },
    });
    if (linked.count !== draft.itemIds.length) {
      throw new Error(`invoice ${invoice.number}: expected ${draft.itemIds.length} items`);
    }
    // DRAFT → ISSUED: the database checks amount = sum of the linked items' commission here.
    await tx.providerInvoice.update({
      where: { id: invoice.id },
      data: { status: "ISSUED", issuedAt },
    });
    issued.push({
      ...invoice,
      providerId: draft.providerId,
      amountMinor: draft.amountMinor,
      itemIds: draft.itemIds,
    });
  }
  return issued;
}

export const INVOICE_INCLUDE = {
  provider: { select: { id: true, displayName: true } },
  bookingItems: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      listingId: true,
      listingTypeCode: true,
      subtotalMinor: true,
      commissionRateBps: true,
      commissionMinor: true,
      commissionStatus: true,
      paymentStatus: true,
    },
  },
} satisfies Prisma.ProviderInvoiceInclude;

export type InvoiceWithItems = Prisma.ProviderInvoiceGetPayload<{
  include: typeof INVOICE_INCLUDE;
}>;

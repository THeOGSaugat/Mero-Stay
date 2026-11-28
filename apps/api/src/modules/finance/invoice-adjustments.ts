import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Commission waived on an item of an ISSUED invoice (ADR 0018): the invoice never changes; an
 * append-only adjustment records what is no longer owed (owed = amount − adjustments), and an
 * invoice adjusted in full becomes VOID. Used by admin voids and customer cancellations (Phase 14).
 * Must run in the caller's transaction, after the item's commission became WAIVED.
 */
export async function adjustInvoiceForWaivedItem(
  tx: Prisma.TransactionClient,
  item: { id: string; commissionInvoiceId: string; commissionMinor: bigint; currency: string },
  reason: string,
  actorUserId: string | null,
): Promise<void> {
  await tx.providerInvoiceAdjustment.create({
    data: {
      invoiceId: item.commissionInvoiceId,
      bookingItemId: item.id,
      amountMinor: item.commissionMinor,
      currency: item.currency,
      reason: reason.slice(0, 500),
      createdById: actorUserId,
    },
  });
  const invoice = await tx.providerInvoice.findUniqueOrThrow({
    where: { id: item.commissionInvoiceId },
    include: { adjustments: { select: { amountMinor: true } } },
  });
  const adjusted = invoice.adjustments.reduce((sum, a) => sum + a.amountMinor, 0n);
  if (adjusted === invoice.amountMinor && invoice.status === "ISSUED") {
    await tx.providerInvoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });
  }
}

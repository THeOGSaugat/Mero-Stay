import type { Prisma } from "../../generated/prisma/client.js";
import type { BookingItemStatus, PaymentStatus } from "../../generated/prisma/enums.js";
import { assertPaymentTransition, isPayAtProperty } from "../../domain/booking-item-status.js";
import { AppError } from "../../lib/errors.js";

/**
 * Recording that a pay-at-property item was paid on arrival (ADR 0007/0008). Shared by the admin
 * path and the partner path: PAY_AT_PROPERTY → PAID_AT_PROPERTY with who and when. No money moves
 * through MeroStay; the commission stays INVOICED (the provider still owes it).
 * Idempotent by state: an already settled item is returned unchanged.
 */

export const SETTLEABLE_ITEM_STATUSES: readonly BookingItemStatus[] = [
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
];

export interface SettleableItem {
  id: string;
  status: BookingItemStatus;
  paymentStatus: PaymentStatus;
}

export interface SettlementResult {
  id: string;
  status: BookingItemStatus;
  paymentStatus: PaymentStatus;
  changed: boolean;
}

export async function settleItemAtProperty(
  tx: Prisma.TransactionClient,
  item: SettleableItem,
  actorUserId: string,
  at: Date,
): Promise<SettlementResult> {
  if (!isPayAtProperty(item.paymentStatus)) {
    throw new AppError(
      422,
      "ITEM_NOT_PAY_AT_PROPERTY",
      "Only pay-at-property items can be settled at the property.",
      { itemId: item.id },
    );
  }
  if (item.paymentStatus === "PAID_AT_PROPERTY") return { ...item, changed: false };
  if (!SETTLEABLE_ITEM_STATUSES.includes(item.status)) {
    throw new AppError(409, "ITEM_NOT_CONFIRMED", `Item is ${item.status}.`, {
      itemId: item.id,
      status: item.status,
    });
  }
  assertPaymentTransition(item.paymentStatus, "PAID_AT_PROPERTY");
  const updated = await tx.bookingItem.update({
    where: { id: item.id },
    data: {
      paymentStatus: "PAID_AT_PROPERTY",
      paymentSettledAt: at,
      paymentSettledById: actorUserId,
    },
    select: { id: true, status: true, paymentStatus: true },
  });
  return { ...updated, changed: true };
}

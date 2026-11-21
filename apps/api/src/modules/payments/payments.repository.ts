import type { Prisma } from "../../generated/prisma/client.js";
import type { PayableItem } from "../../domain/payments.js";
import type { Db } from "../listings/listings.repository.js";

/** Prisma queries for payments and allocations. No business rules here (see payments.service.ts). */

export const OPEN_PAYMENT_STATUSES = ["INITIATED", "PENDING"] as const;

export const PAYMENT_INCLUDE = {
  allocations: {
    orderBy: [{ bookingItem: { createdAt: "asc" } }, { bookingItemId: "asc" }],
    select: { bookingItemId: true, amountMinor: true },
  },
} satisfies Prisma.PaymentInclude;

export type PaymentWithAllocations = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

export interface DueItem extends PayableItem {
  status: string;
  paymentStatus: "UNPAID" | "PARTIALLY_PAID";
}

/**
 * The trip's online items still waiting for money (PENDING, UNPAID or PARTIALLY_PAID), in a
 * stable order (created, id), each with what succeeded charges have already allocated to it.
 */
export async function findDueItems(
  tx: Prisma.TransactionClient,
  tripId: string,
): Promise<DueItem[]> {
  const items = await tx.bookingItem.findMany({
    where: { tripId, status: "PENDING", paymentStatus: { in: ["UNPAID", "PARTIALLY_PAID"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      currency: true,
      totalMinor: true,
      allocations: {
        where: { payment: { kind: "CHARGE", status: "SUCCEEDED" } },
        select: { amountMinor: true },
      },
    },
  });
  return items.map((item) => ({
    id: item.id,
    status: item.status,
    paymentStatus: item.paymentStatus as DueItem["paymentStatus"],
    currency: item.currency,
    totalMinor: item.totalMinor,
    allocatedMinor: item.allocations.reduce((sum, a) => sum + a.amountMinor, 0n),
  }));
}

export async function findOpenCharge(tx: Prisma.TransactionClient, tripId: string) {
  return tx.payment.findFirst({
    where: { tripId, kind: "CHARGE", status: { in: [...OPEN_PAYMENT_STATUSES] } },
    include: PAYMENT_INCLUDE,
  });
}

/** A charge of THIS trip, or null (a payment id from another trip is treated as missing). */
export async function findChargeInTrip(db: Db, tripId: string, paymentId: string) {
  return db.payment.findFirst({
    where: { id: paymentId, tripId, kind: "CHARGE" },
    include: PAYMENT_INCLUDE,
  });
}

export async function listTripPayments(db: Db, tripId: string) {
  return db.payment.findMany({
    where: { tripId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: PAYMENT_INCLUDE,
  });
}

export async function countPendingItems(tx: Prisma.TransactionClient, tripId: string) {
  return tx.bookingItem.count({ where: { tripId, status: "PENDING" } });
}

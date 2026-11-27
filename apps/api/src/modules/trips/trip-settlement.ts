import type { Prisma } from "../../generated/prisma/client.js";
import { recalculateTripTotals } from "./trips.repository.js";

/**
 * A trip after some of its items were voided or cancelled (Phase 12, reused by customer
 * cancellations in Phase 14): totals = its active items; nothing active → CANCELLED; nothing pending
 * → CONFIRMED. Open payment intents no longer match the amount due, so they are cancelled (late
 * money is reconciled, ADR 0017). Runs in the caller's transaction, with the trip locked.
 */
export async function settleTripAfterCancellations(
  tx: Prisma.TransactionClient,
  tripId: string,
  at: Date,
): Promise<void> {
  const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId } });
  const items = await tx.bookingItem.findMany({ where: { tripId }, select: { status: true } });
  const pending = items.filter((i) => i.status === "PENDING").length;
  const live = items.filter((i) => !["CANCELLED", "EXPIRED"].includes(i.status)).length;
  let extra: Prisma.TripUpdateInput = {};
  if (trip.status === "PENDING" || trip.status === "CONFIRMED") {
    if (live === 0) extra = { status: "CANCELLED", cancelledAt: at, expiresAt: null };
    else if (pending === 0)
      extra = { status: "CONFIRMED", confirmedAt: trip.confirmedAt ?? at, expiresAt: null };
  }
  await recalculateTripTotals(tx, trip, extra);
  await tx.payment.updateMany({
    where: { tripId, kind: "CHARGE", status: { in: ["INITIATED", "PENDING"] } },
    data: { status: "CANCELLED", completedAt: at },
  });
}

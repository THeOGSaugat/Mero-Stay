/**
 * Clawbacks of paid-out bookings (gap 39, ADR 0020; owner decision 2026-11-27). Pure, unit-tested.
 *
 * When an admin voids a booking whose payout was already PAID, the customer is refunded and the
 * provider owes back what that batch paid for the item (its line: kept amount − commission). Past
 * payouts are never edited: a clawback is recorded and DEDUCTED from the provider's next batches
 * when they are scheduled, oldest clawback first. A batch never goes below zero; whatever does not
 * fit stays outstanding for the next batch.
 */

export interface OutstandingClawback {
  id: string;
  /** Still to recover = amount − deductions in SCHEDULED or PAID batches. */
  outstandingMinor: bigint;
}

export interface Deduction {
  clawbackId: string;
  amountMinor: bigint;
}

/**
 * What to deduct from a batch whose net before deductions is `availableMinor`. Clawbacks are taken
 * in the order given (the caller passes them oldest first).
 */
export function planDeductions(
  availableMinor: bigint,
  clawbacks: readonly OutstandingClawback[],
): Deduction[] {
  if (availableMinor < 0n) throw new RangeError("available must not be negative");
  let left = availableMinor;
  const deductions: Deduction[] = [];
  for (const clawback of clawbacks) {
    if (left === 0n) break;
    if (clawback.outstandingMinor <= 0n) continue;
    const take = clawback.outstandingMinor < left ? clawback.outstandingMinor : left;
    deductions.push({ clawbackId: clawback.id, amountMinor: take });
    left -= take;
  }
  return deductions;
}

/** What a voided paid-out item's provider owes back: its line in the paid batch. */
export function clawbackAmount(line: {
  totalMinor: bigint;
  refundedMinor: bigint;
  commissionMinor: bigint;
  keptCommissionMinor: bigint | null;
}): bigint {
  return line.totalMinor - line.refundedMinor - (line.keptCommissionMinor ?? line.commissionMinor);
}

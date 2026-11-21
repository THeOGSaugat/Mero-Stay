import { createHash } from "node:crypto";

/**
 * Pure rules for online payments (ADR 0007): what is due, how a captured amount is split across
 * booking items, and which payment status each item ends up in. No database, no HTTP.
 *
 * Amounts are `bigint` minor units. The database re-checks the same rules with guard triggers
 * (allocations never exceed the payment or the item; an item is PAID only when fully allocated),
 * so a bug here is rejected at write time instead of being stored.
 */

export interface PayableItem {
  id: string;
  currency: string;
  /** What the customer owes for the item (subtotal + service charge + tax). */
  totalMinor: bigint;
  /** Sum of allocations from SUCCEEDED charges so far. */
  allocatedMinor: bigint;
}

export interface DueLine {
  itemId: string;
  dueMinor: bigint;
}

export interface AllocationLine {
  itemId: string;
  amountMinor: bigint;
}

export type OnlinePaymentStatus = "UNPAID" | "PARTIALLY_PAID" | "PAID";

function assertNonNegative(name: string, value: bigint): void {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be a bigint (minor units)`);
  if (value < 0n) throw new RangeError(`${name} must not be negative, got ${value}`);
}

/** Still to pay on one item. Throws if more was allocated than the item costs (corrupt data). */
export function outstandingMinor(item: PayableItem): bigint {
  assertNonNegative("totalMinor", item.totalMinor);
  assertNonNegative("allocatedMinor", item.allocatedMinor);
  if (item.allocatedMinor > item.totalMinor) {
    throw new RangeError(`item ${item.id} is over-allocated`);
  }
  return item.totalMinor - item.allocatedMinor;
}

/**
 * Lines still to pay, in the given (stable) order; fully paid items are left out. Every item must
 * be in `currency`: one currency per trip (MVP).
 */
export function dueLines(currency: string, items: readonly PayableItem[]): DueLine[] {
  const lines: DueLine[] = [];
  for (const item of items) {
    if (item.currency !== currency) {
      throw new RangeError(`item ${item.id} is in ${item.currency}, payment is in ${currency}`);
    }
    const dueMinor = outstandingMinor(item);
    if (dueMinor > 0n) lines.push({ itemId: item.id, dueMinor });
  }
  return lines;
}

export function totalDue(lines: readonly DueLine[]): bigint {
  return lines.reduce((sum, line) => sum + line.dueMinor, 0n);
}

/**
 * Splits a captured amount across due lines in order, filling each line before the next. The
 * result never gives a line more than it is due and never sums to more than was captured. A
 * partial capture fully pays the first items and leaves the rest partially paid or unpaid.
 */
export function planAllocation(lines: readonly DueLine[], capturedMinor: bigint): AllocationLine[] {
  assertNonNegative("capturedMinor", capturedMinor);
  if (capturedMinor > totalDue(lines)) {
    throw new RangeError("captured amount exceeds the amount due");
  }
  const allocations: AllocationLine[] = [];
  let remaining = capturedMinor;
  for (const line of lines) {
    if (remaining === 0n) break;
    const amountMinor = line.dueMinor < remaining ? line.dueMinor : remaining;
    allocations.push({ itemId: line.itemId, amountMinor });
    remaining -= amountMinor;
  }
  return allocations;
}

/** An online item's payment status from its total and what has been allocated to it. */
export function onlinePaymentStatus(
  totalMinor: bigint,
  allocatedMinor: bigint,
): OnlinePaymentStatus {
  assertNonNegative("totalMinor", totalMinor);
  assertNonNegative("allocatedMinor", allocatedMinor);
  if (allocatedMinor > totalMinor) throw new RangeError("allocated more than the item total");
  if (allocatedMinor === totalMinor) return "PAID";
  return allocatedMinor === 0n ? "UNPAID" : "PARTIALLY_PAID";
}

/**
 * Identity of a payment intent: the trip, the currency and exactly which items it covers for how
 * much. Two requests with the same fingerprint are the same intent, so the open one is returned
 * instead of a second charge. Order-independent; any change in an item or amount changes it.
 */
export function intentFingerprint(
  tripId: string,
  currency: string,
  lines: readonly DueLine[],
): string {
  const canonical = [...lines]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((line) => `${line.itemId}=${line.dueMinor.toString()}`)
    .join(",");
  return createHash("sha256").update(`charge:v1|${tripId}|${currency}|${canonical}`).digest("hex");
}

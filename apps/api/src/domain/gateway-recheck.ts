/**
 * When to ask eSewa/Khalti again about a payment that closed without money (Phase 12, gap 33,
 * ADR 0018). Neither gateway calls MeroStay back, and a customer can still finish paying on a page
 * that is open (Khalti links last 60 minutes; eSewa's form has no documented expiry). So each such
 * payment is looked up a few times after it closed; money found is recorded for reconciliation.
 */

/** Minutes after the payment closed: 5 min, 65 min (past Khalti's link expiry), 6 h, 25 h. */
export const RECHECK_OFFSETS_MINUTES = [5, 65, 6 * 60, 25 * 60] as const;

/** The time of the next check, or null when every check has been done. */
export function nextRecheckAt(closedAt: Date, checksDone: number): Date | null {
  const offset = RECHECK_OFFSETS_MINUTES[checksDone];
  return offset === undefined ? null : new Date(closedAt.getTime() + offset * 60_000);
}

/** Payments closed longer ago than this are never picked up (the last check is at 25 h). */
export const RECHECK_WINDOW_MS = 26 * 60 * 60_000;

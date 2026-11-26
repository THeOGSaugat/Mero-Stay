/**
 * Cancellation policies in plain words (ADR 0015, gap 23). Pure, so it is unit-tested.
 *
 * The API sends the structured rule: refund tiers `{ minHoursBeforeStart, refundBps }` ordered by
 * hours (decreasing), or `nonRefundable` with no tiers. A listing shows the policy that applies
 * NOW; a booking shows its frozen copy ("as booked"). Nothing here computes a refund amount:
 * refunds are a later phase, and the UI computes no money.
 */

export interface CancellationTier {
  minHoursBeforeStart: number;
  refundBps: number;
}

/** What both a current policy and a frozen snapshot carry (older snapshots may lack fields). */
export interface PolicyTerms {
  name?: string;
  description?: string;
  nonRefundable?: boolean;
  rules?: unknown[];
  source?: "listing" | "provider";
  capturedAt?: string;
}

export const NO_POLICY_LISTING =
  "No cancellation policy is set for this listing. Ask the provider about cancellations before you book.";
export const NO_POLICY_BOOKING = "No cancellation policy was attached to this booking.";

function isTier(value: unknown): value is CancellationTier {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CancellationTier).minHoursBeforeStart === "number" &&
    typeof (value as CancellationTier).refundBps === "number"
  );
}

/** The valid tiers, in the order sent (the API keeps them ordered). */
export function tiersOf(terms: PolicyTerms): CancellationTier[] {
  return (terms.rules ?? []).filter(isTier);
}

/** 72 → "72 hours (3 days)", 24 → "24 hours (1 day)", 6 → "6 hours", 1 → "1 hour". */
export function hoursText(hours: number): string {
  const h = `${hours} hour${hours === 1 ? "" : "s"}`;
  if (hours >= 24 && hours % 24 === 0) {
    const d = hours / 24;
    return `${h} (${d} day${d === 1 ? "" : "s"})`;
  }
  return h;
}

/** 10000 → "100%", 5000 → "50%", 2550 → "25.5%". A rate, not money. */
export function refundText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** One line per tier, then what happens after the last one. */
export function termLines(terms: PolicyTerms): string[] {
  if (terms.nonRefundable) return ["No refund if you cancel, at any time."];
  const tiers = tiersOf(terms);
  if (tiers.length === 0) return [];
  const lines = tiers.map((t) =>
    t.minHoursBeforeStart === 0
      ? `Cancel any time before the start: ${refundText(t.refundBps)} refund.`
      : `Cancel at least ${hoursText(t.minHoursBeforeStart)} before the start: ${refundText(t.refundBps)} refund.`,
  );
  const last = tiers[tiers.length - 1];
  if (last) {
    lines.push(
      last.minHoursBeforeStart === 0
        ? "After the start: no refund."
        : `Later than that: no refund.`,
    );
  }
  return lines;
}

/** One sentence for a listing card or a booking line. */
export function policySummary(terms: PolicyTerms): string {
  if (terms.nonRefundable) return "Non-refundable.";
  const tiers = tiersOf(terms);
  const first = tiers[0];
  if (!first) return "See the cancellation terms.";
  if (first.refundBps === 10_000) {
    return first.minHoursBeforeStart === 0
      ? "Free cancellation until the start."
      : `Free cancellation until ${hoursText(first.minHoursBeforeStart)} before the start.`;
  }
  return `Up to ${refundText(first.refundBps)} refund if you cancel at least ${hoursText(first.minHoursBeforeStart)} before the start.`;
}

/** Where the current policy came from (listing pages only). */
export function sourceLabel(source: PolicyTerms["source"]): string | null {
  if (source === "listing") return "This listing's policy";
  if (source === "provider") return "The provider's standard policy";
  return null;
}

// ------------------------------------------------------------------ the partner's tier editor

export interface TierDraft {
  hours: string;
  percent: string;
}

/**
 * The editor's rows → API tiers, or the first problem in words. Mirrors the API's rule so the
 * partner sees mistakes before sending (the API checks again and has the last word).
 */
export function tiersFromDraft(
  rows: readonly TierDraft[],
): { ok: true; tiers: CancellationTier[] } | { ok: false; message: string } {
  if (rows.length === 0) {
    return { ok: false, message: "Add at least one refund tier, or mark it non-refundable." };
  }
  const tiers: CancellationTier[] = [];
  for (const [i, row] of rows.entries()) {
    const n = i + 1;
    if (!/^\d{1,4}$/.test(row.hours.trim())) {
      return { ok: false, message: `Tier ${n}: hours must be a whole number.` };
    }
    const hours = Number(row.hours.trim());
    if (hours > 8760) return { ok: false, message: `Tier ${n}: at most 8760 hours (one year).` };
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(row.percent.trim())) {
      return { ok: false, message: `Tier ${n}: refund must be a percentage like 50 or 12.5.` };
    }
    const [whole = "0", fraction = ""] = row.percent.trim().split(".");
    const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (bps < 1 || bps > 10_000) {
      return { ok: false, message: `Tier ${n}: refund must be from 0.01% to 100%.` };
    }
    const prev = tiers[i - 1];
    if (prev && hours >= prev.minHoursBeforeStart) {
      return { ok: false, message: `Tier ${n}: hours must be fewer than in tier ${i}.` };
    }
    if (prev && bps > prev.refundBps) {
      return { ok: false, message: `Tier ${n}: the refund cannot be more than in tier ${i}.` };
    }
    tiers.push({ minHoursBeforeStart: hours, refundBps: bps });
  }
  return { ok: true, tiers };
}

/** API tiers → editor rows (for editing an existing policy). */
export function draftFromTiers(tiers: readonly CancellationTier[]): TierDraft[] {
  return tiers.map((t) => ({
    hours: String(t.minHoursBeforeStart),
    percent: refundText(t.refundBps).slice(0, -1),
  }));
}

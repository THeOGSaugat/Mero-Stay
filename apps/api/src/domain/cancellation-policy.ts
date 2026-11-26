/**
 * Cancellation policies (ADR 0015, gap 23). Pure rules, shared by the API and its tests.
 *
 * A policy is data a partner writes: a name, a description and a structured rule.
 * - **Tiers:** "cancel at least N hours before the start to get X% back", ordered by hours
 *   (strictly decreasing) with refunds never increasing. Cancelling later than the last tier gets
 *   nothing. A first tier at 100% is the free-cancellation window.
 * - **Non-refundable:** no tiers at all.
 *
 * Nothing here computes a refund: refunds are a later phase. The database re-checks the same shape
 * (`cancellation_rules_valid`).
 */

export interface CancellationTier {
  minHoursBeforeStart: number;
  /** 1–10000 (basis points of the item total). */
  refundBps: number;
}

export interface CancellationRule {
  nonRefundable: boolean;
  tiers: CancellationTier[];
}

export const MAX_TIERS = 10;
export const MAX_HOURS_BEFORE_START = 8760; // one year

/** Problems with a rule, as human-readable messages (empty = valid). Mirrors the SQL check. */
export function cancellationRuleProblems(rule: CancellationRule): string[] {
  const { nonRefundable, tiers } = rule;
  if (nonRefundable) {
    return tiers.length === 0 ? [] : ["a non-refundable policy has no refund tiers"];
  }
  const problems: string[] = [];
  if (tiers.length < 1) problems.push("add at least one refund tier, or mark it non-refundable");
  if (tiers.length > MAX_TIERS) problems.push(`at most ${MAX_TIERS} refund tiers`);
  tiers.forEach((tier, i) => {
    const at = `tier ${i + 1}`;
    if (
      !Number.isInteger(tier.minHoursBeforeStart) ||
      tier.minHoursBeforeStart < 0 ||
      tier.minHoursBeforeStart > MAX_HOURS_BEFORE_START
    ) {
      problems.push(`${at}: hours must be a whole number from 0 to ${MAX_HOURS_BEFORE_START}`);
    }
    if (!Number.isInteger(tier.refundBps) || tier.refundBps < 1 || tier.refundBps > 10_000) {
      problems.push(`${at}: refund must be from 0.01% to 100%`);
    }
    const prev = tiers[i - 1];
    if (prev) {
      if (tier.minHoursBeforeStart >= prev.minHoursBeforeStart) {
        problems.push(`${at}: hours must be fewer than the tier before`);
      }
      if (tier.refundBps > prev.refundBps) {
        problems.push(`${at}: refund cannot be more than the tier before (less notice, less back)`);
      }
    }
  });
  return problems;
}

/** The fields a resolved policy needs (a Prisma row or a test object). */
export interface PolicyRecord {
  id: string;
  name: string;
  description: string;
  rules: unknown;
  nonRefundable: boolean;
  isActive: boolean;
}

export type PolicySource = "listing" | "provider";

export interface ResolvedPolicy<P extends PolicyRecord = PolicyRecord> {
  policy: P;
  /** Where it came from: the listing's own policy, or the provider's default. */
  source: PolicySource;
}

/**
 * Which policy applies to a listing: the listing's own (if active), else the provider's default
 * (if active), else none. The database never lets an inactive policy stay attached, so the
 * `isActive` checks are a second line of defence, not the rule.
 */
export function resolveCancellationPolicy<P extends PolicyRecord>(
  listingPolicy: P | null | undefined,
  providerDefault: P | null | undefined,
): ResolvedPolicy<P> | null {
  if (listingPolicy?.isActive) return { policy: listingPolicy, source: "listing" };
  if (providerDefault?.isActive) return { policy: providerDefault, source: "provider" };
  return null;
}

/** The frozen copy stored on a booking item. Later edits of the policy never change it. */
export interface CancellationSnapshot {
  policyId: string;
  name: string;
  description: string;
  nonRefundable: boolean;
  rules: unknown;
  source: PolicySource;
  capturedAt: string;
}

export function cancellationSnapshot(
  resolved: ResolvedPolicy,
  capturedAt: Date,
): CancellationSnapshot {
  const { policy, source } = resolved;
  return {
    policyId: policy.id,
    name: policy.name,
    description: policy.description,
    nonRefundable: policy.nonRefundable,
    rules: policy.rules,
    source,
    capturedAt: capturedAt.toISOString(),
  };
}

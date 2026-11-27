import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { planDeductions } from "../../domain/clawbacks.js";
import { assertCommissionTransition } from "../../domain/booking-item-status.js";
import { fromDbDate, toDbDate, todayInKathmandu } from "../../domain/dates.js";
import { maskAccountNumber } from "../../domain/masking.js";
import {
  isPayoutMonth,
  maskReference,
  payoutPeriod,
  sumPayout,
  type PayoutBatchStatus,
} from "../../domain/payouts.js";
import { AppError } from "../../lib/errors.js";
import { paginationShape, skipTake } from "../../lib/pagination.js";
import { uuidSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";

/**
 * Payout batches (Phase 12, gap 16, ADR 0018): MeroStay pays providers the online money it holds,
 * net of commission, by a MANUAL bank transfer that an admin then records. Nothing calls a bank.
 *
 * generate (per month) → PENDING batch per provider and currency, holding every eligible item
 * (service over in Nepal time, paid online, not cancelled, no open refund request) → schedule
 * (amounts and items fixed, masked bank account snapshot; needs a verified default account) →
 * mark paid (bank reference) or failed (items released for the next batch). Every step is
 * idempotent and audited; the database re-checks amounts, links and transitions.
 */

const monthSchema = z.string().refine(isPayoutMonth, { error: "must be a month like 2026-11" });

export const generatePayoutsSchema = z.object({ period: monthSchema }).strict();
export const markPaidSchema = z
  .object({ bankReference: z.string().trim().min(3).max(100) })
  .strict();
export const markFailedSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const payoutsListQuerySchema = z
  .object({
    ...paginationShape,
    status: z.enum(["PENDING", "SCHEDULED", "PAID", "FAILED"]).optional(),
    providerId: uuidSchema.optional(),
    period: monthSchema.optional(),
  })
  .strict();
export type PayoutsListQuery = z.infer<typeof payoutsListQuerySchema>;
export const clawbacksQuerySchema = z.object({ providerId: uuidSchema.optional() }).strict();

const PAYOUT_INCLUDE = {
  provider: { select: { id: true, displayName: true } },
} as const;

const ITEM_SELECT = {
  id: true,
  startDate: true,
  endDate: true,
  quantity: true,
  status: true,
  totalMinor: true,
  commissionMinor: true,
  refundedMinor: true,
  keptCommissionMinor: true,
  providerPayoutMinor: true,
  currency: true,
  listing: { select: { id: true, title: true, listingTypeCode: true } },
  trip: { select: { id: true, reference: true } },
} as const;

export type PayoutRow = Prisma.PayoutGetPayload<{ include: typeof PAYOUT_INCLUDE }>;

const CLAWBACK_INCLUDE = {
  provider: { select: { id: true, displayName: true } },
  bookingItem: {
    select: {
      id: true,
      listing: { select: { title: true } },
      trip: { select: { reference: true } },
    },
  },
  recoveries: {
    select: { amountMinor: true, payoutId: true, payout: { select: { status: true } } },
  },
} as const satisfies Prisma.ProviderClawbackInclude;
export type ClawbackRow = Prisma.ProviderClawbackGetPayload<{ include: typeof CLAWBACK_INCLUDE }>;
export interface ClawbackView {
  clawback: ClawbackRow;
  recoveredMinor: bigint;
  outstandingMinor: bigint;
}
export type PayoutItemRow = Prisma.BookingItemGetPayload<{ select: typeof ITEM_SELECT }>;

const TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;
const payoutNotFound = () => new AppError(404, "PAYOUT_NOT_FOUND", "Payout not found.");

/**
 * Items a batch may pay (mirrors isPayoutEligible and booking_items_payout_guard): paid online and
 * live, or cancelled BY THE CUSTOMER with money kept and its refund completed (Phase 14).
 */
const PAYABLE_ITEM_SQL = Prisma.sql`(
  (bi.payment_status = 'PAID' AND bi.status IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW'))
  OR (bi.status = 'CANCELLED' AND bi.cancellation_refund_bps IS NOT NULL AND bi.voided_at IS NULL
      AND bi.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
      AND bi.refunded_minor = bi.cancellation_refund_minor
      AND bi.refunded_minor < bi.total_minor))`;

/** A refund not yet finished holds the item back (its money may still go to the customer). */
const OPEN_REFUND_SQL = Prisma.sql`('REQUESTED', 'APPROVED', 'PROCESSING', 'FAILED')`;

export interface PayoutChange {
  payout: PayoutRow;
  changed: boolean;
}

/** Sets a PENDING batch's sums from its linked items (also used when a void removes an item). */
export async function refreshPayoutSums(
  tx: Prisma.TransactionClient,
  payoutId: string,
): Promise<void> {
  const items = await tx.bookingItem.findMany({
    where: { payoutId },
    select: {
      totalMinor: true,
      commissionMinor: true,
      refundedMinor: true,
      keptCommissionMinor: true,
    },
  });
  // Deductions exist only once the batch is being scheduled (clawback recoveries, Phase 14).
  const deducted = await tx.providerClawbackRecovery.aggregate({
    where: { payoutId },
    _sum: { amountMinor: true },
  });
  const sums = sumPayout(items, deducted._sum.amountMinor ?? 0n);
  await tx.payout.update({
    where: { id: payoutId },
    data: {
      grossMinor: sums.grossMinor,
      commissionMinor: sums.commissionMinor,
      deductionsMinor: sums.deductionsMinor,
      amountMinor: sums.netMinor,
      itemCount: sums.itemCount,
    },
  });
}

export function createPayoutsService({ prisma, now }: { prisma: PrismaClient; now: () => Date }) {
  /** Eligible item ids for a month, grouped by provider and currency (SQL mirrors isPayoutEligible). */
  async function eligibleItems(
    tx: Prisma.TransactionClient,
    period: { start: string; end: string },
    today: string,
  ) {
    return tx.$queryRaw<{ id: string; provider_id: string; currency: string }[]>`
      SELECT bi.id::text AS id, bi.provider_id::text AS provider_id, bi.currency
      FROM booking_items bi
      WHERE bi.start_date BETWEEN ${toDbDate(period.start)}::date AND ${toDbDate(period.end)}::date
        AND bi.payout_status = 'PENDING'
        AND bi.payout_id IS NULL
        AND ${PAYABLE_ITEM_SQL}
        AND COALESCE(bi.end_date - 1, bi.start_date) < ${toDbDate(today)}::date
        AND NOT EXISTS (
          SELECT 1 FROM refund_requests r
          WHERE r.booking_item_id = bi.id AND r.status IN ${OPEN_REFUND_SQL})
      ORDER BY bi.provider_id, bi.currency, bi.start_date, bi.id
      FOR UPDATE OF bi`;
  }

  async function lockPayout(tx: Prisma.TransactionClient, id: string, providerId?: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM payouts WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw payoutNotFound();
    const payout = await tx.payout.findUniqueOrThrow({ where: { id }, include: PAYOUT_INCLUDE });
    if (providerId && payout.providerId !== providerId) throw payoutNotFound();
    return payout;
  }

  /**
   * Builds (or tops up) the PENDING batch of every provider with eligible items in `month`.
   * Running it again adds only newly eligible items; with nothing new it changes nothing.
   */
  async function generate(ctx: AuditContext, month: string): Promise<PayoutChange[]> {
    const period = payoutPeriod(month);
    const today = todayInKathmandu(now());
    return prisma.$transaction(async (tx) => {
      // One generator per month at a time (concurrent clicks, two admins).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`merostay.payouts.${month}`}))`;
      const rows = await eligibleItems(tx, period, today);
      const groups = new Map<string, { providerId: string; currency: string; ids: string[] }>();
      for (const row of rows) {
        const key = `${row.provider_id}|${row.currency}`;
        const group = groups.get(key) ?? {
          providerId: row.provider_id,
          currency: row.currency,
          ids: [],
        };
        group.ids.push(row.id);
        groups.set(key, group);
      }
      const changes: PayoutChange[] = [];
      for (const group of groups.values()) {
        const existing = await tx.payout.findFirst({
          where: {
            providerId: group.providerId,
            currency: group.currency,
            periodStart: toDbDate(period.start),
            status: "PENDING",
          },
        });
        const payout =
          existing ??
          (await tx.payout.create({
            data: {
              providerId: group.providerId,
              currency: group.currency,
              periodStart: toDbDate(period.start),
              periodEnd: toDbDate(period.end),
              amountMinor: 0n,
              createdById: ctx.actorUserId,
            },
          }));
        await tx.bookingItem.updateMany({
          where: { id: { in: group.ids }, payoutId: null },
          data: { payoutId: payout.id },
        });
        await refreshPayoutSums(tx, payout.id);
        const after = await tx.payout.findUniqueOrThrow({
          where: { id: payout.id },
          include: PAYOUT_INCLUDE,
        });
        await recordAudit(tx, ctx, {
          action: existing ? "payout.generate.add" : "payout.generate.create",
          entityType: "payout",
          entityId: payout.id,
          before: existing
            ? { itemCount: existing.itemCount, amountMinor: existing.amountMinor.toString() }
            : null,
          after: {
            period: month,
            providerId: after.providerId,
            currency: after.currency,
            addedItems: group.ids.length,
            itemCount: after.itemCount,
            grossMinor: after.grossMinor.toString(),
            commissionMinor: after.commissionMinor.toString(),
            amountMinor: after.amountMinor.toString(),
          },
        });
        changes.push({ payout: after, changed: true });
      }
      return changes;
    }, TX_OPTIONS);
  }

  /** PENDING → SCHEDULED: fixes items and amounts; needs a verified default bank account. */
  async function schedule(ctx: AuditContext, id: string): Promise<PayoutChange> {
    const today = todayInKathmandu(now());
    return prisma.$transaction(async (tx) => {
      const payout = await lockPayout(tx, id);
      if (payout.status === "SCHEDULED") return { payout, changed: false };
      if (payout.status !== "PENDING") {
        throw new AppError(409, "PAYOUT_NOT_SCHEDULABLE", `This payout is ${payout.status}.`);
      }
      // Items that stopped being eligible since the batch was built (e.g. a refund was requested)
      // leave it before the amounts are fixed.
      const stillEligible = await eligibleIdsIn(tx, payout.id, today);
      await tx.bookingItem.updateMany({
        where: { payoutId: payout.id, id: { notIn: stillEligible } },
        data: { payoutId: null },
      });
      await refreshPayoutSums(tx, payout.id);
      const refreshed = await tx.payout.findUniqueOrThrow({ where: { id } });
      if (refreshed.itemCount === 0) {
        throw new AppError(409, "PAYOUT_EMPTY", "This payout has no items left to pay.");
      }
      const account = await tx.providerPayoutAccount.findFirst({
        where: { providerId: payout.providerId, isDefault: true },
      });
      if (!account || account.verifiedAt === null) {
        throw new AppError(
          409,
          "PAYOUT_ACCOUNT_NOT_VERIFIED",
          "The provider has no verified bank account. Verify it before scheduling a payout.",
        );
      }
      // Clawbacks of paid-out voided bookings (gap 39): deducted now, oldest first, never below 0.
      const deductions = await deductClawbacks(tx, refreshed);
      if (deductions.length > 0) await refreshPayoutSums(tx, payout.id);
      const at = now();
      const updated = await tx.payout.update({
        where: { id },
        data: {
          status: "SCHEDULED",
          scheduledAt: at,
          scheduledById: ctx.actorUserId,
          payoutAccountLabel: `${account.bankName} · ${maskAccountNumber(account.accountNumber)}`,
        },
        include: PAYOUT_INCLUDE,
      });
      await recordAudit(tx, ctx, {
        action: "payout.schedule",
        entityType: "payout",
        entityId: id,
        before: { status: "PENDING" },
        after: {
          status: "SCHEDULED",
          itemCount: updated.itemCount,
          amountMinor: updated.amountMinor.toString(),
          deductionsMinor: updated.deductionsMinor.toString(),
          clawbacksRecovered: deductions.map((d) => ({
            clawbackId: d.clawbackId,
            amountMinor: d.amountMinor.toString(),
          })),
          payoutAccountLabel: updated.payoutAccountLabel,
        },
      });
      return { payout: updated, changed: true };
    }, TX_OPTIONS);
  }

  /** Outstanding clawbacks of the batch's provider and currency, oldest first. */
  async function outstandingClawbacks(
    db: Prisma.TransactionClient | PrismaClient,
    providerId: string,
    currency: string,
  ) {
    const clawbacks = await db.providerClawback.findMany({
      where: { providerId, currency },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        recoveries: { select: { amountMinor: true, payout: { select: { status: true } } } },
      },
    });
    return clawbacks.map((c) => {
      const recovered = c.recoveries
        .filter((r) => r.payout.status === "SCHEDULED" || r.payout.status === "PAID")
        .reduce((sum, r) => sum + r.amountMinor, 0n);
      return {
        clawback: c,
        recoveredMinor: recovered,
        outstandingMinor: c.amountMinor - recovered,
      };
    });
  }

  async function deductClawbacks(
    tx: Prisma.TransactionClient,
    payout: {
      id: string;
      providerId: string;
      currency: string;
      grossMinor: bigint;
      commissionMinor: bigint;
    },
  ) {
    // Lock the provider's clawbacks so two batches never recover the same money.
    await tx.$queryRaw`
      SELECT id FROM provider_clawbacks
      WHERE provider_id = ${payout.providerId}::uuid AND currency = ${payout.currency}
      FOR UPDATE`;
    const open = await outstandingClawbacks(tx, payout.providerId, payout.currency);
    const plan = planDeductions(
      payout.grossMinor - payout.commissionMinor,
      open.map((o) => ({ id: o.clawback.id, outstandingMinor: o.outstandingMinor })),
    );
    for (const deduction of plan) {
      await tx.providerClawbackRecovery.create({
        data: {
          clawbackId: deduction.clawbackId,
          payoutId: payout.id,
          amountMinor: deduction.amountMinor,
        },
      });
    }
    return plan;
  }

  /** Clawbacks (admin: all, or one provider's; partner: their own), with what is still owed. */
  async function listClawbacks(providerId?: string) {
    const rows = await prisma.providerClawback.findMany({
      where: providerId ? { providerId } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: CLAWBACK_INCLUDE,
    });
    return rows.map((c) => {
      const recovered = c.recoveries
        .filter((r) => r.payout.status === "SCHEDULED" || r.payout.status === "PAID")
        .reduce((sum, r) => sum + r.amountMinor, 0n);
      return {
        clawback: c,
        recoveredMinor: recovered,
        outstandingMinor: c.amountMinor - recovered,
      };
    });
  }

  async function eligibleIdsIn(
    tx: Prisma.TransactionClient,
    payoutId: string,
    today: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT bi.id::text AS id FROM booking_items bi
      WHERE bi.payout_id = ${payoutId}::uuid
        AND bi.payout_status = 'PENDING'
        AND ${PAYABLE_ITEM_SQL}
        AND COALESCE(bi.end_date - 1, bi.start_date) < ${toDbDate(today)}::date
        AND NOT EXISTS (
          SELECT 1 FROM refund_requests r
          WHERE r.booking_item_id = bi.id AND r.status IN ${OPEN_REFUND_SQL})
      FOR UPDATE OF bi`;
    return rows.map((row) => row.id);
  }

  /**
   * SCHEDULED → PAID after the admin made the bank transfer: the items are paid out and their
   * commission collected (deducted). The same reference again is a no-op; another one is a 409.
   */
  async function markPaid(
    ctx: AuditContext,
    id: string,
    bankReference: string,
  ): Promise<PayoutChange> {
    return prisma.$transaction(async (tx) => {
      const payout = await lockPayout(tx, id);
      if (payout.status === "PAID") {
        if (payout.reference === bankReference) return { payout, changed: false };
        throw new AppError(409, "PAYOUT_ALREADY_PAID", "This payout was already recorded as paid.");
      }
      if (payout.status !== "SCHEDULED") {
        throw new AppError(
          409,
          "PAYOUT_NOT_SCHEDULED",
          "Schedule the payout before recording it as paid.",
        );
      }
      const at = now();
      const updated = await tx.payout.update({
        where: { id },
        data: { status: "PAID", paidAt: at, paidById: ctx.actorUserId, reference: bankReference },
        include: PAYOUT_INCLUDE,
      });
      const items = await tx.bookingItem.findMany({
        where: { payoutId: id },
        select: { id: true, commissionStatus: true, paymentStatus: true },
      });
      for (const item of items) {
        assertCommissionTransition(item.commissionStatus, "PAID", item.paymentStatus);
      }
      await tx.bookingItem.updateMany({
        where: { payoutId: id },
        data: { payoutStatus: "PAID", commissionStatus: "PAID" },
      });
      await recordAudit(tx, ctx, {
        action: "payout.mark_paid",
        entityType: "payout",
        entityId: id,
        before: { status: "SCHEDULED" },
        after: {
          status: "PAID",
          amountMinor: updated.amountMinor.toString(),
          itemCount: updated.itemCount,
          bankReferenceMasked: maskReference(bankReference),
        },
      });
      return { payout: updated, changed: true };
    }, TX_OPTIONS);
  }

  /** SCHEDULED → FAILED (the transfer bounced): the items become eligible again. */
  async function markFailed(ctx: AuditContext, id: string, reason: string): Promise<PayoutChange> {
    return prisma.$transaction(async (tx) => {
      const payout = await lockPayout(tx, id);
      if (payout.status === "FAILED") return { payout, changed: false };
      if (payout.status !== "SCHEDULED") {
        throw new AppError(409, "PAYOUT_NOT_SCHEDULED", "Only a scheduled payout can fail.");
      }
      const updated = await tx.payout.update({
        where: { id },
        data: { status: "FAILED", failedAt: now(), failureReason: reason },
        include: PAYOUT_INCLUDE,
      });
      const released = await tx.bookingItem.updateMany({
        where: { payoutId: id },
        data: { payoutId: null },
      });
      await recordAudit(tx, ctx, {
        action: "payout.mark_failed",
        entityType: "payout",
        entityId: id,
        before: { status: "SCHEDULED" },
        after: { status: "FAILED", reason, releasedItems: released.count },
      });
      return { payout: updated, changed: true };
    }, TX_OPTIONS);
  }

  async function list(
    query: PayoutsListQuery,
    providerId?: string,
  ): Promise<{ rows: PayoutRow[]; total: number }> {
    const where: Prisma.PayoutWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(providerId ? { providerId } : query.providerId ? { providerId: query.providerId } : {}),
      ...(query.period ? { periodStart: toDbDate(payoutPeriod(query.period).start) } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.payout.findMany({
        where,
        include: PAYOUT_INCLUDE,
        orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        ...skipTake(query),
      }),
      prisma.payout.count({ where }),
    ]);
    return { rows, total };
  }

  /** One payout with its items (partner: own provider only, else 404). */
  async function get(
    id: string,
    providerId?: string,
  ): Promise<{ payout: PayoutRow; items: PayoutItemRow[] }> {
    const payout = await prisma.payout.findUnique({ where: { id }, include: PAYOUT_INCLUDE });
    if (!payout || (providerId && payout.providerId !== providerId)) throw payoutNotFound();
    // A failed batch no longer holds its items; its stored amounts tell what it covered.
    const items = await prisma.bookingItem.findMany({
      where: { payoutId: id },
      select: ITEM_SELECT,
      orderBy: [{ startDate: "asc" }, { id: "asc" }],
    });
    return { payout, items };
  }

  return { generate, schedule, markPaid, markFailed, list, get, listClawbacks };
}

export type PayoutsService = ReturnType<typeof createPayoutsService>;

/** The month a payout covers, as "YYYY-MM". */
export function periodOf(payout: { periodStart: Date }): string {
  return fromDbDate(payout.periodStart).slice(0, 7);
}

export const PAYOUT_STATUSES: readonly PayoutBatchStatus[] = [
  "PENDING",
  "SCHEDULED",
  "PAID",
  "FAILED",
];

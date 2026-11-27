import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { fromDbDate, toDbDate, todayInKathmandu } from "../../domain/dates.js";
import {
  SETTLEMENT_MISMATCH_KINDS,
  settlementMismatches,
  type SettlementMismatchKind,
} from "../../domain/settlement-reconciliation.js";
import { AppError } from "../../lib/errors.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { pageInfo, paginationShape, type Page } from "../../lib/pagination.js";
import { uuidSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";

/**
 * Pay-at-property settlement reconciliation (gap 36, ADR 0020). Admin only.
 *
 * Compares what partners recorded (paid at the property, and when) with what the commission
 * invoices expect, and lists the mismatches (domain/settlement-reconciliation.ts; the SQL below
 * selects the same candidates). An admin looks into each one and records how it was handled:
 * a note per item and mismatch kind, audited, append-only. Nothing moves money; corrections use the
 * existing tools (undo a settlement, void a booking).
 */

export const settlementQuerySchema = z
  .object({
    ...paginationShape,
    state: z.enum(["open", "resolved", "all"]).default("open"),
    kind: z
      .enum(SETTLEMENT_MISMATCH_KINDS as [SettlementMismatchKind, ...SettlementMismatchKind[]])
      .optional(),
  })
  .strict();

export const resolveSettlementSchema = z
  .object({
    kind: z.enum(
      SETTLEMENT_MISMATCH_KINDS as [SettlementMismatchKind, ...SettlementMismatchKind[]],
    ),
    note: z.string().trim().min(1).max(1000),
  })
  .strict();

export const settlementItemParamsSchema = z.object({ itemId: uuidSchema }).strict();

const ITEM_INCLUDE = {
  listing: { select: { title: true } },
  provider: { select: { id: true, displayName: true } },
  trip: { select: { id: true, reference: true } },
  commissionInvoice: { select: { id: true, number: true, status: true } },
  settlementResolutions: true,
} as const satisfies Prisma.BookingItemInclude;

type ItemRow = Prisma.BookingItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

export interface SettlementEntry {
  item: ItemRow;
  kinds: SettlementMismatchKind[];
}

/** At most this many flagged items are considered per request (admins page within them). */
const MAX_CANDIDATES = 2000;

export function createSettlementReconciliationService({
  prisma,
  now,
}: {
  prisma: PrismaClient;
  now: () => Date;
}) {
  /** Items with at least one mismatch today, by SQL (mirrors settlementMismatches). */
  async function candidateIds(today: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT bi.id::text AS id FROM booking_items bi
      WHERE bi.status IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
        AND (
          (bi.payment_status = 'PAY_AT_PROPERTY'
            AND bi.commission_status IN ('INVOICED', 'PAID') AND bi.commission_invoice_id IS NOT NULL
            AND COALESCE(bi.end_date - 1, bi.start_date) < ${toDbDate(today)}::date)
          OR (bi.payment_status = 'PAID_AT_PROPERTY'
            AND (bi.commission_invoice_id IS NULL OR bi.commission_status NOT IN ('INVOICED', 'PAID')))
          OR (bi.payment_status = 'PAID_AT_PROPERTY'
            AND bi.payment_settled_at < bi.service_starts_at))
      ORDER BY bi.start_date, bi.id
      LIMIT ${MAX_CANDIDATES}`);
    return rows.map((r) => r.id);
  }

  function mismatchesOf(item: ItemRow, today: string): SettlementMismatchKind[] {
    return settlementMismatches(
      {
        status: item.status,
        paymentStatus: item.paymentStatus,
        commissionStatus: item.commissionStatus,
        commissionInvoiceId: item.commissionInvoiceId,
        startDate: fromDbDate(item.startDate),
        endDate: item.endDate ? fromDbDate(item.endDate) : null,
        serviceStartsAt: item.serviceStartsAt,
        paymentSettledAt: item.paymentSettledAt,
      },
      today,
    );
  }

  async function list(
    query: z.infer<typeof settlementQuerySchema>,
  ): Promise<{ rows: SettlementEntry[]; total: number }> {
    const today = todayInKathmandu(now());
    const ids = await candidateIds(today);
    const items = await prisma.bookingItem.findMany({
      where: { id: { in: ids } },
      include: ITEM_INCLUDE,
      orderBy: [{ startDate: "asc" }, { id: "asc" }],
    });
    const entries = items
      .map((item) => ({ item, kinds: mismatchesOf(item, today) }))
      .map((entry) => ({
        ...entry,
        kinds: query.kind ? entry.kinds.filter((k) => k === query.kind) : entry.kinds,
      }))
      .filter((entry) => {
        if (entry.kinds.length === 0) return false;
        const resolved = new Set(entry.item.settlementResolutions.map((r) => r.kind));
        const open = entry.kinds.some((k) => !resolved.has(k));
        return query.state === "all" || (query.state === "open" ? open : !open);
      });
    const start = (query.page - 1) * query.pageSize;
    return { rows: entries.slice(start, start + query.pageSize), total: entries.length };
  }

  /** Records how an admin handled one mismatch of one item (once per kind; again = no change). */
  async function resolve(
    ctx: AuditContext,
    itemId: string,
    input: z.infer<typeof resolveSettlementSchema>,
  ): Promise<{ entry: SettlementEntry; changed: boolean }> {
    const today = todayInKathmandu(now());
    const changed = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM booking_items WHERE id = ${itemId}::uuid FOR UPDATE`;
      if (rows.length !== 1) {
        throw new AppError(404, "ITEM_NOT_FOUND", "Booking item not found.");
      }
      const item = await tx.bookingItem.findUniqueOrThrow({
        where: { id: itemId },
        include: ITEM_INCLUDE,
      });
      if (item.settlementResolutions.some((r) => r.kind === input.kind)) return false;
      if (!mismatchesOf(item, today).includes(input.kind)) {
        throw new AppError(
          409,
          "SETTLEMENT_MISMATCH_NOT_FOUND",
          "This item does not have that mismatch (any more).",
          { kind: input.kind },
        );
      }
      await tx.settlementReconciliationResolution.create({
        data: {
          bookingItemId: itemId,
          kind: input.kind,
          note: input.note,
          resolvedById: ctx.actorUserId,
        },
      });
      await recordAudit(tx, ctx, {
        action: "settlement_reconciliation.resolve",
        entityType: "booking_item",
        entityId: itemId,
        before: {
          paymentStatus: item.paymentStatus,
          commissionStatus: item.commissionStatus,
          kind: input.kind,
        },
        after: { kind: input.kind, note: input.note },
      });
      return true;
    });
    const item = await prisma.bookingItem.findUniqueOrThrow({
      where: { id: itemId },
      include: ITEM_INCLUDE,
    });
    return { entry: { item, kinds: mismatchesOf(item, today) }, changed };
  }

  return { list, resolve };
}

export type SettlementReconciliationService = ReturnType<
  typeof createSettlementReconciliationService
>;

export function serializeSettlementEntry({ item, kinds }: SettlementEntry) {
  const resolutions = new Map(item.settlementResolutions.map((r) => [r.kind, r]));
  return {
    itemId: item.id,
    trip: { id: item.trip.id, reference: item.trip.reference },
    listing: { title: item.listing.title },
    provider: { id: item.provider.id, name: item.provider.displayName },
    status: item.status,
    startDate: fromDbDate(item.startDate),
    endDate: item.endDate ? fromDbDate(item.endDate) : null,
    serviceStartsAt: item.serviceStartsAt.toISOString(),
    paymentStatus: item.paymentStatus,
    paymentSettledAt: item.paymentSettledAt?.toISOString() ?? null,
    commissionStatus: item.commissionStatus,
    invoice: item.commissionInvoice
      ? {
          id: item.commissionInvoice.id,
          number: item.commissionInvoice.number,
          status: item.commissionInvoice.status,
        }
      : null,
    ...currencyInfo(item.currency),
    totalMinor: minorToString(item.totalMinor),
    commissionMinor: minorToString(item.commissionMinor),
    mismatches: kinds.map((kind) => {
      const resolution = resolutions.get(kind);
      return {
        kind,
        resolution: resolution
          ? {
              note: resolution.note,
              resolvedAt: resolution.resolvedAt.toISOString(),
              resolvedById: resolution.resolvedById,
            }
          : null,
      };
    }),
  };
}

export function serializeSettlementPage(rows: SettlementEntry[], total: number, page: Page) {
  return { data: rows.map(serializeSettlementEntry), page: pageInfo(page, total) };
}

import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { paginationShape, skipTake, likePattern, searchShape } from "../../lib/pagination.js";
import { isoDateSchema, uuidSchema } from "../../lib/validation.js";
import { INVOICE_INCLUDE } from "./invoices.service.js";

/**
 * Read-only finance views for partners (own provider) and admins (all providers), ADR 0008.
 *
 * Payout summary: what MeroStay will owe providers for online-paid items (it holds that money).
 * Nothing is paid out here: payout execution is a later phase. Per item the payout is the stored
 * `provider_payout_minor` = total − commission (Phase 2 formula, CHECK-enforced): the provider
 * receives the service charge and VAT collected for them. Pay-at-property items are not in the
 * summary (the provider already holds the money; their commission is invoiced instead).
 *
 * "Period" groups items by the calendar month of their service start date. It is a reporting
 * grouping only; the payout schedule is an open owner decision.
 */

export const invoicesQuerySchema = z
  .object({
    ...paginationShape,
    status: z.enum(["DRAFT", "ISSUED", "PAID", "VOID"]).optional(),
    /** issued_at range [from, to), dates in UTC. */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict();

export const adminInvoicesQuerySchema = invoicesQuerySchema.extend({
  providerId: uuidSchema.optional(),
  /** Invoice number or provider name (gap 25). */
  ...searchShape,
});

export const payoutsQuerySchema = z
  .object({
    ...paginationShape,
    /** Service start date range [from, to). */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict();

export const adminPayoutsQuerySchema = payoutsQuerySchema.extend({
  providerId: uuidSchema.optional(),
  /** Provider name (gap 25). */
  ...searchShape,
});

export interface PayoutSummaryRow {
  providerId: string;
  providerName: string;
  period: string;
  currency: string;
  items: number;
  subtotalMinor: bigint;
  serviceChargeMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  commissionMinor: bigint;
  providerPayoutMinor: bigint;
}

export function createFinanceService({ prisma }: { prisma: PrismaClient }) {
  async function listInvoices(
    query: z.infer<typeof invoicesQuerySchema> & { q?: string },
    providerId: string | undefined,
  ) {
    const contains = query.q ? { contains: query.q, mode: "insensitive" as const } : undefined;
    const where: Prisma.ProviderInvoiceWhereInput = {
      ...(providerId ? { providerId } : {}),
      ...(contains ? { OR: [{ number: contains }, { provider: { displayName: contains } }] } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            issuedAt: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lt: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [invoices, total] = await Promise.all([
      prisma.providerInvoice.findMany({
        where,
        include: INVOICE_INCLUDE,
        // Newest first (gap 25); `id` keeps pages stable.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...skipTake(query),
      }),
      prisma.providerInvoice.count({ where }),
    ]);
    return { invoices, total };
  }

  async function payoutSummary(
    query: z.infer<typeof payoutsQuerySchema> & { q?: string },
    providerId: string | undefined,
  ): Promise<{ rows: PayoutSummaryRow[]; total: number }> {
    const filters = [
      Prisma.sql`bi.payment_status = 'PAID'`,
      Prisma.sql`bi.payout_status = 'PENDING'`,
      Prisma.sql`bi.payout_id IS NULL`,
      Prisma.sql`bi.status IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW')`,
      ...(providerId ? [Prisma.sql`bi.provider_id = ${providerId}::uuid`] : []),
      ...(query.from ? [Prisma.sql`bi.start_date >= ${query.from}::date`] : []),
      ...(query.to ? [Prisma.sql`bi.start_date < ${query.to}::date`] : []),
      ...(query.q ? [Prisma.sql`p.display_name ILIKE ${likePattern(query.q)}`] : []),
    ];
    const where = Prisma.join(filters, " AND ");
    const grouped = Prisma.sql`
      SELECT bi.provider_id::text AS "providerId", p.display_name AS "providerName",
             to_char(bi.start_date, 'YYYY-MM') AS period, bi.currency,
             COUNT(*)::int AS items,
             SUM(bi.subtotal_minor)::bigint AS "subtotalMinor",
             SUM(bi.service_charge_minor)::bigint AS "serviceChargeMinor",
             SUM(bi.tax_minor)::bigint AS "taxMinor",
             SUM(bi.total_minor)::bigint AS "totalMinor",
             SUM(bi.commission_minor)::bigint AS "commissionMinor",
             SUM(bi.provider_payout_minor)::bigint AS "providerPayoutMinor"
      FROM booking_items bi
      JOIN providers p ON p.id = bi.provider_id
      WHERE ${where}
      GROUP BY bi.provider_id, p.display_name, period, bi.currency`;
    const { skip, take } = skipTake(query);
    const [rows, counted] = await Promise.all([
      prisma.$queryRaw<PayoutSummaryRow[]>`
        SELECT * FROM (${grouped}) g
        ORDER BY g.period, g."providerName", g."providerId", g.currency
        LIMIT ${take} OFFSET ${skip}`,
      prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM (${grouped}) g`,
    ]);
    return { rows, total: counted[0]?.n ?? 0 };
  }

  return { listInvoices, payoutSummary };
}

export type FinanceService = ReturnType<typeof createFinanceService>;

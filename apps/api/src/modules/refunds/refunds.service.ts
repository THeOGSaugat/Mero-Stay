import { z } from "zod";
import type {
  PaymentReconciliation,
  PrismaClient,
  RefundRequest,
} from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { skipTake, paginationShape } from "../../lib/pagination.js";
import type {
  GatewayName,
  PaymentGatewayAdapter,
  RefundCapability,
} from "../../lib/payment-gateways/index.js";
import { minorAmountInputSchema, uuidSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";

/**
 * Late payments to reconcile (gap 8) and refund requests (ADR 0017). Admin only (the routes
 * enforce the role). Refunds are NOT executed: a request records what should go back to the
 * customer; the database keeps it REQUESTED or REJECTED and never above what was paid. Executing
 * refunds (the gateway call, REFUND payments) is the Cancellations & refunds phase.
 */

export const reconciliationsQuerySchema = z
  .object({ ...paginationShape, status: z.enum(["OPEN", "RESOLVED"]).optional() })
  .strict();

export const refundRequestsQuerySchema = z
  .object({ ...paginationShape, paymentId: uuidSchema.optional() })
  .strict();

export const resolveReconciliationSchema = z
  .object({ note: z.string().trim().min(1).max(1000) })
  .strict();

export const createRefundRequestSchema = z
  .object({
    paymentId: uuidSchema,
    /** The booking item whose online payment is refunded… */
    bookingItemId: uuidSchema.optional(),
    /** …or a late payment that was never applied. Exactly one of the two. */
    paymentReconciliationId: uuidSchema.optional(),
    amountMinor: minorAmountInputSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((v) => (v.bookingItemId === undefined) !== (v.paymentReconciliationId === undefined), {
    error: "give either bookingItemId or paymentReconciliationId",
    path: ["bookingItemId"],
  });

const RECONCILIATION_INCLUDE = { trip: { select: { reference: true } } } as const;

export type ReconciliationRow = PaymentReconciliation & { trip: { reference: string } };

export function createRefundsService({
  prisma,
  gateways,
}: {
  prisma: PrismaClient;
  gateways: Partial<Record<GatewayName, PaymentGatewayAdapter>>;
}) {
  /** What the payment's gateway offers for refunds (informational; nothing is executed). */
  function refundCapability(gateway: string): RefundCapability {
    return (
      gateways[gateway as GatewayName]?.refundCapability ?? {
        api: "none",
        partial: false,
        note: "This gateway is not enabled on this server.",
      }
    );
  }

  async function listReconciliations(
    query: z.infer<typeof reconciliationsQuerySchema>,
  ): Promise<{ rows: ReconciliationRow[]; total: number }> {
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      prisma.paymentReconciliation.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: RECONCILIATION_INCLUDE,
        ...skipTake(query),
      }),
      prisma.paymentReconciliation.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Marks a late payment as handled, with a note (e.g. "refunded by hand", "applied to a new
   * trip"). Audited. The gateway's record itself never changes (database guard).
   */
  async function resolveReconciliation(
    ctx: AuditContext,
    id: string,
    note: string,
  ): Promise<ReconciliationRow> {
    return prisma.$transaction(async (tx) => {
      const current = await tx.paymentReconciliation.findUnique({ where: { id } });
      if (!current) throw new AppError(404, "RECONCILIATION_NOT_FOUND", "Late payment not found.");
      if (current.status !== "OPEN") {
        throw new AppError(409, "RECONCILIATION_ALREADY_RESOLVED", "This is already resolved.");
      }
      const resolved = await tx.paymentReconciliation.update({
        where: { id },
        data: { status: "RESOLVED", note, resolvedAt: new Date(), resolvedById: ctx.actorUserId },
        include: RECONCILIATION_INCLUDE,
      });
      await recordAudit(tx, ctx, {
        action: "payment_reconciliation.resolve",
        entityType: "payment_reconciliation",
        entityId: id,
        before: { status: current.status },
        after: { status: resolved.status, note },
      });
      return resolved;
    });
  }

  async function listRefundRequests(
    query: z.infer<typeof refundRequestsQuerySchema>,
  ): Promise<{ rows: RefundRequest[]; total: number }> {
    const where = query.paymentId ? { paymentId: query.paymentId } : {};
    const [rows, total] = await Promise.all([
      prisma.refundRequest.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...skipTake(query),
      }),
      prisma.refundRequest.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Records a refund request (audited). Checked here first, and again by the database: the
   * payment is a charge; the amount is at most what this payment allocated to the item (or what
   * the late payment recorded), minus earlier open requests.
   */
  async function createRefundRequest(
    ctx: AuditContext,
    input: z.infer<typeof createRefundRequestSchema>,
  ): Promise<RefundRequest> {
    const { amountMinor } = input;
    return prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
      if (!payment || payment.kind !== "CHARGE") {
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
      }
      let available: bigint;
      let alreadyRequested: bigint;
      if (input.bookingItemId) {
        const allocation = await tx.paymentAllocation.findUnique({
          where: {
            paymentId_bookingItemId: { paymentId: payment.id, bookingItemId: input.bookingItemId },
          },
        });
        if (!allocation) {
          throw new AppError(
            422,
            "REFUND_EXCEEDS_PAID",
            "This payment paid nothing for that item.",
          );
        }
        available = allocation.amountMinor;
        const earlier = await tx.refundRequest.aggregate({
          where: {
            paymentId: payment.id,
            bookingItemId: input.bookingItemId,
            status: { not: "REJECTED" },
          },
          _sum: { amountMinor: true },
        });
        alreadyRequested = earlier._sum.amountMinor ?? 0n;
      } else {
        const late = await tx.paymentReconciliation.findFirst({
          where: { id: input.paymentReconciliationId, paymentId: payment.id },
        });
        if (!late) {
          throw new AppError(404, "RECONCILIATION_NOT_FOUND", "Late payment not found.");
        }
        available = late.amountMinor;
        const earlier = await tx.refundRequest.aggregate({
          where: { paymentReconciliationId: late.id, status: { not: "REJECTED" } },
          _sum: { amountMinor: true },
        });
        alreadyRequested = earlier._sum.amountMinor ?? 0n;
      }
      if (alreadyRequested + amountMinor > available) {
        throw new AppError(422, "REFUND_EXCEEDS_PAID", "This is more than was paid.", {
          ...currencyInfo(payment.currency),
          availableMinor: minorToString(available - alreadyRequested),
        });
      }
      const request = await tx.refundRequest.create({
        data: {
          paymentId: payment.id,
          bookingItemId: input.bookingItemId ?? null,
          paymentReconciliationId: input.paymentReconciliationId ?? null,
          gateway: payment.gateway,
          amountMinor,
          currency: payment.currency,
          reason: input.reason,
          requestedById: ctx.actorUserId,
        },
      });
      await recordAudit(tx, ctx, {
        action: "refund_request.create",
        entityType: "refund_request",
        entityId: request.id,
        after: {
          paymentId: payment.id,
          bookingItemId: request.bookingItemId,
          paymentReconciliationId: request.paymentReconciliationId,
          gateway: request.gateway,
          amountMinor: request.amountMinor.toString(),
          currency: request.currency,
          status: request.status,
        },
      });
      return request;
    });
  }

  return {
    listReconciliations,
    resolveReconciliation,
    listRefundRequests,
    createRefundRequest,
    refundCapability,
  };
}

export type RefundsService = ReturnType<typeof createRefundsService>;

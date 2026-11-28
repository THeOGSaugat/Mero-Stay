import { z } from "zod";
import type {
  PaymentReconciliation,
  Prisma,
  PrismaClient,
  RefundRequest,
} from "../../generated/prisma/client.js";
import { assertPaymentTransition } from "../../domain/booking-item-status.js";
import { maskReference } from "../../domain/payouts.js";
import { canMoveRefund, paymentStatusAfterRefunds } from "../../domain/refunds.js";
import { AppError } from "../../lib/errors.js";
import { currencyInfo, minorToString } from "../../lib/money-json.js";
import { skipTake, paginationShape } from "../../lib/pagination.js";
import {
  GatewayError,
  type GatewayName,
  type GatewayRefundRequest,
  type PaymentGatewayAdapter,
  type RefundCapability,
} from "../../lib/payment-gateways/index.js";
import { minorAmountInputSchema, uuidSchema } from "../../lib/validation.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";

/**
 * Late payments to reconcile (gap 8) and refunds (ADR 0017; executed since Phase 14, ADR 0020).
 * Admin only (the routes enforce the role).
 *
 * A refund request records what goes back to a customer (never above what was paid; database
 * guard). Execution:
 *   approve (REQUESTED → APPROVED) → execute (→ PROCESSING, committed BEFORE the gateway is called)
 *   → Khalti: the refund API; success → COMPLETED, definite refusal → FAILED (retry allowed),
 *     unknown outcome (time-out, 5xx) → stays PROCESSING until `check` asks Khalti's lookup;
 *   → eSewa (no refund API): stays PROCESSING (MANUAL) until an admin refunds in the eSewa
 *     merchant portal and records the reference (complete).
 *   reject (REQUESTED | APPROVED | FAILED → REJECTED, with a note).
 * Completing a refund adds it to the item's refunded amount and payment status (database-checked:
 * refunded = completed refunds). Every step is idempotent and audited (no secrets). One refund per
 * payment is in flight at a time (partial unique index), so the gateway is never asked twice at
 * once about one charge; a second execute of the same refund never calls the gateway again.
 */

export const reconciliationsQuerySchema = z
  .object({ ...paginationShape, status: z.enum(["OPEN", "RESOLVED"]).optional() })
  .strict();

export const REFUND_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "REJECTED",
] as const;

export const refundRequestsQuerySchema = z
  .object({
    ...paginationShape,
    paymentId: uuidSchema.optional(),
    status: z.enum(REFUND_STATUSES).optional(),
  })
  .strict();

export const rejectRefundSchema = z.object({ note: z.string().trim().min(1).max(1000) }).strict();
export const completeRefundSchema = z
  .object({
    /** The gateway's refund reference (eSewa merchant portal), stored as given. */
    reference: z.string().trim().min(3).max(200),
    note: z.string().trim().min(1).max(1000).optional(),
  })
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

/** What the admin queue shows with a refund: its trip and item (no customer contact details). */
export const REFUND_INCLUDE = {
  payment: { select: { trip: { select: { id: true, reference: true } } } },
  bookingItem: {
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      payoutStatus: true,
      listing: { select: { title: true } },
    },
  },
} as const satisfies Prisma.RefundRequestInclude;

export type RefundRow = Prisma.RefundRequestGetPayload<{ include: typeof REFUND_INCLUDE }>;

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
const refundNotFound = () => new AppError(404, "REFUND_NOT_FOUND", "Refund request not found.");

export function createRefundsService({
  prisma,
  gateways,
  now = () => new Date(),
}: {
  prisma: PrismaClient;
  gateways: Partial<Record<GatewayName, PaymentGatewayAdapter>>;
  now?: () => Date;
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
  ): Promise<{ rows: RefundRow[]; total: number }> {
    const where: Prisma.RefundRequestWhereInput = {
      ...(query.paymentId ? { paymentId: query.paymentId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.refundRequest.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: REFUND_INCLUDE,
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

  // ------------------------------------------------------------------ execution (Phase 14)

  async function lockRefund(tx: Prisma.TransactionClient, id: string): Promise<RefundRequest> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM refund_requests WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw refundNotFound();
    return tx.refundRequest.findUniqueOrThrow({ where: { id } });
  }

  async function getRefund(id: string): Promise<RefundRow> {
    const row = await prisma.refundRequest.findUnique({ where: { id }, include: REFUND_INCLUDE });
    if (!row) throw refundNotFound();
    return row;
  }

  function notAllowed(current: RefundRequest, action: string): AppError {
    return new AppError(
      409,
      "REFUND_NOT_ALLOWED",
      `This refund is ${current.status}; it cannot be ${action}.`,
      { status: current.status },
    );
  }

  /** REQUESTED → APPROVED. Again: no change. */
  async function approve(
    ctx: AuditContext,
    id: string,
  ): Promise<{ refund: RefundRow; changed: boolean }> {
    const changed = await prisma.$transaction(async (tx) => {
      const current = await lockRefund(tx, id);
      if (current.status !== "REQUESTED") {
        if (["APPROVED", "PROCESSING", "COMPLETED", "FAILED"].includes(current.status))
          return false;
        throw notAllowed(current, "approved");
      }
      await tx.refundRequest.update({
        where: { id },
        data: { status: "APPROVED", approvedAt: now(), approvedById: ctx.actorUserId },
      });
      await audit(tx, ctx, "refund_request.approve", current, { status: "APPROVED" });
      return true;
    }, TX_OPTIONS);
    return { refund: await getRefund(id), changed };
  }

  /** REQUESTED | APPROVED | FAILED → REJECTED (nothing goes back through MeroStay). */
  async function reject(
    ctx: AuditContext,
    id: string,
    note: string,
  ): Promise<{ refund: RefundRow; changed: boolean }> {
    const changed = await prisma.$transaction(async (tx) => {
      const current = await lockRefund(tx, id);
      if (current.status === "REJECTED") return false;
      if (!canMoveRefund(current.status, "REJECTED")) throw notAllowed(current, "rejected");
      await tx.refundRequest.update({
        where: { id },
        data: { status: "REJECTED", rejectedAt: now(), rejectedById: ctx.actorUserId, note },
      });
      await audit(tx, ctx, "refund_request.reject", current, { status: "REJECTED", note });
      return true;
    }, TX_OPTIONS);
    return { refund: await getRefund(id), changed };
  }

  /**
   * APPROVED | FAILED → PROCESSING, committed first; then the gateway's refund API (Khalti) is
   * called once, or the refund waits for an admin to make it by hand (eSewa). A refund already
   * PROCESSING or COMPLETED is returned as it is: the gateway is never asked twice.
   */
  async function execute(
    ctx: AuditContext,
    id: string,
  ): Promise<{ refund: RefundRow; changed: boolean }> {
    const started = await prisma.$transaction(async (tx) => {
      const current = await lockRefund(tx, id);
      if (current.status === "PROCESSING" || current.status === "COMPLETED") return null;
      if (current.status !== "APPROVED" && current.status !== "FAILED") {
        throw notAllowed(current, "executed");
      }
      await assertItemRefundable(tx, current);
      const inFlight = await tx.refundRequest.count({
        where: { paymentId: current.paymentId, status: "PROCESSING" },
      });
      if (inFlight > 0) {
        throw new AppError(
          409,
          "REFUND_IN_PROGRESS",
          "Another refund of this payment is being processed. Finish it first.",
        );
      }
      const adapter = gateways[current.gateway as GatewayName];
      const mode = adapter?.refund ? "API" : "MANUAL";
      await tx.refundRequest.update({
        where: { id },
        data: {
          status: "PROCESSING",
          processingAt: now(),
          executedById: ctx.actorUserId,
          executionMode: mode,
          attempts: { increment: 1 },
          ...(mode === "MANUAL" ? { note: manualNote(current.gateway) } : {}),
        },
      });
      await audit(tx, ctx, "refund_request.execute", current, {
        status: "PROCESSING",
        executionMode: mode,
        attempt: current.attempts + 1,
      });
      return { current, mode, adapter } as const;
    }, TX_OPTIONS);
    if (!started) return { refund: await getRefund(id), changed: false };
    if (started.mode === "MANUAL" || !started.adapter?.refund) {
      return { refund: await getRefund(id), changed: true };
    }

    // The gateway call runs outside any transaction (it may take seconds).
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: started.current.paymentId },
    });
    const request = await refundRequestFor(started.current, payment);
    try {
      const result = await started.adapter.refund(request);
      await prisma.$transaction(async (tx) => {
        const current = await lockRefund(tx, id);
        if (current.status !== "PROCESSING") return;
        await completeLocked(tx, ctx, current, result.reference, null, result.raw, "api");
      }, TX_OPTIONS);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      await prisma.$transaction(async (tx) => {
        const current = await lockRefund(tx, id);
        if (current.status !== "PROCESSING") return;
        if (err.code === "GATEWAY_REJECTED") {
          await failLocked(tx, ctx, current, err.message);
        } else {
          // Unknown outcome: Khalti may or may not have refunded. Stay PROCESSING; `check` settles it.
          await tx.refundRequest.update({
            where: { id },
            data: { gatewayResponse: { outcome: "unknown", reason: err.code } },
          });
          await audit(tx, ctx, "refund_request.execute.unknown", current, {
            status: "PROCESSING",
            reason: err.code,
          });
        }
      }, TX_OPTIONS);
    }
    return { refund: await getRefund(id), changed: true };
  }

  /**
   * A refund made by hand (eSewa merchant portal), or one an admin confirmed in the gateway's
   * portal after an uncertain API call: PROCESSING → COMPLETED with the gateway's reference. The
   * same reference again is a no-op; another one is a 409.
   */
  async function complete(
    ctx: AuditContext,
    id: string,
    input: z.infer<typeof completeRefundSchema>,
  ): Promise<{ refund: RefundRow; changed: boolean }> {
    const changed = await prisma.$transaction(async (tx) => {
      const current = await lockRefund(tx, id);
      if (current.status === "COMPLETED") {
        if (current.gatewayRefundReference === input.reference) return false;
        throw new AppError(409, "REFUND_ALREADY_COMPLETED", "This refund was already completed.");
      }
      if (current.status !== "PROCESSING") throw notAllowed(current, "marked completed");
      await completeLocked(tx, ctx, current, input.reference, input.note ?? null, null, "manual");
      return true;
    }, TX_OPTIONS);
    return { refund: await getRefund(id), changed };
  }

  /**
   * Settles a PROCESSING API refund whose outcome was unknown by asking the gateway's lookup
   * (Khalti documents no refund status endpoint). Refunded → COMPLETED; still fully paid → FAILED
   * (safe to retry); anything ambiguous stays PROCESSING for an admin to confirm in the portal.
   */
  async function check(
    ctx: AuditContext,
    id: string,
  ): Promise<{ refund: RefundRow; changed: boolean }> {
    const current = await prisma.refundRequest.findUnique({ where: { id } });
    if (!current) throw refundNotFound();
    if (current.status !== "PROCESSING" || current.executionMode !== "API") {
      return { refund: await getRefund(id), changed: false };
    }
    const adapter = gateways[current.gateway as GatewayName];
    if (!adapter?.checkRefund) return { refund: await getRefund(id), changed: false };
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: current.paymentId } });
    const request = await refundRequestFor(current, payment);
    const result = await adapter.checkRefund(request.payment);
    const changed = await prisma.$transaction(async (tx) => {
      const locked = await lockRefund(tx, id);
      if (locked.status !== "PROCESSING") return false;
      const earlier = await tx.refundRequest.count({
        where: { paymentId: locked.paymentId, status: "COMPLETED" },
      });
      if (result.state === "refunded" && earlier === 0 && result.fully === request.full) {
        await completeLocked(
          tx,
          ctx,
          locked,
          (result.reference ?? request.payment.transactionId ?? locked.id).slice(0, 200),
          null,
          result.raw,
          "check",
        );
        return true;
      }
      if (result.state === "not_refunded") {
        await failLocked(tx, ctx, locked, "The gateway shows no refund for this payment.");
        return true;
      }
      await tx.refundRequest.update({
        where: { id },
        data: {
          gatewayResponse: { outcome: "ambiguous", lookup: result.raw } as Prisma.InputJsonObject,
        },
      });
      return false;
    }, TX_OPTIONS);
    return { refund: await getRefund(id), changed };
  }

  // ------------------------------------------------------------------ helpers

  function manualNote(gateway: string): string {
    return gateway === "esewa"
      ? "Refund by hand in the eSewa merchant portal, then record the eSewa reference here."
      : "Refund by hand in the gateway's merchant portal, then record its reference here.";
  }

  /**
   * Money already sent to the provider must not also go back to the customer without a clawback:
   * an item in a SCHEDULED payout waits for that payout; a paid-out item needs a void (gap 39).
   */
  async function assertItemRefundable(tx: Prisma.TransactionClient, refund: RefundRequest) {
    if (!refund.bookingItemId) return;
    const item = await tx.bookingItem.findUniqueOrThrow({
      where: { id: refund.bookingItemId },
      select: {
        payoutStatus: true,
        payout: { select: { status: true } },
        clawback: { select: { id: true } },
      },
    });
    if (item.payout?.status === "SCHEDULED") {
      throw new AppError(
        409,
        "REFUND_ITEM_IN_SCHEDULED_PAYOUT",
        "This item is in a scheduled payout. Record that payout as paid or failed first.",
      );
    }
    if (item.payoutStatus === "PAID" && !item.clawback) {
      throw new AppError(
        409,
        "REFUND_ITEM_PAID_OUT",
        "This item was paid out to the provider. Void the booking first so the payout is clawed back.",
      );
    }
  }

  async function refundRequestFor(
    refund: RefundRequest,
    payment: {
      id: string;
      amountMinor: bigint;
      capturedMinor: bigint;
      gatewayReference: string | null;
      gatewayTransactionId: string | null;
    },
  ): Promise<GatewayRefundRequest> {
    const earlier = await prisma.refundRequest.aggregate({
      where: { paymentId: payment.id, status: "COMPLETED", id: { not: refund.id } },
      _sum: { amountMinor: true },
    });
    const refundedBefore = earlier._sum.amountMinor ?? 0n;
    return {
      refundId: refund.id,
      payment: {
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        gatewayReference: payment.gatewayReference,
        transactionId: payment.gatewayTransactionId,
        capturedMinor: payment.capturedMinor,
      },
      amountMinor: refund.amountMinor,
      full: refundedBefore === 0n && refund.amountMinor === payment.capturedMinor,
    };
  }

  async function completeLocked(
    tx: Prisma.TransactionClient,
    ctx: AuditContext,
    refund: RefundRequest,
    reference: string,
    note: string | null,
    raw: Record<string, unknown> | null,
    how: "api" | "manual" | "check",
  ): Promise<void> {
    await tx.refundRequest.update({
      where: { id: refund.id },
      data: {
        status: "COMPLETED",
        completedAt: now(),
        gatewayRefundReference: reference,
        ...(how === "api" ? {} : { completedById: ctx.actorUserId }),
        ...(note ? { note } : {}),
        ...(raw ? { gatewayResponse: raw as Prisma.InputJsonObject } : {}),
      },
    });
    if (refund.bookingItemId) {
      const item = await tx.bookingItem.findUniqueOrThrow({
        where: { id: refund.bookingItemId },
        select: { refundedMinor: true, paymentStatus: true },
      });
      const paid = await tx.paymentAllocation.aggregate({
        where: {
          bookingItemId: refund.bookingItemId,
          payment: { kind: "CHARGE", status: "SUCCEEDED" },
        },
        _sum: { amountMinor: true },
      });
      const refunded = item.refundedMinor + refund.amountMinor;
      const status = paymentStatusAfterRefunds(paid._sum.amountMinor ?? 0n, refunded);
      // A second partial refund keeps PARTIALLY_REFUNDED: no status change to check.
      if (status !== item.paymentStatus) assertPaymentTransition(item.paymentStatus, status);
      await tx.bookingItem.update({
        where: { id: refund.bookingItemId },
        data: { refundedMinor: refunded, paymentStatus: status },
      });
    }
    await audit(tx, ctx, `refund_request.complete.${how}`, refund, {
      status: "COMPLETED",
      // A bank-style reference is shown masked in the audit (never needed in full there).
      referenceMasked: maskReference(reference),
    });
  }

  async function failLocked(
    tx: Prisma.TransactionClient,
    ctx: AuditContext,
    refund: RefundRequest,
    reason: string,
  ): Promise<void> {
    await tx.refundRequest.update({
      where: { id: refund.id },
      data: { status: "FAILED", failedAt: now(), failureReason: reason.slice(0, 500) },
    });
    await audit(tx, ctx, "refund_request.fail", refund, { status: "FAILED", reason });
  }

  async function audit(
    tx: Prisma.TransactionClient,
    ctx: AuditContext,
    action: string,
    before: RefundRequest,
    after: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(tx, ctx, {
      action,
      entityType: "refund_request",
      entityId: before.id,
      before: {
        status: before.status,
        amountMinor: before.amountMinor.toString(),
        currency: before.currency,
        gateway: before.gateway,
      },
      after,
    });
  }

  return {
    listReconciliations,
    resolveReconciliation,
    listRefundRequests,
    createRefundRequest,
    refundCapability,
    getRefund,
    approve,
    reject,
    execute,
    complete,
    check,
  };
}

export type RefundsService = ReturnType<typeof createRefundsService>;

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { assertItemTransition, assertPaymentTransition } from "../../domain/booking-item-status.js";
import {
  dueLines,
  intentFingerprint,
  onlinePaymentStatus,
  planAllocation,
  totalDue,
  type DueLine,
} from "../../domain/payments.js";
import { AppError } from "../../lib/errors.js";
import { INVOICE_INCLUDE, type InvoiceWithItems } from "../finance/invoices.service.js";
import { recordAudit, type AuditContext } from "../audit/audit.js";
import { lockTrip } from "../trips/trips.repository.js";
import type { PaymentsConfig } from "./payments.config.js";
import {
  PAYMENT_INCLUDE,
  countPendingItems,
  findChargeInTrip,
  findDueItems,
  findOpenCharge,
  listTripPayments,
  type PaymentWithAllocations,
} from "./payments.repository.js";
import type { ConfirmPaymentInput } from "./payments.schemas.js";
import { settleItemAtProperty, type SettlementResult } from "./settlement.js";

/**
 * Online payments and pay-at-property settlement (ADR 0007).
 *
 * Every write runs in one transaction that first row-locks the trip (owner-scoped for customers),
 * so intents and confirmations for one trip happen one after another. On top of that the database
 * guarantees, independently of this code: one open charge per trip (partial unique index), a
 * finished payment never changes, allocations never exceed the captured amount or the item total,
 * and an item's payment status always matches its allocations (guard triggers).
 */

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export interface PaymentsServiceDeps {
  prisma: PrismaClient;
  now: () => Date;
  config: PaymentsConfig;
}

export interface PaymentIntent {
  payment: PaymentWithAllocations;
  /** What this intent pays for: the items still due when it was created or reused. */
  lines: DueLine[];
  /** false when an identical open intent already existed and was returned instead. */
  created: boolean;
}

export interface PaymentConfirmation {
  payment: PaymentWithAllocations;
  /** true when the payment had already succeeded: nothing was changed (idempotent replay). */
  replayed: boolean;
}

export type SettledItem = SettlementResult;

const tripNotFound = () => new AppError(404, "TRIP_NOT_FOUND", "Trip not found.");
const paymentNotFound = () => new AppError(404, "PAYMENT_NOT_FOUND", "Payment not found.");

export function createPaymentsService({ prisma, now, config }: PaymentsServiceDeps) {
  function requireGateway(): NonNullable<PaymentsConfig["gateway"]> {
    if (!config.gateway) {
      throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Online payments are not available.");
    }
    return config.gateway;
  }

  /** Locks the caller's own trip, or 404 (also when it belongs to someone else). */
  async function lockOwnedTrip(tx: Prisma.TransactionClient, tripId: string, ownerId: string) {
    if (!(await lockTrip(tx, tripId, ownerId))) throw tripNotFound();
    return tx.trip.findUniqueOrThrow({ where: { id: tripId } });
  }

  /** Online payment is possible only for a submitted trip (PENDING) whose hold is still valid. */
  function assertAwaitingPayment(trip: { status: string; expiresAt: Date | null }): void {
    if (trip.status === "DRAFT") {
      throw new AppError(409, "TRIP_NOT_CONFIRMED", "Confirm the trip before paying.");
    }
    if (trip.status !== "PENDING") {
      throw new AppError(409, "NOTHING_DUE", `Trip is ${trip.status}; nothing is due online.`, {
        status: trip.status,
      });
    }
    if (trip.expiresAt && trip.expiresAt.getTime() <= now().getTime()) {
      throw new AppError(409, "TRIP_EXPIRED", "This trip's hold has expired. Start a new trip.");
    }
  }

  async function currentDue(tx: Prisma.TransactionClient, trip: { id: string; currency: string }) {
    const items = await findDueItems(tx, trip.id);
    const lines = dueLines(trip.currency, items);
    return { items, lines, fingerprint: intentFingerprint(trip.id, trip.currency, lines) };
  }

  /**
   * Creates the payment intent for everything still due online, or returns the open intent if it
   * covers exactly the same items and amounts (idempotent: repeated or concurrent calls never
   * create a second charge). An open intent that no longer matches is cancelled and replaced.
   */
  async function createIntent(tripId: string, ownerId: string): Promise<PaymentIntent> {
    const gateway = requireGateway();
    return prisma.$transaction(async (tx) => {
      const trip = await lockOwnedTrip(tx, tripId, ownerId);
      assertAwaitingPayment(trip);
      const { lines, fingerprint } = await currentDue(tx, trip);
      if (lines.length === 0) {
        throw new AppError(409, "NOTHING_DUE", "Nothing is due online for this trip.");
      }

      const open = await findOpenCharge(tx, trip.id);
      if (open && open.intentFingerprint === fingerprint && open.gateway === gateway) {
        return { payment: open, lines, created: false };
      }
      if (open) {
        await tx.payment.update({
          where: { id: open.id },
          data: { status: "CANCELLED", completedAt: now() },
        });
      }
      const payment = await tx.payment.create({
        data: {
          tripId: trip.id,
          kind: "CHARGE",
          gateway,
          status: "INITIATED",
          currency: trip.currency,
          amountMinor: totalDue(lines),
          intentFingerprint: fingerprint,
        },
        include: PAYMENT_INCLUDE,
      });
      return { payment, lines, created: true };
    }, TX_OPTIONS);
  }

  /**
   * Records the (simulated) gateway result for an open intent. On success the captured amount is
   * allocated to the due items in order; an item becomes PAID (and CONFIRMED) only when its
   * allocations equal its total, otherwise PARTIALLY_PAID. The trip becomes CONFIRMED when no item
   * is waiting any more.
   *
   * Idempotent: confirming a payment that already succeeded changes nothing and returns it.
   */
  async function confirmPayment(
    tripId: string,
    ownerId: string,
    paymentId: string,
    input: ConfirmPaymentInput,
  ): Promise<PaymentConfirmation> {
    const result = await prisma.$transaction(async (tx) => {
      const trip = await lockOwnedTrip(tx, tripId, ownerId);
      const payment = await findChargeInTrip(tx, trip.id, paymentId);
      if (!payment) throw paymentNotFound();
      if (payment.status === "SUCCEEDED") return { payment, replayed: true };
      if (payment.status !== "INITIATED" && payment.status !== "PENDING") {
        throw new AppError(409, "PAYMENT_NOT_OPEN", `Payment is ${payment.status}.`, {
          status: payment.status,
        });
      }
      const gateway = requireGateway();
      if (payment.gateway !== gateway) {
        throw new AppError(409, "PAYMENT_NOT_OPEN", "Payment belongs to another gateway.");
      }
      assertAwaitingPayment(trip);

      const { items, lines, fingerprint } = await currentDue(tx, trip);
      if (fingerprint !== payment.intentFingerprint) {
        throw new AppError(
          409,
          "PAYMENT_INTENT_STALE",
          "The amount due changed since this payment was started. Create a new payment intent.",
        );
      }

      const completedAt = now();
      const gatewayTransactionId = input.gatewayTransactionId ?? `SIM-${randomUUID()}`;
      if (input.outcome === "failed") {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "FAILED",
            completedAt,
            gatewayTransactionId,
            gatewayResponse: { simulated: true, outcome: "failed" },
          },
        });
        return { payment: await reloadPayment(tx, payment.id), replayed: false };
      }

      const capturedMinor =
        input.capturedAmountMinor === undefined
          ? payment.amountMinor
          : BigInt(input.capturedAmountMinor);
      if (capturedMinor > payment.amountMinor) {
        throw new AppError(
          422,
          "INVALID_CAPTURED_AMOUNT",
          "The captured amount cannot exceed the payment amount.",
        );
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCEEDED",
          capturedMinor,
          completedAt,
          gatewayTransactionId,
          gatewayResponse: {
            simulated: true,
            outcome: "succeeded",
            capturedMinor: capturedMinor.toString(),
          },
        },
      });

      const allocations = planAllocation(lines, capturedMinor);
      // Allocations first: the item status guard checks each new status against them.
      await tx.paymentAllocation.createMany({
        data: allocations.map((a) => ({
          paymentId: payment.id,
          bookingItemId: a.itemId,
          amountMinor: a.amountMinor,
        })),
      });
      for (const allocation of allocations) {
        const item = items.find((candidate) => candidate.id === allocation.itemId);
        if (!item) throw new Error(`allocation for unknown item ${allocation.itemId}`);
        const paymentStatus = onlinePaymentStatus(
          item.totalMinor,
          item.allocatedMinor + allocation.amountMinor,
        );
        if (paymentStatus === item.paymentStatus) continue;
        assertPaymentTransition(item.paymentStatus, paymentStatus);
        if (paymentStatus === "PAID") {
          assertItemTransition("PENDING", "CONFIRMED");
          await tx.bookingItem.update({
            where: { id: item.id },
            data: { paymentStatus, status: "CONFIRMED", confirmedAt: completedAt },
          });
        } else {
          await tx.bookingItem.update({ where: { id: item.id }, data: { paymentStatus } });
        }
      }

      if ((await countPendingItems(tx, trip.id)) === 0) {
        await tx.trip.update({
          where: { id: trip.id },
          data: { status: "CONFIRMED", confirmedAt: completedAt, expiresAt: null },
        });
      }
      return { payment: await reloadPayment(tx, payment.id), replayed: false };
    }, TX_OPTIONS);
    return result;
  }

  async function reloadPayment(tx: Prisma.TransactionClient, id: string) {
    return tx.payment.findUniqueOrThrow({ where: { id }, include: PAYMENT_INCLUDE });
  }

  /** The caller's own trip's payments, or 404. */
  async function listPayments(
    tripId: string,
    ownerId: string,
  ): Promise<{ currency: string; payments: PaymentWithAllocations[] }> {
    const trip = await prisma.trip.findFirst({
      where: { id: tripId, customerId: ownerId },
      select: { id: true, currency: true },
    });
    if (!trip) throw tripNotFound();
    return { currency: trip.currency, payments: await listTripPayments(prisma, trip.id) };
  }

  /**
   * ADMIN ONLY (the route enforces the role): records that the customer paid the provider at the
   * property for these items (shared rule: settlement.ts). Idempotent per item. Writes one audit
   * row per call when something changed (ADR 0008).
   */
  async function settleAtProperty(
    ctx: AuditContext,
    tripId: string,
    itemIds: readonly string[],
  ): Promise<SettledItem[]> {
    return prisma.$transaction(async (tx) => {
      if (!(await lockTrip(tx, tripId))) throw tripNotFound();
      const items = await tx.bookingItem.findMany({
        where: { tripId, id: { in: [...itemIds] } },
        select: { id: true, status: true, paymentStatus: true },
      });
      const missing = itemIds.filter((id) => !items.some((item) => item.id === id));
      if (missing.length > 0) {
        throw new AppError(404, "ITEM_NOT_FOUND", "Booking item not found in this trip.", {
          itemIds: missing,
        });
      }

      const at = now();
      const settled: SettledItem[] = [];
      for (const id of itemIds) {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) throw new Error("unreachable");
        settled.push(await settleItemAtProperty(tx, item, ctx.actorUserId, at));
      }
      const changed = settled.filter((item) => item.changed);
      if (changed.length > 0) {
        await recordAudit(tx, ctx, {
          action: "trip.settle_at_property",
          entityType: "trip",
          entityId: tripId,
          before: {
            items: changed.map((item) => ({ id: item.id, paymentStatus: "PAY_AT_PROPERTY" })),
          },
          after: {
            items: changed.map((item) => ({ id: item.id, paymentStatus: item.paymentStatus })),
            settledAt: at.toISOString(),
          },
        });
      }
      return settled;
    }, TX_OPTIONS);
  }

  /** ADMIN ONLY: the commission invoices of a trip (internal; provider endpoints come later). */
  async function listTripInvoices(tripId: string): Promise<InvoiceWithItems[]> {
    const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { id: true } });
    if (!trip) throw tripNotFound();
    return prisma.providerInvoice.findMany({
      where: { tripId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: INVOICE_INCLUDE,
    });
  }

  return {
    createIntent,
    confirmPayment,
    listPayments,
    settleAtProperty,
    listTripInvoices,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;

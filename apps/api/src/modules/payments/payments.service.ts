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
import { decideGatewayOutcome } from "../../domain/gateway-outcome.js";
import { AppError } from "../../lib/errors.js";
import {
  GatewayError,
  type CheckoutInstruction,
  type GatewayName,
  type GatewayResult,
  type PaymentGatewayAdapter,
} from "../../lib/payment-gateways/index.js";
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
 * Online payments and pay-at-property settlement (ADR 0007; gateways ADR 0017).
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
  /** What the browser does next (a signed form, a redirect, or nothing for simulated). */
  checkout: CheckoutInstruction | null;
}

/** What a verified gateway result did to a payment (ADR 0017). */
export interface GatewayApplication {
  payment: PaymentWithAllocations;
  tripId: string;
  outcome: "paid" | "replayed" | "pending" | "failed" | "expired" | "reconciliation";
  /** Set when money arrived that could not be applied (gap 8). */
  reconciliation: { id: string; reason: string; created: boolean } | null;
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
  /** The enabled adapter for this gateway, or 422 with the gateways that are available. */
  function adapterFor(name: string): PaymentGatewayAdapter {
    const enabled = Object.keys(config.gateways);
    if (enabled.length === 0) {
      throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Online payments are not available.");
    }
    const adapter = config.gateways[name as GatewayName];
    if (!adapter) {
      throw new AppError(
        422,
        "PAYMENT_GATEWAY_NOT_AVAILABLE",
        "This payment method is not available.",
        {
          gateway: name,
          available: enabled,
        },
      );
    }
    return adapter;
  }

  /** Locks the caller's own trip, or 404 (also when it belongs to someone else). */
  async function lockOwnedTrip(tx: Prisma.TransactionClient, tripId: string, ownerId: string) {
    if (!(await lockTrip(tx, tripId, ownerId))) throw tripNotFound();
    return tx.trip.findUniqueOrThrow({ where: { id: tripId } });
  }

  function isAwaitingPayment(trip: { status: string; expiresAt: Date | null }): boolean {
    return (
      trip.status === "PENDING" && (!trip.expiresAt || trip.expiresAt.getTime() > now().getTime())
    );
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
    if (!isAwaitingPayment(trip)) {
      throw new AppError(409, "TRIP_EXPIRED", "This trip's hold has expired. Start a new trip.");
    }
  }

  async function currentDue(tx: Prisma.TransactionClient, trip: { id: string; currency: string }) {
    const items = await findDueItems(tx, trip.id);
    const lines = dueLines(trip.currency, items);
    return { items, lines, fingerprint: intentFingerprint(trip.id, trip.currency, lines) };
  }

  function returnUrls(gateway: GatewayName, paymentId: string) {
    if (gateway === "simulated") {
      return { successUrl: "", failureUrl: "", websiteUrl: "" };
    }
    if (!config.publicWebUrl) {
      throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Online payments are not configured.");
    }
    const base = `${config.publicWebUrl}/payments/${gateway}`;
    return {
      successUrl: `${base}/return/${paymentId}`,
      failureUrl: `${base}/failure/${paymentId}`,
      websiteUrl: config.publicWebUrl,
    };
  }

  /** Gateway errors in API terms (the message never includes what the gateway sent). */
  function gatewayAppError(err: unknown): never {
    if (err instanceof GatewayError) {
      if (err.code === "INVALID_CALLBACK") {
        throw new AppError(
          422,
          "PAYMENT_CALLBACK_INVALID",
          "This payment response could not be verified.",
        );
      }
      if (err.code === "GATEWAY_REJECTED") {
        throw new AppError(422, "PAYMENT_GATEWAY_REJECTED", err.message);
      }
      // The gateway error stays attached for the server log (the client sees only this message).
      throw Object.assign(
        new AppError(
          502,
          "PAYMENT_GATEWAY_UNAVAILABLE",
          "The payment gateway is not answering. Try again in a moment.",
        ),
        { cause: err },
      );
    }
    throw err;
  }

  /**
   * Concurrent intent requests (ADR 0007: they share ONE intent): the first one stores the
   * checkout after the gateway answers; the others wait for it here (at most the gateway's time
   * limit plus a margin) and return the same intent. If it never appears, or the start failed,
   * the caller gets 409 PAYMENT_IN_PROGRESS and can simply retry.
   */
  async function waitForCheckout(
    paymentId: string,
  ): Promise<PaymentWithAllocations & { checkout: CheckoutInstruction }> {
    const deadline = Date.now() + 12_000;
    for (;;) {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: PAYMENT_INCLUDE,
      });
      const open = payment.status === "INITIATED" || payment.status === "PENDING";
      if (open && payment.checkout !== null) {
        return { ...payment, checkout: payment.checkout as CheckoutInstruction };
      }
      if (!open || Date.now() > deadline) {
        throw new AppError(409, "PAYMENT_IN_PROGRESS", "This payment is being started. Try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Creates the payment intent for everything still due online with the chosen gateway, or returns
   * the open intent if it covers exactly the same items and amounts with the same gateway and its
   * checkout is still valid (repeated or concurrent calls never create a second charge). An open
   * intent that no longer matches is cancelled and replaced.
   *
   * The intent is written first (one transaction, trip locked); the gateway is called afterwards
   * (no lock held over the network); its checkout is then stored on the intent.
   */
  async function createIntent(
    tripId: string,
    ownerId: string,
    gatewayName: string,
  ): Promise<PaymentIntent> {
    const adapter = adapterFor(gatewayName);
    const gateway = adapter.name;
    const started = await prisma.$transaction(async (tx) => {
      const trip = await lockOwnedTrip(tx, tripId, ownerId);
      assertAwaitingPayment(trip);
      if (gateway !== "simulated" && trip.currency !== "NPR") {
        throw new AppError(422, "PAYMENT_CURRENCY_NOT_SUPPORTED", "This gateway only accepts NPR.");
      }
      const { lines, fingerprint } = await currentDue(tx, trip);
      if (lines.length === 0) {
        throw new AppError(409, "NOTHING_DUE", "Nothing is due online for this trip.");
      }

      const at = now();
      const open = await findOpenCharge(tx, trip.id);
      if (open && open.intentFingerprint === fingerprint && open.gateway === gateway) {
        const usable =
          open.checkout !== null &&
          (!open.checkoutExpiresAt || open.checkoutExpiresAt.getTime() > at.getTime() + 60_000);
        if (usable) return { reused: true as const, payment: open, lines, trip };
        // Another request created this intent and is fetching its checkout from the gateway
        // (outside the lock): wait for it below and return the same intent.
        if (open.checkout === null && at.getTime() - open.createdAt.getTime() < 30_000) {
          return { reused: "in_progress" as const, paymentId: open.id, lines };
        }
      }
      if (open) {
        await tx.payment.update({
          where: { id: open.id },
          data: { status: "CANCELLED", completedAt: at },
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
      return { reused: false as const, payment, lines, trip };
    }, TX_OPTIONS);

    if (started.reused === "in_progress") {
      const ready = await waitForCheckout(started.paymentId);
      return { payment: ready, lines: started.lines, created: false, checkout: ready.checkout };
    }
    if (started.reused) {
      return {
        payment: started.payment,
        lines: started.lines,
        created: false,
        checkout: started.payment.checkout as CheckoutInstruction | null,
      };
    }

    const { payment, lines, trip } = started;
    let checkout;
    try {
      checkout = await adapter.createCheckout({
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        orderName: `MeroStay trip ${trip.reference}`,
        ...returnUrls(gateway, payment.id),
      });
    } catch (err) {
      // The gateway did not start it: close the intent so a new one can be made.
      await prisma.payment.updateMany({
        where: { id: payment.id, status: "INITIATED" },
        data: { status: "FAILED", completedAt: now(), gatewayResponse: { checkoutFailed: true } },
      });
      gatewayAppError(err);
    }
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "INITIATED" },
      data: {
        gatewayReference: checkout.gatewayReference,
        checkout: checkout.checkout,
        checkoutExpiresAt: checkout.expiresAt,
      },
    });
    const stored = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: PAYMENT_INCLUDE,
    });
    return { payment: stored, lines, created: true, checkout: checkout.checkout };
  }

  /**
   * Allocates a verified capture to the due items in order; an item becomes PAID (and CONFIRMED)
   * only when its allocations equal its total, otherwise PARTIALLY_PAID. The trip becomes
   * CONFIRMED when no item is waiting any more. The caller holds the trip lock.
   */
  async function recordSuccess(
    tx: Prisma.TransactionClient,
    trip: { id: string; currency: string },
    payment: { id: string },
    capturedMinor: bigint,
    gatewayTransactionId: string,
    gatewayResponse: Prisma.InputJsonValue,
  ): Promise<void> {
    const { items, lines } = await currentDue(tx, trip);
    const completedAt = now();
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCEEDED",
        capturedMinor,
        completedAt,
        gatewayTransactionId,
        gatewayResponse,
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
  }

  /**
   * Applies a VERIFIED gateway result to a payment, once, under the trip lock (ADR 0017, gap 8).
   * See decideGatewayOutcome for every case. Repeated results change nothing.
   */
  async function applyGatewayResult(
    paymentId: string,
    result: GatewayResult,
  ): Promise<GatewayApplication> {
    return prisma.$transaction(async (tx) => {
      const first = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      await lockTrip(tx, first.tripId);
      const trip = await tx.trip.findUniqueOrThrow({ where: { id: first.tripId } });
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const open = payment.status === "INITIATED" || payment.status === "PENDING";
      const awaiting = isAwaitingPayment(trip);
      const stale =
        open && awaiting
          ? (await currentDue(tx, trip)).fingerprint !== payment.intentFingerprint
          : false;
      // One key per gateway transaction: what is stored on success and what reconciliation and
      // replays compare (a gateway that sends no transaction id is keyed by its reference).
      const gatewayTransactionId =
        result.transactionId ?? `${payment.gateway}:${result.gatewayReference}`;
      const decision = decideGatewayOutcome({
        result: { ...result, transactionId: gatewayTransactionId },
        payment,
        tripAwaitingPayment: awaiting,
        intentStale: stale,
      });
      const response = result.raw as Prisma.InputJsonValue;
      const at = now();
      let outcome: GatewayApplication["outcome"] = result.status;
      let reconciliation: GatewayApplication["reconciliation"] = null;

      switch (decision.action) {
        case "record_success":
          await recordSuccess(
            tx,
            trip,
            payment,
            payment.amountMinor,
            gatewayTransactionId,
            response,
          );
          outcome = "paid";
          break;
        case "replay":
          outcome = "replayed";
          break;
        case "reconcile": {
          const existing = await tx.paymentReconciliation.findUnique({
            where: {
              gateway_gatewayTransactionId: { gateway: payment.gateway, gatewayTransactionId },
            },
          });
          const row =
            existing ??
            (await tx.paymentReconciliation.create({
              data: {
                paymentId: payment.id,
                tripId: trip.id,
                gateway: payment.gateway,
                gatewayTransactionId,
                amountMinor: result.amountMinor ?? payment.amountMinor,
                currency: payment.currency,
                reason: decision.reason,
                gatewayResponse: response,
              },
            }));
          if (decision.closePaymentAs && open) {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: decision.closePaymentAs, completedAt: at, gatewayResponse: response },
            });
          }
          outcome = "reconciliation";
          reconciliation = { id: row.id, reason: row.reason, created: !existing };
          break;
        }
        case "close":
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: decision.status, completedAt: at, gatewayResponse: response },
          });
          break;
        case "none":
          break;
      }
      return {
        payment: await reloadPayment(tx, payment.id),
        tripId: trip.id,
        outcome,
        reconciliation,
      };
    }, TX_OPTIONS);
  }

  /**
   * The customer's browser came back from the gateway (no session needed: nothing is trusted
   * from it). eSewa: `data` is verified (signature, status API); without it (the failure page)
   * the status API is asked. Khalti: `pidx` names the payment; Khalti's lookup decides.
   */
  async function handleCallback(
    gatewayName: string,
    paymentId: string,
    payload: Record<string, unknown>,
  ): Promise<GatewayApplication> {
    const adapter = adapterFor(gatewayName);
    if (adapter.name === "simulated") {
      throw new AppError(422, "PAYMENT_GATEWAY_NOT_AVAILABLE", "Simulated payments use /confirm.");
    }
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, gateway: adapter.name, kind: "CHARGE" },
    });
    if (!payment) throw paymentNotFound();
    const ref = {
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      gatewayReference: payment.gatewayReference,
    };
    const hasPayload = Object.values(payload).some((v) => v !== undefined && v !== "");
    let result: GatewayResult;
    try {
      result = hasPayload ? await adapter.verifyPayment(ref, payload) : await adapter.lookup(ref);
    } catch (err) {
      gatewayAppError(err);
    }
    return applyGatewayResult(payment.id, result);
  }

  /** The customer asks MeroStay to check with the gateway (server to server) now. */
  async function refreshPayment(
    tripId: string,
    ownerId: string,
    paymentId: string,
  ): Promise<GatewayApplication> {
    const trip = await prisma.trip.findFirst({ where: { id: tripId, customerId: ownerId } });
    if (!trip) throw tripNotFound();
    const payment = await findChargeInTrip(prisma, trip.id, paymentId);
    if (!payment) throw paymentNotFound();
    const adapter = adapterFor(payment.gateway);
    if (adapter.name === "simulated") {
      throw new AppError(
        409,
        "PAYMENT_NOT_OPEN",
        "Simulated payments are confirmed with /confirm.",
      );
    }
    let result: GatewayResult;
    try {
      result = await adapter.lookup({
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        gatewayReference: payment.gatewayReference,
      });
    } catch (err) {
      gatewayAppError(err);
    }
    return applyGatewayResult(payment.id, result);
  }

  /**
   * SIMULATED GATEWAY ONLY (development and tests; refused in production): records the test
   * result for an open intent, standing in for a verified callback. Idempotent: confirming a
   * payment that already succeeded changes nothing and returns it.
   */
  async function confirmPayment(
    tripId: string,
    ownerId: string,
    paymentId: string,
    input: ConfirmPaymentInput,
  ): Promise<PaymentConfirmation> {
    if (Object.keys(config.gateways).length === 0) {
      throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Online payments are not available.");
    }
    return prisma.$transaction(async (tx) => {
      const trip = await lockOwnedTrip(tx, tripId, ownerId);
      const payment = await findChargeInTrip(tx, trip.id, paymentId);
      if (!payment) throw paymentNotFound();
      if (payment.status === "SUCCEEDED") return { payment, replayed: true };
      if (payment.status !== "INITIATED" && payment.status !== "PENDING") {
        throw new AppError(409, "PAYMENT_NOT_OPEN", `Payment is ${payment.status}.`, {
          status: payment.status,
        });
      }
      if (payment.gateway !== "simulated" || !config.gateways.simulated) {
        throw new AppError(
          409,
          "PAYMENT_NOT_OPEN",
          "Only simulated test payments are confirmed this way; real payments are verified with the gateway.",
        );
      }
      assertAwaitingPayment(trip);

      const { fingerprint } = await currentDue(tx, trip);
      if (fingerprint !== payment.intentFingerprint) {
        throw new AppError(
          409,
          "PAYMENT_INTENT_STALE",
          "The amount due changed since this payment was started. Create a new payment intent.",
        );
      }

      const gatewayTransactionId = input.gatewayTransactionId ?? `SIM-${randomUUID()}`;
      if (input.outcome === "failed") {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "FAILED",
            completedAt: now(),
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
      await recordSuccess(tx, trip, payment, capturedMinor, gatewayTransactionId, {
        simulated: true,
        outcome: "succeeded",
        capturedMinor: capturedMinor.toString(),
      });
      return { payment: await reloadPayment(tx, payment.id), replayed: false };
    }, TX_OPTIONS);
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

  /**
   * For the hold-release job (gap 8): neither eSewa nor Khalti calls MeroStay back, so a customer
   * who paid but never returned to the web app would only be noticed if someone asked. Before a
   * hold ends (and after, until the sweep releases the trip), every open eSewa/Khalti payment of a
   * trip whose hold ends within `withinMs` is looked up with its gateway and the result applied
   * like a callback: paid in time → applied; paid after the hold → recorded for reconciliation.
   * A gateway that does not answer is counted and skipped (the sweep still runs).
   */
  async function checkExpiringPayments(
    limit: number,
    withinMs = 2 * 60_000,
  ): Promise<{ checked: number; applied: number; unavailable: number }> {
    const live = Object.keys(config.gateways).filter((name) => name !== "simulated");
    if (live.length === 0) return { checked: 0, applied: 0, unavailable: 0 };
    const candidates = await prisma.payment.findMany({
      where: {
        kind: "CHARGE",
        status: { in: ["INITIATED", "PENDING"] },
        gateway: { in: live },
        gatewayReference: { not: null },
        trip: { expiresAt: { lte: new Date(now().getTime() + withinMs) } },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    let applied = 0;
    let unavailable = 0;
    for (const payment of candidates) {
      try {
        const result = await adapterFor(payment.gateway).lookup({
          paymentId: payment.id,
          amountMinor: payment.amountMinor,
          gatewayReference: payment.gatewayReference,
        });
        const application = await applyGatewayResult(payment.id, result);
        if (application.outcome === "paid" || application.outcome === "reconciliation")
          applied += 1;
      } catch (err) {
        if (!(err instanceof GatewayError)) throw err;
        unavailable += 1;
      }
    }
    return { checked: candidates.length, applied, unavailable };
  }

  return {
    createIntent,
    confirmPayment,
    handleCallback,
    refreshPayment,
    applyGatewayResult,
    checkExpiringPayments,
    listPayments,
    settleAtProperty,
    listTripInvoices,
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;

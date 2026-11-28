import type {
  BookingItemStatus,
  CommissionStatus,
  PaymentStatus,
} from "../generated/prisma/enums.js";

/**
 * Allowed status changes for a booking item. The booking, payment and payout
 * services (later phases) must call these before writing a new status.
 */

const ITEM_TRANSITIONS: Record<BookingItemStatus, readonly BookingItemStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED", "EXPIRED"],
  CONFIRMED: ["IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  EXPIRED: [],
};

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  // Customer chooses: pay online now, or pay the provider on arrival. Online money arrives through
  // allocations of succeeded payments: in full (PAID) or in part first (PARTIALLY_PAID, ADR 0007).
  UNPAID: ["PARTIALLY_PAID", "PAID", "PAY_AT_PROPERTY"],
  // A partly paid item is completed by a later payment, or refunded what it received.
  PARTIALLY_PAID: ["PAID", "REFUNDED"],
  PAID: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  // Money was never with MeroStay, so there is nothing to refund through us. The only change is
  // recording that the provider was paid on arrival.
  PAY_AT_PROPERTY: ["PAID_AT_PROPERTY"],
  PAID_AT_PROPERTY: [],
  REFUNDED: [],
};

/** Statuses of items the customer pays at the property (the method is encoded in the status). */
export const PAY_AT_PROPERTY_STATUSES: readonly PaymentStatus[] = [
  "PAY_AT_PROPERTY",
  "PAID_AT_PROPERTY",
];

export function isPayAtProperty(paymentStatus: PaymentStatus): boolean {
  return PAY_AT_PROPERTY_STATUSES.includes(paymentStatus);
}

const COMMISSION_TRANSITIONS: Record<CommissionStatus, readonly CommissionStatus[]> = {
  PENDING: ["INVOICED", "PAID", "WAIVED"],
  INVOICED: ["PAID", "WAIVED"],
  // PAID → WAIVED happens only when a paid-out booking is voided (see canWaivePaidOutCommission).
  PAID: [],
  WAIVED: [],
};

export function canTransitionItemStatus(from: BookingItemStatus, to: BookingItemStatus): boolean {
  return ITEM_TRANSITIONS[from].includes(to);
}

export function canTransitionPaymentStatus(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/**
 * Commission collection depends on how the customer paid:
 * - Paid online: MeroStay holds the money, so commission is collected by deducting it
 *   from the provider payout: PENDING → PAID directly. It is never invoiced.
 * - Pay at property: the provider holds the money, so commission must be INVOICED first.
 *   It cannot jump to PAID before an invoice exists.
 * - Waiving (e.g. cancelled before service) is allowed from any open state.
 */
export function canTransitionCommissionStatus(
  from: CommissionStatus,
  to: CommissionStatus,
  paymentStatus: PaymentStatus,
): boolean {
  if (!COMMISSION_TRANSITIONS[from].includes(to)) return false;

  if (to === "INVOICED") return isPayAtProperty(paymentStatus);
  if (from === "PENDING" && to === "PAID") {
    return paymentStatus === "PAID" || paymentStatus === "PARTIALLY_REFUNDED";
  }
  return true;
}

/**
 * The one exception to "PAID commission is final" (Phase 14, gap 39, ADR 0020): voiding a booking
 * that was already paid out. The customer gets everything back and the provider's share is clawed
 * back, so the commission MeroStay deducted is waived. Only for an online item paid out by a batch.
 */
export function canWaivePaidOutCommission(item: {
  commissionStatus: CommissionStatus;
  payoutStatus: string;
  paymentStatus: PaymentStatus;
}): boolean {
  return (
    item.commissionStatus === "PAID" &&
    item.payoutStatus === "PAID" &&
    !isPayAtProperty(item.paymentStatus)
  );
}

export class InvalidTransitionError extends Error {
  constructor(kind: string, from: string, to: string) {
    super(`Invalid ${kind} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertItemTransition(from: BookingItemStatus, to: BookingItemStatus): void {
  if (!canTransitionItemStatus(from, to))
    throw new InvalidTransitionError("booking item", from, to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPaymentStatus(from, to)) throw new InvalidTransitionError("payment", from, to);
}

export function assertCommissionTransition(
  from: CommissionStatus,
  to: CommissionStatus,
  paymentStatus: PaymentStatus,
): void {
  if (!canTransitionCommissionStatus(from, to, paymentStatus)) {
    throw new InvalidTransitionError("commission", from, to);
  }
}

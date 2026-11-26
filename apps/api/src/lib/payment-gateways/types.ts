/**
 * One interface for every online payment gateway (ADR 0017).
 *
 * Core payment logic only ever sees amounts as `bigint` paisa and the normalised result below.
 * Each adapter converts its gateway's units (eSewa: rupees as text; Khalti: paisa) at its own
 * boundary, and nothing is "paid" until the adapter has verified it server-side: an eSewa
 * signature plus the status API, or a Khalti lookup. A browser redirect alone never counts.
 */

export const GATEWAY_NAMES = ["esewa", "khalti", "simulated"] as const;
export type GatewayName = (typeof GATEWAY_NAMES)[number];

/** Gateways a customer can choose (the simulated one is for development and tests only). */
export const LIVE_GATEWAY_NAMES = ["esewa", "khalti"] as const;

export type GatewayStatus = "pending" | "paid" | "failed" | "expired";

export interface CheckoutRequest {
  /** Our payment id: also the order id at the gateway. */
  paymentId: string;
  /** Paisa. */
  amountMinor: bigint;
  currency: string;
  /** Shown to the customer at the gateway, e.g. "MeroStay trip MS-7KQ2". */
  orderName: string;
  /** Where the gateway sends the customer back (our web app). */
  successUrl: string;
  failureUrl: string;
  websiteUrl: string;
}

/** What the browser does to start paying. Never contains a secret. */
export type CheckoutInstruction =
  | { type: "form"; method: "POST"; url: string; fields: Record<string, string> }
  | { type: "redirect"; url: string }
  | { type: "simulated" };

export interface CheckoutResult {
  checkout: CheckoutInstruction;
  /** The gateway's id for this checkout (eSewa: transaction_uuid; Khalti: pidx). */
  gatewayReference: string;
  expiresAt: Date | null;
}

/** What an adapter needs to know about a stored payment. */
export interface GatewayPaymentRef {
  paymentId: string;
  amountMinor: bigint;
  gatewayReference: string | null;
}

export interface GatewayResult {
  status: GatewayStatus;
  /** What the gateway says was paid, in paisa; null when it did not say. */
  amountMinor: bigint | null;
  gatewayReference: string;
  /** The gateway's transaction id once money moved (eSewa ref_id; Khalti transaction_id). */
  transactionId: string | null;
  /** Why the payment is not (usably) paid, e.g. "amount_mismatch", "canceled", "refunded". */
  reason: string | null;
  /** What the gateway answered, without secrets (kept for reconciliation). */
  raw: Record<string, unknown>;
}

/** What the gateway offers for refunds (refunds are not executed in this phase). */
export interface RefundCapability {
  api: "documented" | "none";
  partial: boolean;
  note: string;
}

export interface PaymentGatewayAdapter {
  readonly name: GatewayName;
  readonly refundCapability: RefundCapability;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  /**
   * Checks what the browser brought back from the gateway (eSewa `data`, Khalti `pidx`) and then
   * asks the gateway itself. Throws GatewayError("INVALID_CALLBACK") for anything forged or for
   * another payment.
   */
  verifyPayment(
    payment: GatewayPaymentRef,
    callback: Record<string, unknown>,
  ): Promise<GatewayResult>;
  /** Asks the gateway, server to server, what happened to this payment. */
  lookup(payment: GatewayPaymentRef): Promise<GatewayResult>;
}

export type GatewayErrorCode =
  /** The gateway could not be reached or answered with an error: try again later. */
  | "GATEWAY_UNAVAILABLE"
  /** The gateway refused the request (e.g. below its minimum amount). */
  | "GATEWAY_REJECTED"
  /** The callback was forged, tampered with, or belongs to another payment. */
  | "INVALID_CALLBACK";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    /** What went wrong underneath (for the server log only; never sent to clients). */
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GatewayError";
  }
}

/** A fetch with a time limit; network failures become GATEWAY_UNAVAILABLE. */
export async function gatewayFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  try {
    return await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
  } catch (err) {
    throw new GatewayError("GATEWAY_UNAVAILABLE", "The payment gateway could not be reached.", {
      cause: err,
    });
  }
}

/** Parses a JSON response body without trusting its shape. */
export async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await response.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

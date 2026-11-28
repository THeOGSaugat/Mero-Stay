import { khaltiPaisa } from "./amounts.js";
import {
  GatewayError,
  gatewayFetch,
  jsonBody,
  type CheckoutRequest,
  type CheckoutResult,
  type GatewayPaymentRef,
  type GatewayRefundCheck,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type GatewayResult,
  type PaymentGatewayAdapter,
} from "./types.js";

/**
 * Khalti Web Checkout, ePayment v2 (ADR 0017; docs.khalti.com, checked 2026-11-26).
 *
 * - Initiate: POST {base}/epayment/initiate/ with `Authorization: Key <secret>` and
 *   { return_url, website_url, amount (paisa, ≥ Rs 10), purchase_order_id, purchase_order_name }
 *   → { pidx, payment_url, expires_at }. The browser is redirected to payment_url.
 * - Return: Khalti redirects to return_url with pidx, status, amount, … These are NOT trusted.
 * - Verification: POST {base}/epayment/lookup/ { pidx } → { status, total_amount, transaction_id }.
 *   Only "Completed" with total_amount equal to what we asked for counts as paid.
 * - No webhook is documented.
 * - Refund (Phase 14, ADR 0020; docs.khalti.com/api/refund, checked 2026-11-27):
 *   POST {api}/merchant-transaction/{transaction_id}/refund/ where {api} is the API root without
 *   "/v2" (https://khalti.com/api, sandbox https://dev.khalti.com/api). No body = full refund;
 *   { amount } = partial. The docs say the amount is in PAISA but their example reads like rupees
 *   (50.00): we send paisa like every other Khalti call, and the sandbox check must confirm it
 *   before launch (launch checklist). Success: 2xx { "detail": "Transaction refund successful." }
 *   with no refund id documented, so the reference is the refunded transaction id. No refund status
 *   endpoint is documented: an uncertain call is settled by the lookup (status "Refunded" /
 *   "Partially Refunded", `refunded`).
 */

export interface KhaltiConfig {
  secretKey: string;
  /** e.g. https://dev.khalti.com/api/v2 (sandbox) or https://khalti.com/api/v2. No trailing slash. */
  apiUrl: string;
}

/** The refund endpoint's root: the API URL without its "/v2" version segment. */
export function khaltiRefundRoot(apiUrl: string): string {
  return apiUrl.replace(/\/v2$/, "");
}

export const KHALTI_URLS = {
  uat: "https://dev.khalti.com/api/v2",
  production: "https://khalti.com/api/v2",
} as const;

/** Khalti's documented minimum: Rs 10. */
export const KHALTI_MIN_PAISA = 1000n;

const STATUS_MAP: Record<string, { status: GatewayResult["status"]; reason: string | null }> = {
  Completed: { status: "paid", reason: null },
  Pending: { status: "pending", reason: null },
  Initiated: { status: "pending", reason: "initiated" },
  Expired: { status: "expired", reason: "expired" },
  "User canceled": { status: "failed", reason: "canceled" },
  Refunded: { status: "failed", reason: "refunded" },
  "Partially Refunded": { status: "failed", reason: "partially_refunded" },
};

export function createKhaltiAdapter(config: KhaltiConfig): PaymentGatewayAdapter {
  const headers = {
    Authorization: `Key ${config.secretKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const response = await gatewayFetch(`${config.apiUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await jsonBody(response) };
  }

  async function lookup(payment: GatewayPaymentRef): Promise<GatewayResult> {
    const pidx = payment.gatewayReference;
    if (!pidx) throw new GatewayError("INVALID_CALLBACK", "This payment has no Khalti reference.");
    const { status, body } = await post("/epayment/lookup/", { pidx });
    if (status === 400 || status === 404) {
      // Khalti answers 400 for an expired or cancelled link, with the status in the body.
      if (body && typeof body.status === "string" && STATUS_MAP[body.status]) {
        return resultOf(payment, pidx, body);
      }
      throw new GatewayError("INVALID_CALLBACK", "Khalti does not know this payment.");
    }
    if (status < 200 || status >= 300 || !body || typeof body.status !== "string") {
      throw new GatewayError("GATEWAY_UNAVAILABLE", "Khalti's lookup did not answer.");
    }
    if (body.pidx !== undefined && body.pidx !== pidx) {
      throw new GatewayError("INVALID_CALLBACK", "Khalti answered for another payment.");
    }
    return resultOf(payment, pidx, body);
  }

  function resultOf(
    payment: GatewayPaymentRef,
    pidx: string,
    body: Record<string, unknown>,
  ): GatewayResult {
    const khaltiStatus = String(body.status);
    // Unknown states: hold (the docs say not to provide service and to ask Khalti).
    const mapped = STATUS_MAP[khaltiStatus] ?? {
      status: "pending" as const,
      reason: "unknown_status",
    };
    const amountMinor = khaltiPaisa(body.total_amount);
    const transactionId =
      typeof body.transaction_id === "string" && body.transaction_id ? body.transaction_id : null;
    const raw = {
      status: khaltiStatus,
      total_amount: body.total_amount ?? null,
      transaction_id: transactionId,
      fee: body.fee ?? null,
      refunded: body.refunded ?? null,
      pidx,
    };
    if (mapped.status === "paid" && amountMinor !== payment.amountMinor) {
      return {
        status: "failed",
        amountMinor,
        gatewayReference: pidx,
        transactionId,
        reason: "amount_mismatch",
        raw,
      };
    }
    return {
      status: mapped.status,
      amountMinor,
      gatewayReference: pidx,
      transactionId: mapped.status === "paid" ? transactionId : null,
      reason: mapped.reason,
      raw,
    };
  }

  async function transactionIdOf(payment: GatewayRefundRequest["payment"]): Promise<string> {
    if (payment.transactionId) return payment.transactionId;
    // Older rows may lack it: the docs say the transaction id comes from the lookup.
    const looked = await lookup(payment);
    const fromLookup = looked.raw.transaction_id;
    if (typeof fromLookup === "string" && fromLookup) return fromLookup;
    throw new GatewayError("GATEWAY_REJECTED", "Khalti has no transaction to refund.");
  }

  return {
    name: "khalti",
    refundCapability: {
      api: "documented",
      partial: true,
      note: "Refunded through Khalti's refund API (full or partial, by transaction id).",
    },

    async refund(request: GatewayRefundRequest): Promise<GatewayRefundResult> {
      if (request.amountMinor <= 0n || request.amountMinor > request.payment.capturedMinor) {
        throw new GatewayError("GATEWAY_REJECTED", "The refund is more than Khalti captured.");
      }
      const amount = Number(request.amountMinor);
      if (!Number.isSafeInteger(amount)) {
        throw new GatewayError("GATEWAY_REJECTED", "The amount is too large for Khalti.");
      }
      const transactionId = await transactionIdOf(request.payment);
      const url = `${khaltiRefundRoot(config.apiUrl)}/merchant-transaction/${encodeURIComponent(transactionId)}/refund/`;
      const response = await gatewayFetch(url, {
        method: "POST",
        headers,
        // Full refund: no parameters (docs). Partial: the amount in paisa.
        body: JSON.stringify(request.full ? {} : { amount }),
      });
      const body = await jsonBody(response);
      const raw = {
        httpStatus: response.status,
        detail: typeof body?.detail === "string" ? body.detail : null,
        transaction_id: transactionId,
        amount: request.full ? null : amount,
      };
      if (response.status >= 400 && response.status < 500) {
        throw new GatewayError("GATEWAY_REJECTED", "Khalti refused the refund.", {
          cause: new Error(JSON.stringify(raw)),
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new GatewayError("GATEWAY_UNAVAILABLE", "Khalti did not confirm the refund.");
      }
      const id = [body?.refund_id, body?.idx, body?.id].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      return { reference: (id ?? transactionId).slice(0, 200), raw };
    },

    async checkRefund(payment): Promise<GatewayRefundCheck> {
      const result = await lookup(payment);
      const raw = result.raw;
      const status = typeof raw.status === "string" ? raw.status : "";
      const reference =
        typeof raw.transaction_id === "string" && raw.transaction_id ? raw.transaction_id : null;
      if (status === "Refunded") return { state: "refunded", fully: true, reference, raw };
      if (status === "Partially Refunded") {
        return { state: "refunded", fully: false, reference, raw };
      }
      if (status === "Completed" && raw.refunded !== true) {
        return { state: "not_refunded", fully: null, reference, raw };
      }
      return { state: "unknown", fully: null, reference, raw };
    },

    async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
      if (request.currency !== "NPR") {
        throw new GatewayError("GATEWAY_REJECTED", "Khalti only accepts NPR.");
      }
      if (request.amountMinor < KHALTI_MIN_PAISA) {
        throw new GatewayError("GATEWAY_REJECTED", "Khalti needs at least Rs 10.");
      }
      const amount = Number(request.amountMinor);
      if (!Number.isSafeInteger(amount)) {
        throw new GatewayError("GATEWAY_REJECTED", "The amount is too large for Khalti.");
      }
      const { status, body } = await post("/epayment/initiate/", {
        return_url: request.successUrl,
        website_url: request.websiteUrl,
        amount,
        purchase_order_id: request.paymentId,
        purchase_order_name: request.orderName,
      });
      if (status >= 400 && status < 500) {
        throw new GatewayError("GATEWAY_REJECTED", "Khalti refused to start this payment.");
      }
      const pidx = body?.pidx;
      const paymentUrl = body?.payment_url;
      if (
        status < 200 ||
        status >= 300 ||
        typeof pidx !== "string" ||
        typeof paymentUrl !== "string"
      ) {
        throw new GatewayError("GATEWAY_UNAVAILABLE", "Khalti could not start the payment.");
      }
      const expires = typeof body?.expires_at === "string" ? new Date(body.expires_at) : null;
      return {
        checkout: { type: "redirect", url: paymentUrl },
        gatewayReference: pidx,
        expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
      };
    },

    async verifyPayment(payment, callback): Promise<GatewayResult> {
      // The return URL's pidx only tells us WHICH payment to look up; its status is ignored.
      if (typeof callback.pidx !== "string" || callback.pidx !== payment.gatewayReference) {
        throw new GatewayError("INVALID_CALLBACK", "This Khalti response is for another payment.");
      }
      return lookup(payment);
    },

    lookup,
  };
}

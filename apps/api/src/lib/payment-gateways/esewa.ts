import { createHmac, timingSafeEqual } from "node:crypto";
import { paisaToRupees, rupeesToPaisa } from "./amounts.js";
import {
  GatewayError,
  gatewayFetch,
  jsonBody,
  type CheckoutRequest,
  type CheckoutResult,
  type GatewayPaymentRef,
  type GatewayResult,
  type PaymentGatewayAdapter,
} from "./types.js";

/**
 * eSewa ePay v2 (ADR 0017; developer.esewa.com.np, checked 2026-11-26).
 *
 * - Checkout: the browser POSTs a signed form to eSewa. Signature = base64(HMAC-SHA256(secret,
 *   "total_amount=<rupees>,transaction_uuid=<id>,product_code=<code>")).
 * - Return: eSewa redirects to success_url with `data` = base64 JSON, signed over its own
 *   `signed_field_names` (status COMPLETE on success). total_amount there is text like "1,000.0".
 * - Verification: the signature is checked here (constant time), the callback must be for this
 *   payment and merchant, and the status API must also say COMPLETE for the same amount.
 * - Status API: GET …/transaction/status/?product_code&total_amount&transaction_uuid →
 *   { status: COMPLETE | PENDING | AMBIGUOUS | NOT_FOUND | CANCELED | FULL_REFUND |
 *   PARTIAL_REFUND, total_amount (a JSON number), ref_id }.
 * - eSewa documents no merchant refund API and no server-to-server webhook.
 */

export interface EsewaConfig {
  productCode: string;
  secretKey: string;
  formUrl: string;
  statusUrl: string;
}

export const ESEWA_URLS = {
  uat: {
    formUrl: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
    statusUrl: "https://rc.esewa.com.np/api/epay/transaction/status/",
  },
  production: {
    formUrl: "https://epay.esewa.com.np/api/epay/main/v2/form",
    statusUrl: "https://esewa.com.np/api/epay/transaction/status/",
  },
} as const;

/** base64(HMAC-SHA256(secret, "field=value,field=value,…")) over the named fields, in order. */
export function esewaSignature(
  secretKey: string,
  fields: Record<string, string>,
  signedFieldNames: readonly string[],
): string {
  const message = signedFieldNames.map((name) => `${name}=${fields[name] ?? ""}`).join(",");
  return createHmac("sha256", secretKey).update(message, "utf8").digest("base64");
}

function sameSignature(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

const REQUIRED_SIGNED = ["total_amount", "transaction_uuid", "product_code", "status"];

/**
 * The decoded, signature-checked callback, or GatewayError("INVALID_CALLBACK"). Every value is
 * kept as eSewa wrote it, because the signature covers the exact text.
 */
export function decodeEsewaCallback(secretKey: string, data: unknown): Record<string, string> {
  if (typeof data !== "string" || data.length === 0 || data.length > 4_000) {
    throw new GatewayError("INVALID_CALLBACK", "Missing eSewa response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    throw new GatewayError("INVALID_CALLBACK", "The eSewa response is not readable.");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new GatewayError("INVALID_CALLBACK", "The eSewa response is not readable.");
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (typeof value === "string") fields[key] = value;
    else if (typeof value === "number") fields[key] = String(value);
  }
  const signed = (fields.signed_field_names ?? "").split(",").map((name) => name.trim());
  if (!REQUIRED_SIGNED.every((name) => signed.includes(name)) || !fields.signature) {
    throw new GatewayError("INVALID_CALLBACK", "The eSewa response is not signed as expected.");
  }
  if (!sameSignature(esewaSignature(secretKey, fields, signed), fields.signature)) {
    throw new GatewayError("INVALID_CALLBACK", "The eSewa response signature is not valid.");
  }
  return fields;
}

const STATUS_MAP: Record<string, { status: GatewayResult["status"]; reason: string | null }> = {
  COMPLETE: { status: "paid", reason: null },
  PENDING: { status: "pending", reason: null },
  AMBIGUOUS: { status: "pending", reason: "ambiguous" },
  NOT_FOUND: { status: "expired", reason: "not_found" },
  CANCELED: { status: "failed", reason: "canceled" },
  FULL_REFUND: { status: "failed", reason: "refunded" },
  PARTIAL_REFUND: { status: "failed", reason: "partially_refunded" },
};

export function createEsewaAdapter(config: EsewaConfig): PaymentGatewayAdapter {
  async function lookup(payment: GatewayPaymentRef): Promise<GatewayResult> {
    const query = new URLSearchParams({
      product_code: config.productCode,
      total_amount: paisaToRupees(payment.amountMinor),
      transaction_uuid: payment.paymentId,
    });
    const response = await gatewayFetch(`${config.statusUrl}?${query.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const body = await jsonBody(response);
    if (!response.ok || !body || typeof body.status !== "string") {
      throw new GatewayError("GATEWAY_UNAVAILABLE", "eSewa's status check did not answer.");
    }
    if (body.transaction_uuid !== payment.paymentId || body.product_code !== config.productCode) {
      throw new GatewayError("INVALID_CALLBACK", "eSewa answered for another payment.");
    }
    const mapped = STATUS_MAP[body.status] ?? {
      status: "pending" as const,
      reason: "unknown_status",
    };
    const amountMinor = rupeesToPaisa(body.total_amount);
    const raw = {
      status: body.status,
      total_amount: body.total_amount,
      ref_id: body.ref_id ?? null,
      transaction_uuid: body.transaction_uuid,
    };
    const transactionId = typeof body.ref_id === "string" && body.ref_id ? body.ref_id : null;
    if (mapped.status === "paid" && amountMinor !== payment.amountMinor) {
      return {
        status: "failed",
        amountMinor,
        gatewayReference: payment.paymentId,
        transactionId,
        reason: "amount_mismatch",
        raw,
      };
    }
    return {
      status: mapped.status,
      amountMinor,
      gatewayReference: payment.paymentId,
      transactionId: mapped.status === "paid" ? transactionId : null,
      reason: mapped.reason,
      raw,
    };
  }

  return {
    name: "esewa",
    refundCapability: {
      api: "none",
      partial: false,
      note: "eSewa documents no merchant refund API: refunds go through the eSewa merchant portal.",
    },

    createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
      if (request.currency !== "NPR") {
        return Promise.reject(new GatewayError("GATEWAY_REJECTED", "eSewa only accepts NPR."));
      }
      const total = paisaToRupees(request.amountMinor);
      const signedFieldNames = ["total_amount", "transaction_uuid", "product_code"];
      const fields: Record<string, string> = {
        amount: total,
        tax_amount: "0",
        product_service_charge: "0",
        product_delivery_charge: "0",
        total_amount: total,
        transaction_uuid: request.paymentId,
        product_code: config.productCode,
        success_url: request.successUrl,
        failure_url: request.failureUrl,
        signed_field_names: signedFieldNames.join(","),
      };
      fields.signature = esewaSignature(config.secretKey, fields, signedFieldNames);
      return Promise.resolve({
        checkout: { type: "form", method: "POST", url: config.formUrl, fields },
        gatewayReference: request.paymentId,
        expiresAt: null,
      });
    },

    async verifyPayment(payment, callback): Promise<GatewayResult> {
      const fields = decodeEsewaCallback(config.secretKey, callback.data);
      if (
        fields.transaction_uuid !== payment.paymentId ||
        fields.product_code !== config.productCode
      ) {
        throw new GatewayError("INVALID_CALLBACK", "This eSewa response is for another payment.");
      }
      // Signed, and for this payment. eSewa's own status API has the final word.
      const confirmed = await lookup(payment);
      if (confirmed.status === "paid") {
        const signedAmount = rupeesToPaisa(fields.total_amount);
        if (fields.status !== "COMPLETE" || signedAmount !== payment.amountMinor) {
          return { ...confirmed, status: "failed", reason: "callback_mismatch" };
        }
        return {
          ...confirmed,
          transactionId: confirmed.transactionId ?? fields.transaction_code ?? null,
        };
      }
      return confirmed;
    },

    lookup,
  };
}

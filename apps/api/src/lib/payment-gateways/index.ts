import { createEsewaAdapter, type EsewaConfig } from "./esewa.js";
import { createKhaltiAdapter, type KhaltiConfig } from "./khalti.js";
import {
  GatewayError,
  type CheckoutRequest,
  type GatewayName,
  type PaymentGatewayAdapter,
} from "./types.js";

export * from "./types.js";
export { createEsewaAdapter, esewaSignature, decodeEsewaCallback, ESEWA_URLS } from "./esewa.js";
export { createKhaltiAdapter, KHALTI_URLS, KHALTI_MIN_PAISA } from "./khalti.js";
export { paisaToRupees, rupeesToPaisa, khaltiPaisa } from "./amounts.js";

/**
 * The simulated gateway (Phase 5): development and tests only, refused in production (env.ts).
 * A payment is "paid" through POST …/payments/:id/confirm, standing in for a verified callback.
 */
export function createSimulatedAdapter(): PaymentGatewayAdapter {
  const notVerifiable = () =>
    Promise.reject(
      new GatewayError("INVALID_CALLBACK", "Simulated payments are confirmed with /confirm."),
    );
  return {
    name: "simulated",
    refundCapability: { api: "none", partial: false, note: "Test mode only." },
    createCheckout: (request: CheckoutRequest) =>
      Promise.resolve({
        checkout: { type: "simulated" as const },
        gatewayReference: `SIM-${request.paymentId}`,
        expiresAt: null,
      }),
    verifyPayment: notVerifiable,
    lookup: notVerifiable,
  };
}

export interface GatewaysConfig {
  esewa?: EsewaConfig;
  khalti?: KhaltiConfig;
  simulated?: boolean;
}

/** The enabled adapters by name (only those configured). */
export function createGateways(
  config: GatewaysConfig,
): Partial<Record<GatewayName, PaymentGatewayAdapter>> {
  return {
    ...(config.esewa ? { esewa: createEsewaAdapter(config.esewa) } : {}),
    ...(config.khalti ? { khalti: createKhaltiAdapter(config.khalti) } : {}),
    ...(config.simulated ? { simulated: createSimulatedAdapter() } : {}),
  };
}

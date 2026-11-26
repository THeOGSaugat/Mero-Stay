import {
  createSimulatedAdapter,
  type GatewayName,
  type PaymentGatewayAdapter,
} from "../../lib/payment-gateways/index.js";

/**
 * Online payment configuration (ADR 0007, ADR 0017).
 *
 * - `gateways`: the enabled adapters (eSewa, Khalti; "simulated" only outside production).
 *   None = online payments are unavailable (503).
 * - `publicWebUrl`: the web app's origin, where eSewa and Khalti send customers back.
 * - `mode`: "uat" (sandbox, no real money) or "production".
 */
export interface PaymentsConfig {
  gateways: Partial<Record<GatewayName, PaymentGatewayAdapter>>;
  publicWebUrl: string | null;
  mode: "uat" | "production";
}

export const NO_PAYMENTS: PaymentsConfig = { gateways: {}, publicWebUrl: null, mode: "uat" };

/** Only the simulated test gateway (development and tests). */
export function simulatedPayments(): PaymentsConfig {
  return { gateways: { simulated: createSimulatedAdapter() }, publicWebUrl: null, mode: "uat" };
}

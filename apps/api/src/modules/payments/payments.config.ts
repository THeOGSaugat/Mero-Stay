/**
 * Online payment configuration (ADR 0007).
 *
 * - "simulated": test-mode gateway. A payment intent is "paid" by calling the confirm endpoint,
 *   which stands in for the provider's verified callback. Refused in production (env.ts).
 * - null: no gateway configured. Payment intents and confirmations return 503.
 *
 * eSewa and Khalti are added as further gateway names with server-to-server verification.
 */
export type PaymentGateway = "simulated";

export interface PaymentsConfig {
  gateway: PaymentGateway | null;
}

export const NO_PAYMENTS: PaymentsConfig = { gateway: null };

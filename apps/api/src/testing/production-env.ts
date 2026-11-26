/**
 * The payment settings a valid production environment needs since Phase 11 (ADR 0017), for
 * tests that parse one. Placeholder values only: no real gateway key.
 */
export const PRODUCTION_PAYMENT_ENV = {
  PAYMENT_GATEWAYS: "khalti",
  PAYMENT_MODE: "production",
  KHALTI_SECRET_KEY: "test-only-placeholder-key",
  PUBLIC_WEB_URL: "https://merostay.example",
} as const;

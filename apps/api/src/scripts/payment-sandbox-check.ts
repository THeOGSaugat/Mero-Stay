import { randomUUID } from "node:crypto";
import { loadEnvFileIfPresent, parseEnv } from "../config/env.js";
import {
  createEsewaAdapter,
  createKhaltiAdapter,
  ESEWA_URLS,
  GatewayError,
  KHALTI_URLS,
  type GatewayResult,
} from "../lib/payment-gateways/index.js";

/**
 * Opt-in check against the REAL eSewa UAT and Khalti sandbox (ADR 0017). Not part of any test
 * suite: it needs the network and the owner's sandbox keys in apps/api/.env
 * (ESEWA_PRODUCT_CODE + ESEWA_SECRET_KEY, KHALTI_SECRET_KEY; see docs/development/payments.md).
 * Sandbox only: it refuses to run with PAYMENT_MODE=production or NODE_ENV=production, and no
 * money moves. Keys are never printed.
 *
 *   npm run payment:sandbox-check -w @merostay/api
 *   npm run payment:sandbox-check -w @merostay/api -- --khalti-lookup <pidx>
 *
 * eSewa: POSTs a signed checkout form for Rs 10 (and one with a wrong signature, for contrast)
 * to the UAT form URL and asks the UAT status API about it. Khalti: starts a Rs 10 sandbox
 * payment, looks it up (Initiated), and prints the payment page to finish by hand with a test
 * wallet; `--khalti-lookup <pidx>` then shows the completed result.
 */

const AMOUNT_PAISA = 1000n; // Rs 10: Khalti's minimum.

function show(label: string, value: unknown): void {
  process.stdout.write(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function summary(result: GatewayResult) {
  return {
    status: result.status,
    reason: result.reason,
    amountMinor: result.amountMinor?.toString() ?? null,
    transactionId: result.transactionId,
    gatewayStatus: result.raw.status ?? null,
  };
}

async function postForm(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(fields),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const location = response.headers.get("location");
  const text = await response.text();
  return {
    httpStatus: response.status,
    redirectsTo: location ? new URL(location, url).origin + new URL(location, url).pathname : null,
    bodyMentionsError: /invalid|error|signature/i.test(text.slice(0, 20_000)),
  };
}

async function checkEsewa(productCode: string, secretKey: string): Promise<boolean> {
  process.stdout.write("\n== eSewa ePay v2 (UAT) ==\n");
  const esewa = createEsewaAdapter({ productCode, secretKey, ...ESEWA_URLS.uat });
  const paymentId = randomUUID();
  const { checkout } = await esewa.createCheckout({
    paymentId,
    amountMinor: AMOUNT_PAISA,
    currency: "NPR",
    orderName: "MeroStay sandbox check",
    successUrl: "http://localhost:3000/payments/esewa/return/sandbox-check",
    failureUrl: "http://localhost:3000/payments/esewa/failure/sandbox-check",
    websiteUrl: "http://localhost:3000",
  });
  if (checkout.type !== "form") throw new Error("expected an eSewa form");
  show("transaction_uuid", paymentId);
  show("signed form, our signature", await postForm(checkout.url, checkout.fields));
  show(
    "signed form, WRONG signature (contrast)",
    await postForm(checkout.url, { ...checkout.fields, signature: "AAAA" }),
  );
  const status = await esewa.lookup({
    paymentId,
    amountMinor: AMOUNT_PAISA,
    gatewayReference: paymentId,
  });
  show("status API (expect PENDING or NOT_FOUND: nothing was paid)", summary(status));
  return true;
}

async function checkKhalti(secretKey: string, lookupPidx: string | null): Promise<boolean> {
  process.stdout.write("\n== Khalti ePayment v2 (sandbox) ==\n");
  const khalti = createKhaltiAdapter({ secretKey, apiUrl: KHALTI_URLS.uat });
  if (lookupPidx) {
    const result = await khalti.lookup({
      paymentId: "sandbox-check",
      amountMinor: AMOUNT_PAISA,
      gatewayReference: lookupPidx,
    });
    show("lookup", summary(result));
    return true;
  }
  const paymentId = randomUUID();
  const started = await khalti.createCheckout({
    paymentId,
    amountMinor: AMOUNT_PAISA,
    currency: "NPR",
    orderName: "MeroStay sandbox check",
    successUrl: "http://localhost:3000/payments/khalti/return/sandbox-check",
    failureUrl: "http://localhost:3000/payments/khalti/return/sandbox-check",
    websiteUrl: "http://localhost:3000",
  });
  show("pidx", started.gatewayReference);
  show("expires_at", started.expiresAt?.toISOString() ?? null);
  if (started.checkout.type === "redirect") show("payment_url", started.checkout.url);
  const result = await khalti.lookup({
    paymentId,
    amountMinor: AMOUNT_PAISA,
    gatewayReference: started.gatewayReference,
  });
  show("lookup (expect pending / Initiated)", summary(result));
  process.stdout.write(
    "To finish by hand: open payment_url, pay with a Khalti test wallet (docs/development/payments.md),\n" +
      `then run: npm run payment:sandbox-check -w @merostay/api -- --khalti-lookup ${started.gatewayReference}\n`,
  );
  return true;
}

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const env = parseEnv(process.env);
  if (env.NODE_ENV === "production" || env.PAYMENT_MODE === "production") {
    throw new Error("The sandbox check never runs in production mode.");
  }
  const argIndex = process.argv.indexOf("--khalti-lookup");
  const lookupPidx = argIndex >= 0 ? (process.argv[argIndex + 1] ?? null) : null;

  let ran = 0;
  if (!lookupPidx && env.ESEWA_PRODUCT_CODE && env.ESEWA_SECRET_KEY) {
    ran += Number(await checkEsewa(env.ESEWA_PRODUCT_CODE, env.ESEWA_SECRET_KEY));
  } else if (!lookupPidx) {
    process.stdout.write("\neSewa skipped: ESEWA_PRODUCT_CODE / ESEWA_SECRET_KEY not set.\n");
  }
  if (env.KHALTI_SECRET_KEY) {
    ran += Number(await checkKhalti(env.KHALTI_SECRET_KEY, lookupPidx));
  } else {
    process.stdout.write("\nKhalti skipped: KHALTI_SECRET_KEY not set.\n");
  }
  if (ran === 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message =
    err instanceof GatewayError ? `${err.code}: ${err.message}` : (err as Error).message;
  process.stderr.write(`sandbox check failed: ${message}\n`);
  process.exitCode = 1;
});

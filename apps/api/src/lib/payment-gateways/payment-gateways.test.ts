import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  esewaCallbackAmount,
  startFakeGateways,
  testGatewayKeys,
  type FakeGateways,
} from "../../testing/fake-gateways.js";
import {
  createEsewaAdapter,
  createKhaltiAdapter,
  createSimulatedAdapter,
  decodeEsewaCallback,
  esewaSignature,
  GatewayError,
  type CheckoutRequest,
  type PaymentGatewayAdapter,
} from "./index.js";

const keys = testGatewayKeys();
let fake: FakeGateways;
let esewa: PaymentGatewayAdapter;
let khalti: PaymentGatewayAdapter;

beforeAll(async () => {
  fake = await startFakeGateways(keys);
  esewa = createEsewaAdapter(fake.esewaConfig);
  khalti = createKhaltiAdapter(fake.khaltiConfig);
});
afterAll(() => fake.close());
beforeEach(() => fake.setUnavailable(false));

function request(paymentId: string, amountMinor = 450_050n): CheckoutRequest {
  return {
    paymentId,
    amountMinor,
    currency: "NPR",
    orderName: "MeroStay trip MS-TEST",
    successUrl: `http://web.test/payments/x/return/${paymentId}`,
    failureUrl: `http://web.test/payments/x/failure/${paymentId}`,
    websiteUrl: "http://web.test",
  };
}

async function rejects(promise: Promise<unknown>, code: GatewayError["code"]): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GatewayError);
  expect((err as GatewayError).code).toBe(code);
}

describe("eSewa signature (ePay v2)", () => {
  it("signs eSewa's documented message with the UAT secret (independent vector)", () => {
    // Message and UAT secret from developer.esewa.com.np. The result printed there
    // (4Ov7pCI1…) does not reproduce with standard HMAC-SHA256 for these inputs, nor does the
    // demo form's (ADR 0017), so the expected value was computed independently with
    // `printf '%s' "<message>" | openssl dgst -sha256 -hmac "<secret>" -binary | base64`.
    // The opt-in `npm run payment:sandbox-check` confirms eSewa UAT accepts our signature.
    expect(
      esewaSignature(
        "8gBm/:&EnhH.1/q",
        { total_amount: "100", transaction_uuid: "11-201-13", product_code: "EPAYTEST" },
        ["total_amount", "transaction_uuid", "product_code"],
      ),
    ).toBe("5DZywcrTKD0gia/rsSMcrRHmJl+4Tbol6S+lWgdJ94E=");
  });

  it("signs the named fields in the given order as name=value pairs", () => {
    const fields = { a: "1", b: "2" };
    expect(esewaSignature("k", fields, ["a", "b"])).not.toBe(
      esewaSignature("k", fields, ["b", "a"]),
    );
    // "a=1,b=2", computed with openssl as above.
    expect(esewaSignature("k", fields, ["a", "b"])).toBe(
      "OfYPzupaleeViWGZBKAhDNoSY4gL3w9k5Fr4Ko1vmX8=",
    );
  });

  it("accepts a correctly signed callback and refuses tampered, unsigned or foreign ones", () => {
    const fields = {
      transaction_code: "000AWEO",
      status: "COMPLETE",
      total_amount: "1,000.0",
      transaction_uuid: "pay-1",
      product_code: "EPAYTEST",
    };
    const data = fake.esewa.signedData(fields);
    expect(decodeEsewaCallback(keys.esewa.secretKey, data)).toMatchObject(fields);

    const decoded = JSON.parse(Buffer.from(data, "base64").toString()) as Record<string, string>;
    const tampered = Buffer.from(JSON.stringify({ ...decoded, total_amount: "1.0" })).toString(
      "base64",
    );
    expect(() => decodeEsewaCallback(keys.esewa.secretKey, tampered)).toThrow(/signature/);
    // Signed with another merchant's key.
    expect(() => decodeEsewaCallback("another-merchant-secret", data)).toThrow(/signature/);
    // Signature present but amount not among the signed fields.
    const partial = fake.esewa.signedData({
      ...fields,
      signed_field_names: "transaction_code,status,transaction_uuid,product_code",
    });
    expect(() => decodeEsewaCallback(keys.esewa.secretKey, partial)).toThrow(/not signed/);
    for (const garbage of [undefined, "", "%%%not-base64", Buffer.from("[1]").toString("base64")]) {
      expect(() => decodeEsewaCallback(keys.esewa.secretKey, garbage)).toThrow(GatewayError);
    }
  });

  it("writes callback amounts the way eSewa does", () => {
    expect(esewaCallbackAmount("1000")).toBe("1,000.0");
    expect(esewaCallbackAmount("4500.50")).toBe("4,500.5");
    expect(esewaCallbackAmount("100.05")).toBe("100.05");
  });
});

describe("eSewa adapter", () => {
  it("builds a signed form in rupees, with no secret in it", async () => {
    const { checkout, gatewayReference } = await esewa.createCheckout(request("pay-form"));
    expect(gatewayReference).toBe("pay-form");
    expect(checkout.type).toBe("form");
    if (checkout.type !== "form") return;
    expect(checkout.url).toBe(fake.esewaConfig.formUrl);
    expect(checkout.fields).toMatchObject({
      amount: "4500.50",
      tax_amount: "0",
      total_amount: "4500.50",
      transaction_uuid: "pay-form",
      product_code: "EPAYTEST",
      signed_field_names: "total_amount,transaction_uuid,product_code",
    });
    expect(checkout.fields.signature).toBe(
      esewaSignature(keys.esewa.secretKey, checkout.fields, [
        "total_amount",
        "transaction_uuid",
        "product_code",
      ]),
    );
    expect(JSON.stringify(checkout)).not.toContain(keys.esewa.secretKey);
  });

  it("refuses non-NPR checkouts", async () => {
    await rejects(
      esewa.createCheckout({ ...request("pay-usd"), currency: "USD" }),
      "GATEWAY_REJECTED",
    );
  });

  async function submitForm(paymentId: string, amountMinor = 450_050n) {
    const { checkout } = await esewa.createCheckout(request(paymentId, amountMinor));
    if (checkout.type !== "form") throw new Error("expected a form");
    const response = await fetch(checkout.url, {
      method: "POST",
      body: new URLSearchParams(checkout.fields),
    });
    expect(response.status).toBe(200);
  }

  it("is paid only when the signed callback AND the status API agree", async () => {
    await submitForm("pay-ok");
    const ref = { paymentId: "pay-ok", amountMinor: 450_050n, gatewayReference: "pay-ok" };
    expect((await esewa.lookup(ref)).status).toBe("pending");
    const data = fake.esewa.complete("pay-ok");
    const result = await esewa.verifyPayment(ref, { data });
    expect(result).toMatchObject({ status: "paid", amountMinor: 450_050n, reason: null });
    expect(result.transactionId).toMatch(/^ESEWA/);
  });

  it("does not trust a signed COMPLETE callback the status API does not confirm", async () => {
    await submitForm("pay-unconfirmed");
    const ref = { paymentId: "pay-unconfirmed", amountMinor: 450_050n, gatewayReference: null };
    const data = fake.esewa.complete("pay-unconfirmed");
    fake.esewa.transactions.get("pay-unconfirmed")!.status = "PENDING";
    expect((await esewa.verifyPayment(ref, { data })).status).toBe("pending");
  });

  it("refuses a callback for another payment, or with a tampered amount", async () => {
    await submitForm("pay-a");
    await submitForm("pay-b");
    const dataA = fake.esewa.complete("pay-a");
    const refB = { paymentId: "pay-b", amountMinor: 450_050n, gatewayReference: "pay-b" };
    await rejects(esewa.verifyPayment(refB, { data: dataA }), "INVALID_CALLBACK");
    const decoded = JSON.parse(Buffer.from(dataA, "base64").toString()) as Record<string, string>;
    const tampered = Buffer.from(JSON.stringify({ ...decoded, total_amount: "1.0" })).toString(
      "base64",
    );
    const refA = { paymentId: "pay-a", amountMinor: 450_050n, gatewayReference: "pay-a" };
    await rejects(esewa.verifyPayment(refA, { data: tampered }), "INVALID_CALLBACK");
  });

  it("reports a different paid amount as failed with amount_mismatch", async () => {
    await submitForm("pay-short");
    fake.esewa.complete("pay-short");
    fake.esewa.transactions.get("pay-short")!.statusApiAmount = 4000;
    const result = await esewa.lookup({
      paymentId: "pay-short",
      amountMinor: 450_050n,
      gatewayReference: "pay-short",
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "amount_mismatch",
      amountMinor: 400_000n,
    });
  });

  it("maps a signed callback whose own amount differs to failed", async () => {
    await submitForm("pay-cb-mismatch");
    const data = fake.esewa.complete("pay-cb-mismatch", { callbackTotal: "4,000.0" });
    const result = await esewa.verifyPayment(
      { paymentId: "pay-cb-mismatch", amountMinor: 450_050n, gatewayReference: null },
      { data },
    );
    expect(result).toMatchObject({ status: "failed", reason: "callback_mismatch" });
  });

  it("maps cancelled and unknown transactions; an outage is UNAVAILABLE", async () => {
    await submitForm("pay-cancel");
    fake.esewa.transactions.get("pay-cancel")!.status = "CANCELED";
    const ref = { paymentId: "pay-cancel", amountMinor: 450_050n, gatewayReference: null };
    expect(await esewa.lookup(ref)).toMatchObject({ status: "failed", reason: "canceled" });
    const unknown = { paymentId: "pay-never", amountMinor: 100n, gatewayReference: null };
    expect(await esewa.lookup(unknown)).toMatchObject({ status: "expired", reason: "not_found" });
    fake.setUnavailable(true);
    await rejects(esewa.lookup(ref), "GATEWAY_UNAVAILABLE");
  });

  it("is UNAVAILABLE when the gateway cannot be reached", async () => {
    const offline = createEsewaAdapter({
      ...fake.esewaConfig,
      statusUrl: "http://127.0.0.1:9/esewa/status",
    });
    await rejects(
      offline.lookup({ paymentId: "p", amountMinor: 100n, gatewayReference: null }),
      "GATEWAY_UNAVAILABLE",
    );
  });
});

describe("Khalti adapter", () => {
  it("initiates in paisa with `Authorization: Key <secret>` and redirects", async () => {
    const { checkout, gatewayReference, expiresAt } = await khalti.createCheckout(
      request("pay-k1", 450_050n),
    );
    expect(checkout).toEqual({
      type: "redirect",
      url: `${fake.baseUrl}/khalti/pay/${gatewayReference}`,
    });
    expect(expiresAt).toBeInstanceOf(Date);
    const call = fake.khalti.requests.at(-1)!;
    expect(call.authorization).toBe(`Key ${keys.khalti.secretKey}`);
    expect(call.body).toMatchObject({
      amount: 450050,
      purchase_order_id: "pay-k1",
      purchase_order_name: "MeroStay trip MS-TEST",
      return_url: "http://web.test/payments/x/return/pay-k1",
      website_url: "http://web.test",
    });
  });

  it("refuses below Rs 10, non-NPR and a wrong key", async () => {
    await rejects(khalti.createCheckout(request("pay-small", 999n)), "GATEWAY_REJECTED");
    await rejects(
      khalti.createCheckout({ ...request("pay-usd"), currency: "USD" }),
      "GATEWAY_REJECTED",
    );
    const wrongKey = createKhaltiAdapter({ ...fake.khaltiConfig, secretKey: "wrong-key-123" });
    await rejects(wrongKey.createCheckout(request("pay-wrong")), "GATEWAY_REJECTED");
  });

  async function started(paymentId: string, amountMinor = 450_050n) {
    const { gatewayReference } = await khalti.createCheckout(request(paymentId, amountMinor));
    return { paymentId, amountMinor, gatewayReference };
  }

  it("is paid only when lookup says Completed for the same amount", async () => {
    const ref = await started("pay-k2");
    expect(await khalti.lookup(ref)).toMatchObject({ status: "pending", reason: "initiated" });
    // The return URL's own status is ignored: only lookup counts.
    expect(
      (await khalti.verifyPayment(ref, { pidx: ref.gatewayReference, status: "Completed" })).status,
    ).toBe("pending");
    fake.khalti.complete(ref.gatewayReference);
    const result = await khalti.verifyPayment(ref, { pidx: ref.gatewayReference });
    expect(result).toMatchObject({ status: "paid", amountMinor: 450_050n });
    expect(result.transactionId).toMatch(/^KT/);
  });

  it("maps a Completed lookup with another amount to failed amount_mismatch", async () => {
    const ref = await started("pay-k3");
    fake.khalti.complete(ref.gatewayReference, { paidAmount: 1000 });
    expect(await khalti.lookup(ref)).toMatchObject({
      status: "failed",
      reason: "amount_mismatch",
      amountMinor: 1000n,
    });
  });

  it("maps expired and cancelled links (HTTP 400 with a status)", async () => {
    const expired = await started("pay-k4");
    fake.khalti.payments.get(expired.gatewayReference)!.status = "Expired";
    expect(await khalti.lookup(expired)).toMatchObject({ status: "expired" });
    const cancelled = await started("pay-k5");
    fake.khalti.payments.get(cancelled.gatewayReference)!.status = "User canceled";
    expect(await khalti.lookup(cancelled)).toMatchObject({ status: "failed", reason: "canceled" });
    const refunded = await started("pay-k6");
    fake.khalti.payments.get(refunded.gatewayReference)!.status = "Refunded";
    expect(await khalti.lookup(refunded)).toMatchObject({ status: "failed", reason: "refunded" });
  });

  it("refuses a pidx for another payment, an unknown pidx, and reports outages", async () => {
    const ref = await started("pay-k7");
    await rejects(khalti.verifyPayment(ref, { pidx: "someone-elses-pidx" }), "INVALID_CALLBACK");
    await rejects(khalti.verifyPayment(ref, {}), "INVALID_CALLBACK");
    await rejects(khalti.lookup({ ...ref, gatewayReference: "unknown-pidx" }), "INVALID_CALLBACK");
    fake.setUnavailable(true);
    await rejects(khalti.lookup(ref), "GATEWAY_UNAVAILABLE");
  });
});

describe("simulated adapter", () => {
  it("cannot be verified through a callback", async () => {
    const simulated = createSimulatedAdapter();
    const ref = { paymentId: "p", amountMinor: 100n, gatewayReference: "SIM-p" };
    await rejects(simulated.verifyPayment(ref, {}), "INVALID_CALLBACK");
    await rejects(simulated.lookup(ref), "INVALID_CALLBACK");
  });
});

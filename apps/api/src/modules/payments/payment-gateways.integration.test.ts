import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import { createGateways } from "../../lib/payment-gateways/index.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import {
  startFakeGateways,
  testGatewayKeys,
  type FakeGateways,
} from "../../testing/fake-gateways.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { moneyBoundaryViolations } from "../../testing/json-safety.js";
import { API_ROOT, resolveTestDatabase } from "../../testing/test-database.js";
import { createTripsService } from "../trips/trips.service.js";
import type { PaymentsConfig } from "./payments.config.js";
import { createPaymentsService } from "./payments.service.js";

/**
 * Phase 11 (ADR 0017, gaps 7 and 8): eSewa and Khalti through their adapters, against local fake
 * gateways that follow the documented contracts (no network, no real keys, no real money).
 * Checkout initiation, verified callbacks, idempotent repeats, forged callbacks, amount
 * mismatches, late success after the hold expired, refund requests (stored, never executed) and
 * the production start-up refusal.
 */

// Many sequential API calls with several database round trips each (see payments tests).
vi.setConfig({ testTimeout: 120_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const WEB = "http://web.test";
let fake: FakeGateways;
let app: ReturnType<typeof createApp>;
let paymentsConfig: PaymentsConfig;
let world: World;

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
}

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: label,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

let me: Client;
let admin: Client;
const responses: unknown[] = [];

async function call(method: "get" | "post", url: string, body?: object, as: Client = me) {
  const req = as.agent[method](url).set("X-CSRF-Token", as.csrfToken);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}

/** The browser coming back from the gateway: no session, no CSRF token. */
async function callback(gateway: string, body: object) {
  const res = await request(app).post(`/api/v1/payment-callbacks/${gateway}`).send(body);
  responses.push(res.body);
  return res;
}

const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error.code];

interface PaymentBody {
  id: string;
  gateway: string;
  status: string;
  amountMinor: string;
  capturedMinor: string;
  gatewayTransactionId: string | null;
  allocations: { itemId: string; amountMinor: string }[];
}
type Checkout =
  | { type: "form"; method: "POST"; url: string; fields: Record<string, string> }
  | { type: "redirect"; url: string };
interface IntentBody {
  created: boolean;
  payment: PaymentBody;
  checkout: Checkout;
}
interface ApplicationBody {
  tripId: string;
  outcome: string;
  payment: PaymentBody;
  reconciliation: { id: string; reason: string } | null;
}
interface Trip {
  id: string;
  status: string;
  onlinePayment: { paidMinor: string; dueMinor: string };
  items: { id: string; status: string; paymentStatus: string }[];
}

/** A confirmed trip with one online item: 2 bus seats, Rs 1,800 each = 360000 paisa. */
async function confirmedTrip(as: Client = me): Promise<Trip> {
  const created = await call("post", "/api/v1/trips", { currency: "NPR" }, as);
  expect(created.status).toBe(201);
  const tripId = dataOf<Trip>(created).id;
  const item = await call(
    "post",
    `/api/v1/trips/${tripId}/items`,
    {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 2,
      paymentMethod: "online",
    },
    as,
  );
  expect(item.status).toBe(201);
  const confirmed = await call("post", `/api/v1/trips/${tripId}/confirm`, undefined, as);
  expect(confirmed.status).toBe(200);
  return dataOf<Trip>(confirmed);
}

const intent = (tripId: string, gateway: string, as: Client = me) =>
  call("post", `/api/v1/trips/${tripId}/payments/intent`, { gateway }, as);
const getTrip = async (id: string) => dataOf<Trip>(await call("get", `/api/v1/trips/${id}`));

/** Submits our signed form to the fake eSewa, as the browser would. */
async function submitEsewaForm(checkout: Checkout): Promise<void> {
  if (checkout.type !== "form") throw new Error("expected an eSewa form");
  const res = await fetch(checkout.url, {
    method: "POST",
    body: new URLSearchParams(checkout.fields),
  });
  expect(res.status).toBe(200);
}

const pidxOf = (checkout: Checkout) => {
  if (checkout.type !== "redirect") throw new Error("expected a Khalti redirect");
  return checkout.url.split("/").at(-1)!;
};

beforeAll(async () => {
  fake = await startFakeGateways(testGatewayKeys());
  paymentsConfig = {
    gateways: createGateways({
      esewa: fake.esewaConfig,
      khalti: fake.khaltiConfig,
      simulated: true,
    }),
    publicWebUrl: WEB,
    mode: "uat",
  };
  app = createApp({
    logger: pino({ level: "silent" }),
    checkDatabase: () => Promise.resolve(),
    prisma,
    auth: testAuthConfig(),
    payments: paymentsConfig,
  });
  world = await createWorld(prisma);
  me = await signUp("gateway-payer");
  admin = await signUp("gateway-admin");
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
});

afterAll(async () => {
  await fake.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
describe("eSewa: signed form → verified callback → paid", () => {
  let trip: Trip;
  let payment: PaymentBody;
  let checkout: Checkout;

  it("starts a checkout: a signed form in rupees, our return URLs, no secret", async () => {
    trip = await confirmedTrip();
    const res = await intent(trip.id, "esewa");
    expect(res.status).toBe(201);
    ({ payment, checkout } = dataOf<IntentBody>(res));
    expect(payment).toMatchObject({ gateway: "esewa", status: "INITIATED", amountMinor: "360000" });
    expect(checkout.type).toBe("form");
    if (checkout.type !== "form") return;
    expect(checkout.url).toBe(fake.esewaConfig.formUrl);
    expect(checkout.fields).toMatchObject({
      amount: "3600",
      total_amount: "3600",
      transaction_uuid: payment.id,
      product_code: "EPAYTEST",
      success_url: `${WEB}/payments/esewa/return/${payment.id}`,
      failure_url: `${WEB}/payments/esewa/failure/${payment.id}`,
      signed_field_names: "total_amount,transaction_uuid,product_code",
    });
    expect(JSON.stringify(res.body)).not.toContain(fake.esewaConfig.secretKey);
    // The fake eSewa accepts the form only with a valid signature.
    await submitEsewaForm(checkout);
    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.gatewayReference).toBe(payment.id);
  });

  it("asking again returns the same checkout (no second payment)", async () => {
    const again = await intent(trip.id, "esewa");
    expect(again.status).toBe(200);
    expect(dataOf<IntentBody>(again)).toMatchObject({
      created: false,
      payment: { id: payment.id },
    });
    expect(dataOf<IntentBody>(again).checkout).toEqual(checkout);
  });

  it("a tampered callback is refused and changes nothing", async () => {
    const data = fake.esewa.signedData({
      transaction_code: "FORGED",
      status: "COMPLETE",
      total_amount: "3,600.0",
      transaction_uuid: payment.id,
      product_code: "EPAYTEST",
    });
    const decoded = JSON.parse(Buffer.from(data, "base64").toString()) as Record<string, string>;
    const forged = Buffer.from(JSON.stringify({ ...decoded, signature: "AAAA" })).toString(
      "base64",
    );
    expect(codeOf(await callback("esewa", { paymentId: payment.id, data: forged }))).toEqual([
      422,
      "PAYMENT_CALLBACK_INVALID",
    ]);
    // Correctly signed but eSewa's status API has not seen the payment complete: not paid.
    const notConfirmed = await callback("esewa", { paymentId: payment.id, data });
    expect(notConfirmed.status).toBe(200);
    expect(dataOf<ApplicationBody>(notConfirmed).outcome).toBe("pending");
    expect((await getTrip(trip.id)).onlinePayment.paidMinor).toBe("0");
  });

  it("a verified callback marks the trip paid", async () => {
    const data = fake.esewa.complete(payment.id);
    const res = await callback("esewa", { paymentId: payment.id, data });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = dataOf<ApplicationBody>(res);
    expect(body.outcome).toBe("paid");
    expect(body.payment).toMatchObject({
      status: "SUCCEEDED",
      capturedMinor: "360000",
      allocations: [{ itemId: trip.items[0]!.id, amountMinor: "360000" }],
    });
    expect(body.payment.gatewayTransactionId).toMatch(/^ESEWA/);
    const after = await getTrip(trip.id);
    expect(after.status).toBe("CONFIRMED");
    expect(after.items.map((i) => i.paymentStatus)).toEqual(["PAID"]);
  });

  it("a duplicate callback is a replay: one allocation, nothing charged twice", async () => {
    const data = fake.esewa.complete(payment.id);
    const results = await Promise.all([
      callback("esewa", { paymentId: payment.id, data }),
      callback("esewa", { paymentId: payment.id, data }),
      callback("esewa", { paymentId: payment.id }),
    ]);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(dataOf<ApplicationBody>(res).outcome).toBe("replayed");
    }
    expect(await prisma.paymentAllocation.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await prisma.paymentReconciliation.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  it("a callback for an unknown payment or the wrong gateway is a 404", async () => {
    expect(codeOf(await callback("esewa", { paymentId: randomUUID(), data: "x" }))).toEqual([
      404,
      "PAYMENT_NOT_FOUND",
    ]);
    expect(codeOf(await callback("khalti", { paymentId: payment.id, pidx: "x" }))).toEqual([
      404,
      "PAYMENT_NOT_FOUND",
    ]);
    expect((await callback("simulated", { paymentId: payment.id })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Khalti: initiate → return with pidx → lookup → paid", () => {
  it("initiates in paisa with the Key header; the return status alone is not trusted", async () => {
    const trip = await confirmedTrip();
    const res = await intent(trip.id, "khalti");
    expect(res.status).toBe(201);
    const { payment, checkout } = dataOf<IntentBody>(res);
    const pidx = pidxOf(checkout);
    expect(checkout).toEqual({ type: "redirect", url: `${fake.baseUrl}/khalti/pay/${pidx}` });
    const initiate = fake.khalti.requests.find(
      (r) => (r.body as { purchase_order_id?: string }).purchase_order_id === payment.id,
    );
    expect(initiate?.authorization).toBe(`Key ${fake.khaltiConfig.secretKey}`);
    expect(initiate?.body).toMatchObject({
      amount: 360000,
      return_url: `${WEB}/payments/khalti/return/${payment.id}`,
      website_url: WEB,
    });

    // The browser claims success; Khalti's lookup says Initiated: nothing is paid.
    const claimed = await callback("khalti", { paymentId: payment.id, pidx, status: "Completed" });
    expect(dataOf<ApplicationBody>(claimed).outcome).toBe("pending");
    // Another payment's pidx is refused.
    expect(codeOf(await callback("khalti", { paymentId: payment.id, pidx: "other" }))).toEqual([
      422,
      "PAYMENT_CALLBACK_INVALID",
    ]);

    fake.khalti.complete(pidx);
    const paid = await callback("khalti", { paymentId: payment.id, pidx });
    expect(dataOf<ApplicationBody>(paid)).toMatchObject({
      outcome: "paid",
      payment: { status: "SUCCEEDED", capturedMinor: "360000" },
    });
    const replay = await callback("khalti", { paymentId: payment.id, pidx });
    expect(dataOf<ApplicationBody>(replay).outcome).toBe("replayed");
    expect(await prisma.paymentAllocation.count({ where: { paymentId: payment.id } })).toBe(1);
    expect((await getTrip(trip.id)).status).toBe("CONFIRMED");
  });

  it("refresh asks Khalti server to server (owner only)", async () => {
    const trip = await confirmedTrip();
    const { payment, checkout } = dataOf<IntentBody>(await intent(trip.id, "khalti"));
    const refresh = (as: Client = me) =>
      call("post", `/api/v1/trips/${trip.id}/payments/${payment.id}/refresh`, {}, as);
    expect(dataOf<ApplicationBody>(await refresh()).outcome).toBe("pending");
    const stranger = await signUp("gateway-stranger");
    expect(codeOf(await refresh(stranger))).toEqual([404, "TRIP_NOT_FOUND"]);
    fake.khalti.complete(pidxOf(checkout));
    expect(dataOf<ApplicationBody>(await refresh()).outcome).toBe("paid");
  });

  it("a different paid amount is never applied: payment failed, money flagged", async () => {
    const trip = await confirmedTrip();
    const { payment, checkout } = dataOf<IntentBody>(await intent(trip.id, "khalti"));
    const pidx = pidxOf(checkout);
    fake.khalti.complete(pidx, { paidAmount: 1000 });
    const res = await callback("khalti", { paymentId: payment.id, pidx });
    const body = dataOf<ApplicationBody>(res);
    expect(body.outcome).toBe("reconciliation");
    expect(body.reconciliation?.reason).toBe("AMOUNT_MISMATCH");
    expect(body.payment).toMatchObject({ status: "FAILED", capturedMinor: "0", allocations: [] });
    const row = await prisma.paymentReconciliation.findUniqueOrThrow({
      where: { id: body.reconciliation!.id },
    });
    expect([row.amountMinor, row.status, row.tripId]).toEqual([1000n, "OPEN", trip.id]);
    expect((await getTrip(trip.id)).onlinePayment.paidMinor).toBe("0");
  });

  it("a cancelled Khalti payment closes the intent; a new one can start", async () => {
    const trip = await confirmedTrip();
    const { payment, checkout } = dataOf<IntentBody>(await intent(trip.id, "khalti"));
    fake.khalti.payments.get(pidxOf(checkout))!.status = "User canceled";
    const res = await callback("khalti", { paymentId: payment.id, pidx: pidxOf(checkout) });
    expect(dataOf<ApplicationBody>(res)).toMatchObject({
      outcome: "failed",
      payment: { status: "FAILED" },
    });
    const next = await intent(trip.id, "khalti");
    expect(next.status).toBe(201);
    expect(dataOf<IntentBody>(next).payment.id).not.toBe(payment.id);
  });

  it("an outage is a 502 and leaves the payment open", async () => {
    const trip = await confirmedTrip();
    const { payment, checkout } = dataOf<IntentBody>(await intent(trip.id, "khalti"));
    fake.setUnavailable(true);
    try {
      expect(
        codeOf(await callback("khalti", { paymentId: payment.id, pidx: pidxOf(checkout) })),
      ).toEqual([502, "PAYMENT_GATEWAY_UNAVAILABLE"]);
      // Starting a checkout while Khalti is down fails cleanly too.
      const other = await confirmedTrip();
      expect(codeOf(await intent(other.id, "khalti"))).toEqual([
        502,
        "PAYMENT_GATEWAY_UNAVAILABLE",
      ]);
      expect(await prisma.payment.findFirst({ where: { tripId: other.id } })).toMatchObject({
        status: "FAILED",
      });
    } finally {
      fake.setUnavailable(false);
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "INITIATED",
    );
  });

  it("an unknown gateway is refused", async () => {
    const trip = await confirmedTrip();
    expect((await intent(trip.id, "paypal")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe("late success after the hold expired (gap 8)", () => {
  let trip: Trip;
  let payment: PaymentBody;
  let reconciliationId: string;

  it("money confirmed after expiry is recorded and flagged once, never applied", async () => {
    trip = await confirmedTrip();
    const started = dataOf<IntentBody>(await intent(trip.id, "esewa"));
    payment = started.payment;
    await submitEsewaForm(started.checkout);

    // The hold runs out and the hold-release job sweeps the trip (payment cancelled).
    await prisma.trip.update({
      where: { id: trip.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await createTripsService({ prisma, now: () => new Date() }).expireStaleTrips(500);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).status).toBe(
      "EXPIRED",
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "CANCELLED",
    );

    // The customer had paid at eSewa just before: the callback arrives late.
    const data = fake.esewa.complete(payment.id);
    const res = await callback("esewa", { paymentId: payment.id, data });
    expect(res.status).toBe(200);
    const body = dataOf<ApplicationBody>(res);
    expect(body.outcome).toBe("reconciliation");
    expect(body.reconciliation?.reason).toBe("PAYMENT_NOT_OPEN");
    expect(body.payment).toMatchObject({
      status: "CANCELLED",
      capturedMinor: "0",
      allocations: [],
    });
    reconciliationId = body.reconciliation!.id;

    // Repeats (callback again, a refresh) find the same record.
    const again = await callback("esewa", { paymentId: payment.id, data });
    expect(dataOf<ApplicationBody>(again).reconciliation?.id).toBe(reconciliationId);
    const refreshed = await call(
      "post",
      `/api/v1/trips/${trip.id}/payments/${payment.id}/refresh`,
      {},
    );
    expect(dataOf<ApplicationBody>(refreshed).reconciliation?.id).toBe(reconciliationId);
    const rows = await prisma.paymentReconciliation.findMany({ where: { paymentId: payment.id } });
    expect(rows.map((r) => [r.amountMinor, r.currency, r.status, r.reason])).toEqual([
      [360000n, "NPR", "OPEN", "PAYMENT_NOT_OPEN"],
    ]);
    expect(await prisma.paymentAllocation.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  it("admins see it in the reconciliation list (others get 403)", async () => {
    const res = await call(
      "get",
      "/api/v1/admin/payment-reconciliations?status=OPEN",
      undefined,
      admin,
    );
    expect(res.status).toBe(200);
    const { data } = res.body as {
      data: { id: string; amountMinor: string; trip: { id: string } }[];
    };
    expect(data.find((r) => r.id === reconciliationId)).toMatchObject({
      amountMinor: "360000",
      trip: { id: trip.id },
    });
    expect((await call("get", "/api/v1/admin/payment-reconciliations")).status).toBe(403);
  });

  it("the gateway's record cannot be changed or deleted, even in SQL", async () => {
    const changed = await refusedBy(
      () =>
        prisma.$executeRaw`UPDATE payment_reconciliations SET amount_minor = 1 WHERE id = ${reconciliationId}::uuid`,
    );
    const deleted = await refusedBy(
      () =>
        prisma.$executeRaw`DELETE FROM payment_reconciliations WHERE id = ${reconciliationId}::uuid`,
    );
    for (const info of [changed, deleted]) {
      expect(info).toEqual({
        sqlState: "23514",
        constraint: "payment_reconciliations_immutable_chk",
      });
    }
  });

  it("refund requests are stored, never executed, and never above what was paid", async () => {
    const create = (body: object, as: Client = admin) =>
      call("post", "/api/v1/admin/refund-requests", body, as);
    const base = { paymentId: payment.id, paymentReconciliationId: reconciliationId };

    expect(
      codeOf(await create({ ...base, amountMinor: "360001", reason: "Hold expired" })),
    ).toEqual([422, "REFUND_EXCEEDS_PAID"]);
    expect((await create({ ...base, amountMinor: 1000, reason: "x" })).status).toBe(400);
    expect(
      (await create({ ...base, bookingItemId: trip.items[0]!.id, amountMinor: "1", reason: "x" }))
        .status,
    ).toBe(400);
    expect((await create({ ...base, amountMinor: "1", reason: "x" }, me)).status).toBe(403);

    const res = await create({
      ...base,
      amountMinor: "360000",
      reason: "Paid after the hold expired",
    });
    expect(res.status).toBe(201);
    const refund = (res.body as { data: Record<string, unknown> }).data;
    expect(refund).toMatchObject({
      paymentId: payment.id,
      paymentReconciliationId: reconciliationId,
      gateway: "esewa",
      amountMinor: "360000",
      currency: "NPR",
      status: "REQUESTED",
      executed: false,
      gatewayRefundCapability: { api: "none" },
    });
    // Nothing more can be requested, and nothing was sent anywhere.
    expect(codeOf(await create({ ...base, amountMinor: "1", reason: "again" }))).toEqual([
      422,
      "REFUND_EXCEEDS_PAID",
    ]);
    expect(await prisma.payment.count({ where: { tripId: trip.id, kind: "REFUND" } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "refund_request", entityId: refund.id as string },
    });
    expect(audit?.action).toBe("refund_request.create");

    // The database itself refuses executing a refund in this phase, and over-refunds.
    const executed = await refusedBy(
      () =>
        prisma.$executeRaw`UPDATE refund_requests SET status = 'COMPLETED' WHERE id = ${refund.id as string}::uuid`,
    );
    expect(executed).toEqual({ sqlState: "23514", constraint: "refund_requests_not_executed_chk" });
    const over = await refusedBy(() =>
      prisma.refundRequest.create({
        data: {
          paymentId: payment.id,
          paymentReconciliationId: reconciliationId,
          gateway: "esewa",
          amountMinor: 1n,
          currency: "NPR",
          reason: "bypassing the API",
        },
      }),
    );
    expect(over).toEqual({ sqlState: "23514", constraint: "refund_requests_within_payment_chk" });

    const list = await call(
      "get",
      `/api/v1/admin/refund-requests?paymentId=${payment.id}`,
      undefined,
      admin,
    );
    expect((list.body as { data: unknown[] }).data).toHaveLength(1);
  });

  it("a refund request for a paid booking item is limited to its allocation", async () => {
    const paidTrip = await confirmedTrip();
    const started = dataOf<IntentBody>(await intent(paidTrip.id, "khalti"));
    fake.khalti.complete(pidxOf(started.checkout));
    await callback("khalti", { paymentId: started.payment.id, pidx: pidxOf(started.checkout) });
    const body = {
      paymentId: started.payment.id,
      bookingItemId: paidTrip.items[0]!.id,
      reason: "Customer cancelled",
    };
    const ok = await call(
      "post",
      "/api/v1/admin/refund-requests",
      { ...body, amountMinor: "200000" },
      admin,
    );
    expect(ok.status).toBe(201);
    expect(
      (ok.body as { data: { gatewayRefundCapability: { api: string } } }).data
        .gatewayRefundCapability.api,
    ).toBe("documented");
    const more = await call(
      "post",
      "/api/v1/admin/refund-requests",
      { ...body, amountMinor: "160001" },
      admin,
    );
    expect(codeOf(more)).toEqual([422, "REFUND_EXCEEDS_PAID"]);
  });

  it("admins resolve a late payment once, with a note (audited)", async () => {
    const resolve = (note: string) =>
      call(
        "post",
        `/api/v1/admin/payment-reconciliations/${reconciliationId}/resolve`,
        { note },
        admin,
      );
    const res = await resolve("Refund requested; customer told by phone.");
    expect(res.status).toBe(200);
    expect((res.body as { data: { status: string; resolvedById: string } }).data).toMatchObject({
      status: "RESOLVED",
      resolvedById: admin.userId,
    });
    expect(codeOf(await resolve("again"))).toEqual([409, "RECONCILIATION_ALREADY_RESOLVED"]);
    expect(
      await prisma.auditLog.count({
        where: { entityId: reconciliationId, action: "payment_reconciliation.resolve" },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("customers who never come back: the hold-release check (gap 8)", () => {
  const job = (minutesAhead = 0) =>
    createPaymentsService({
      prisma,
      now: () => new Date(Date.now() + minutesAhead * 60_000),
      config: paymentsConfig,
    });
  const setHold = (tripId: string, msFromNow: number) =>
    prisma.trip.update({
      where: { id: tripId },
      data: { expiresAt: new Date(Date.now() + msFromNow) },
    });

  it("paid at Khalti before the hold ended: applied by the job without any callback", async () => {
    const trip = await confirmedTrip();
    const { payment, checkout } = dataOf<IntentBody>(await intent(trip.id, "khalti"));
    fake.khalti.complete(pidxOf(checkout)); // the customer closes the tab at Khalti
    await setHold(trip.id, 60_000); // the hold ends in a minute

    const result = await job().checkExpiringPayments(500);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect((await getTrip(trip.id)).status).toBe("CONFIRMED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "SUCCEEDED",
    );
    // Checking again changes nothing (the payment is no longer open).
    await job().checkExpiringPayments(500);
    expect(await prisma.paymentAllocation.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("paid at eSewa but found only after the hold ended: recorded, not dropped", async () => {
    const trip = await confirmedTrip();
    const started = dataOf<IntentBody>(await intent(trip.id, "esewa"));
    await submitEsewaForm(started.checkout);
    fake.esewa.complete(started.payment.id);
    await setHold(trip.id, -1_000);

    await job().checkExpiringPayments(500);
    await createTripsService({ prisma, now: () => new Date() }).expireStaleTrips(500);
    const rows = await prisma.paymentReconciliation.findMany({
      where: { paymentId: started.payment.id },
    });
    expect(rows.map((r) => [r.reason, r.amountMinor])).toEqual([
      ["TRIP_NOT_AWAITING_PAYMENT", 360000n],
    ]);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: started.payment.id } })).status,
    ).toBe("CANCELLED");
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } })).status).toBe(
      "EXPIRED",
    );
  });

  it("not paid: left alone for the sweep; a gateway outage is counted, never fatal", async () => {
    const trip = await confirmedTrip();
    const { payment, checkout } = dataOf<IntentBody>(await intent(trip.id, "khalti"));
    await setHold(trip.id, 30_000);
    await job().checkExpiringPayments(500);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "INITIATED",
    );
    fake.setUnavailable(true);
    try {
      expect((await job().checkExpiringPayments(500)).unavailable).toBeGreaterThanOrEqual(1);
    } finally {
      fake.setUnavailable(false);
    }
    // Holds far from their end are not checked at all.
    await setHold(trip.id, 20 * 60_000);
    const before = fake.khalti.requests.length;
    await job().checkExpiringPayments(500);
    expect(
      fake.khalti.requests
        .slice(before)
        .filter((r) => (r.body as { pidx?: string }).pidx === pidxOf(checkout)),
    ).toEqual([]);
  });
});

describe("configuration", () => {
  it("without gateways, online payments are unavailable (503)", async () => {
    const bare = createApp({
      logger: pino({ level: "silent" }),
      checkDatabase: () => Promise.resolve(),
      prisma,
      auth: testAuthConfig(),
    });
    const res = await request(bare)
      .post("/api/v1/payment-callbacks/esewa")
      .send({ paymentId: randomUUID(), data: "x" });
    expect(res.status).toBe(503);
  });

  it("production refuses to start without gateway configuration", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: API_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        MEROSTAY_SKIP_ENV_FILE: "1",
        NODE_ENV: "production",
        // Placeholders: the process must stop at configuration, before any connection.
        DATABASE_URL: "postgresql://u:p@db.invalid:5432/merostay?sslmode=require",
        SESSION_SECRET: "x".repeat(48),
        TRUST_PROXY_HOPS: "1",
        TRUST_PROXY_ADDRESSES: "loopback",
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_DIR: "/tmp/merostay-never-used",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/PAYMENT_GATEWAYS: is required in production/);
    expect(result.stderr).not.toMatch(/listening/i);
  });
});

it("money stays a digit string in every response (ADR 0005)", () => {
  expect(moneyBoundaryViolations(responses)).toEqual([]);
});

/** Runs a raw write that the database must refuse; returns the SQLSTATE and constraint name. */
async function refusedBy(write: () => Promise<unknown>) {
  try {
    await write();
  } catch (err) {
    const info = inspectDatabaseError(err);
    if (info) return info;
    throw err;
  }
  throw new Error("expected the database to refuse this write");
}

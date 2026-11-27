import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { toNepalLocal } from "../../domain/refunds.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
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
import { resolveTestDatabase } from "../../testing/test-database.js";
import { hashPassword } from "../auth/password.js";

/**
 * Phase 14 (ADR 0020): customer cancellations on the frozen policy with the refund clock (the
 * ACTUAL service start, Nepal time), refund execution (Khalti refund API against the local fake,
 * eSewa by hand), idempotency and concurrency, partial refunds and limits, the payout of what was
 * kept, settlement reconciliation (gap 36) and voiding a paid-out booking with a clawback (gap 39).
 */

vi.setConfig({ testTimeout: 180_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const H = 3_600_000;
const PASSWORD = "a long test passphrase";
const WEB = "http://web.test";

// One clock for the app: real time unless a test pins it (then everyone logs in again).
let pinned: Date | null = null;
const now = () => pinned ?? new Date();

let fake: FakeGateways;
let app: ReturnType<typeof createApp>;
let world: World;

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
  email: string;
  providerId?: string;
}
let customer: Client;
let stranger: Client;
let admin: Client;
let hotelPartner: Client;
let busPartner: Client;
const responses: unknown[] = [];

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const res = await agent
    .post("/api/v1/auth/register")
    .send({ email, password: PASSWORD, fullName: label });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrf: body.data.csrfToken, userId: body.data.user.id, email };
}

async function relogin(client: Client): Promise<void> {
  client.agent = request.agent(app);
  const res = await client.agent
    .post("/api/v1/auth/login")
    .send({ email: client.email, password: PASSWORD });
  expect(res.status).toBe(200);
  client.csrf = (res.body as { data: { csrfToken: string } }).data.csrfToken;
}

/** Pins the app's clock (null = real time); sessions are renewed under the new clock. */
async function setClock(at: Date | null): Promise<void> {
  pinned = at;
  for (const client of [customer, stranger, admin, hotelPartner, busPartner]) {
    await relogin(client);
  }
}

async function call(
  as: Client,
  method: "get" | "post",
  url: string,
  body?: object,
  headers: Record<string, string> = {},
) {
  let req = as.agent[method](url).set("X-CSRF-Token", as.csrf);
  if (as.providerId) req = req.set("X-Provider-Id", as.providerId);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}

const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error.code];

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

interface TripItem {
  id: string;
  status: string;
  paymentStatus: string;
  serviceStartsAt: string;
  serviceStartsAtNepal: string;
  serviceStartSource: string;
  money: { totalMinor: string; refundedMinor: string };
  cancellation: { refundBps: number; refundMinor: string } | null;
}
interface TripBody {
  id: string;
  status: string;
  items: TripItem[];
}
interface Preview {
  cancellable: boolean;
  refusal: { code: string } | null;
  serviceStartsAt: string;
  serviceStartsAtNepal: string;
  serviceStartSource: string;
  noticeMinutes: number;
  refundBps: number;
  tier: { minHoursBeforeStart: number; refundBps: number } | null;
  paidMinor: string;
  refundMinor: string;
}
interface RefundBody {
  id: string;
  status: string;
  executed: boolean;
  executionMode: string | null;
  amountMinor: string;
  gateway: string;
  note: string | null;
  attempts: number;
  gatewayRefundReferenceMasked: string | null;
  failureReason: string | null;
}

/** Books one item on a new trip and confirms it; online items are paid through `gateway`. */
async function bookedTrip(item: {
  listingId: string;
  startDate: string;
  endDate?: string;
  quantity: number;
  paymentMethod: "online" | "pay_at_property";
  gateway?: "khalti" | "esewa" | "simulated";
}): Promise<{ tripId: string; itemId: string }> {
  const { gateway, ...line } = item;
  const created = await call(customer, "post", "/api/v1/trips", { currency: "NPR" });
  const tripId = dataOf<{ id: string }>(created).id;
  expect((await call(customer, "post", `/api/v1/trips/${tripId}/items`, line)).status).toBe(201);
  const confirmed = await call(customer, "post", `/api/v1/trips/${tripId}/confirm`);
  expect(confirmed.status).toBe(200);
  const itemId = dataOf<TripBody>(confirmed).items[0]!.id;
  if (item.paymentMethod === "online") {
    const intent = await call(customer, "post", `/api/v1/trips/${tripId}/payments/intent`, {
      gateway,
    });
    expect(intent.status).toBe(201);
    const { payment, checkout } = dataOf<{
      payment: { id: string };
      checkout: { type: string; url: string; fields?: Record<string, string> };
    }>(intent);
    if (gateway === "khalti") {
      const pidx = checkout.url.split("/").at(-1)!;
      fake.khalti.complete(pidx);
      const res = await request(app)
        .post("/api/v1/payment-callbacks/khalti")
        .send({ paymentId: payment.id, pidx });
      expect(res.status).toBe(200);
    } else if (gateway === "esewa") {
      await fetch(checkout.url, { method: "POST", body: new URLSearchParams(checkout.fields) });
      const data = fake.esewa.complete(payment.id);
      const res = await request(app)
        .post("/api/v1/payment-callbacks/esewa")
        .send({ paymentId: payment.id, data });
      expect(res.status).toBe(200);
    } else {
      const res = await call(
        customer,
        "post",
        `/api/v1/trips/${tripId}/payments/${payment.id}/confirm`,
        {},
      );
      expect(res.status).toBe(200);
    }
    const stored = await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(stored.paymentStatus).toBe("PAID");
  }
  return { tripId, itemId };
}

const preview = async (tripId: string, itemId: string, as: Client = customer) =>
  call(as, "get", `/api/v1/trips/${tripId}/items/${itemId}/cancellation`);
const cancel = (tripId: string, itemId: string, expectedRefundMinor: string, as = customer) =>
  call(as, "post", `/api/v1/trips/${tripId}/items/${itemId}/cancel`, { expectedRefundMinor });
const refundsOf = (itemId: string) =>
  prisma.refundRequest.findMany({
    where: { bookingItemId: itemId },
    orderBy: { createdAt: "asc" },
  });
const step = (id: string, action: string, body?: object, as: Client = admin) =>
  call(as, "post", `/api/v1/admin/refund-requests/${id}/${action}`, body ?? {});
const khaltiRefundCalls = () =>
  fake.khalti.requests.filter((r) => r.path.includes("/merchant-transaction/")).length;

async function partnerOf(w: World, providerId: string): Promise<Client> {
  const email = `owner-${w.suffix}@test.local`;
  await prisma.user.update({
    where: { id: w.users.owner.id },
    data: { email, role: "PARTNER", passwordHash: await hashPassword(PASSWORD) },
  });
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrf: body.data.csrfToken, userId: body.data.user.id, email, providerId };
}

beforeAll(async () => {
  fake = await startFakeGateways(testGatewayKeys());
  app = createApp({
    logger: pino({ level: "silent" }),
    checkDatabase: () => Promise.resolve(),
    prisma,
    auth: testAuthConfig(),
    payments: {
      gateways: createGateways({
        esewa: fake.esewaConfig,
        khalti: fake.khaltiConfig,
        simulated: true,
      }),
      publicWebUrl: WEB,
      mode: "uat",
    },
    now,
  });
  world = await createWorld(prisma);
  customer = await signUp("refund-customer");
  stranger = await signUp("refund-stranger");
  admin = await signUp("refund-admin");
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
  hotelPartner = await partnerOf(world, world.providers.hotelProvider.id);
  busPartner = { ...(await partnerOf(world, world.providers.busProvider.id)) };
  for (const [i, providerId] of [
    world.providers.hotelProvider.id,
    world.providers.busProvider.id,
  ].entries()) {
    await prisma.providerPayoutAccount.create({
      data: {
        providerId,
        bankName: "Nabil Bank",
        accountName: "Test Provider",
        accountNumber: `02020000000${i}4321`,
        isDefault: true,
        verifiedAt: new Date(),
      },
    });
  }
});

afterAll(async () => {
  pinned = null;
  await fake.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
describe("the refund clock: each item freezes its ACTUAL start (owner decision 2026-11-27)", () => {
  it("a room starts at its hotel's check-in, a bus at its departure, a guide without a time at midnight", async () => {
    const room = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(0),
      endDate: world.day(1),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const bus = await bookedTrip({
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const guide = await bookedTrip({
      listingId: world.listings.guide.id,
      startDate: world.day(5),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const items = await Promise.all(
      [room, bus, guide].map(
        async ({ tripId }) =>
          dataOf<TripBody>(await call(customer, "get", `/api/v1/trips/${tripId}`)).items[0]!,
      ),
    );
    expect(items.map((i) => [i.serviceStartsAtNepal, i.serviceStartSource])).toEqual([
      [`${world.day(0)}T13:00`, "LISTING_TIME"],
      [`${world.day(1)}T06:30`, "LISTING_TIME"],
      [`${world.day(5)}T00:00`, "DEFAULT_MIDNIGHT"],
    ]);
    // Stored in UTC: 13:00 Kathmandu = 07:15 UTC.
    expect(items[0]!.serviceStartsAt).toBe(`${world.day(0)}T07:15:00.000Z`);
    // Clean up: these only checked the clock.
    for (const t of [room, bus, guide]) {
      const p = dataOf<Preview>(await preview(t.tripId, t.itemId));
      expect((await cancel(t.tripId, t.itemId, p.refundMinor)).status).toBe(200);
    }
  });

  it("a guide listing with a start time freezes it; editing the time later never changes bookings", async () => {
    await prisma.guideServiceDetail.update({
      where: { listingId: world.listings.guide.id },
      data: { startTime: "07:00" },
    });
    const guide = await bookedTrip({
      listingId: world.listings.guide.id,
      startDate: world.day(5),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    await prisma.guideServiceDetail.update({
      where: { listingId: world.listings.guide.id },
      data: { startTime: "09:00" },
    });
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: guide.itemId } });
    expect([toNepalLocal(item.serviceStartsAt), item.serviceStartSource]).toEqual([
      `${world.day(5)}T07:00`,
      "LISTING_TIME",
    ]);
    const p = dataOf<Preview>(await preview(guide.tripId, guide.itemId));
    expect((await cancel(guide.tripId, guide.itemId, p.refundMinor)).status).toBe(200);
  });

  it("the database refuses a start that is not on the start date (Nepal time) or a fake midnight", async () => {
    const item = await prisma.bookingItem.findFirstOrThrow({
      where: { listingId: world.listings.room.id },
    });
    expect(
      await refusedBy(() =>
        prisma.bookingItem.update({
          where: { id: item.id },
          data: { serviceStartsAt: new Date(item.serviceStartsAt.getTime() + 48 * H) },
        }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_service_start_date_chk" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("cancellation tiers use exact instants (Khalti, partial refund)", () => {
  let tripId: string;
  let itemId: string;
  let startsAt: Date;

  beforeAll(async () => {
    ({ tripId, itemId } = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(2),
      endDate: world.day(3),
      quantity: 1,
      paymentMethod: "online",
      gateway: "khalti",
    }));
    startsAt = (await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } }))
      .serviceStartsAt;
  });

  it("exactly 72 h before check-in: 100%; 71 h 59 m: 50%; exactly 24 h: 50%; 23 h 59 m: nothing", async () => {
    const cases: [number, number][] = [
      [72 * H, 10_000],
      [71 * H + 59 * 60_000, 5_000],
      [24 * H, 5_000],
      [23 * H + 59 * 60_000, 0],
    ];
    for (const [before, bps] of cases) {
      await setClock(new Date(startsAt.getTime() - before));
      const p = dataOf<Preview>(await preview(tripId, itemId));
      expect([p.refundBps, p.noticeMinutes], `${before / 60_000} min before`).toEqual([
        bps,
        before / 60_000,
      ]);
    }
  });

  it("the customer sees no commission; a stale refund amount is refused (the tier boundary passed)", async () => {
    await setClock(new Date(startsAt.getTime() - 30 * H));
    const res = await preview(tripId, itemId);
    expect(JSON.stringify(res.body)).not.toMatch(/commission/i);
    const p = dataOf<Preview>(res);
    // Rs 3,500 + 10% service charge + 13% VAT = Rs 4,350.50; 50% back = Rs 2,175.25.
    expect(p).toMatchObject({
      cancellable: true,
      refundBps: 5_000,
      paidMinor: "435050",
      refundMinor: "217525",
    });
    expect(codeOf(await cancel(tripId, itemId, "435050"))).toEqual([
      409,
      "CANCELLATION_TERMS_CHANGED",
    ]);
    expect(codeOf(await cancel(tripId, itemId, "217525", stranger))).toEqual([
      404,
      "TRIP_NOT_FOUND",
    ]);
    expect((await preview(tripId, itemId, stranger)).status).toBe(404);
  });

  it("cancels: tier, refund and the commission on the half kept are frozen; one refund REQUEST", async () => {
    const before = await prisma.inventorySlot.findFirstOrThrow({
      where: {
        listingId: world.listings.room.id,
        serviceDate: new Date(`${world.day(2)}T00:00:00Z`),
      },
    });
    const res = await cancel(tripId, itemId, "217525");
    expect(res.status).toBe(200);
    const item = dataOf<TripBody>(res).items.find((i) => i.id === itemId)!;
    expect(item).toMatchObject({
      status: "CANCELLED",
      cancellation: { refundBps: 5_000, refundMinor: "217525" },
    });
    expect(dataOf<TripBody>(res).status).toBe("CANCELLED");
    const stored = await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } });
    // Commission on the kept half: 15% × 50% × Rs 3,500 = Rs 262.50.
    expect(stored).toMatchObject({
      cancellationRefundBps: 5_000,
      cancellationRefundMinor: 217_525n,
      keptCommissionMinor: 26_250n,
      commissionStatus: "PENDING",
      cancelledById: customer.userId,
    });
    const after = await prisma.inventorySlot.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.capacityBooked).toBe(before.capacityBooked - 1);
    expect((await refundsOf(itemId)).map((r) => [r.status, r.amountMinor, r.gateway])).toEqual([
      ["REQUESTED", 217_525n, "khalti"],
    ]);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "booking_item.cancel", entityId: itemId },
    });
    expect(audit?.actorUserId).toBe(customer.userId);
    // Again: same answer, nothing new.
    expect((await cancel(tripId, itemId, "217525")).status).toBe(200);
    expect(await refundsOf(itemId)).toHaveLength(1);
  });

  it("non-admins cannot touch the refund queue", async () => {
    const [refund] = await refundsOf(itemId);
    for (const client of [customer, hotelPartner]) {
      expect((await step(refund!.id, "approve", {}, client)).status).toBe(403);
      expect((await call(client, "get", "/api/v1/admin/refund-requests")).status).toBe(403);
    }
  });

  it("approve → execute: Khalti's refund API is called once with the partial amount in paisa", async () => {
    await setClock(null);
    const [refund] = await refundsOf(itemId);
    expect(codeOf(await step(refund!.id, "execute"))).toEqual([409, "REFUND_NOT_ALLOWED"]);
    const approved = await step(refund!.id, "approve");
    expect(dataOf<RefundBody>(approved)).toMatchObject({ status: "APPROVED", executed: false });
    expect((approved.body as { changed: boolean }).changed).toBe(true);
    expect((await step(refund!.id, "approve")).body).toMatchObject({ changed: false });

    const calls = khaltiRefundCalls();
    const executed = await step(refund!.id, "execute");
    expect(dataOf<RefundBody>(executed)).toMatchObject({
      status: "COMPLETED",
      executed: true,
      executionMode: "API",
      attempts: 1,
    });
    expect(khaltiRefundCalls()).toBe(calls + 1);
    const sent = fake.khalti.requests
      .filter((r) => r.path.includes("/merchant-transaction/"))
      .at(-1)!;
    expect(sent.body).toEqual({ amount: 217_525 });
    expect(sent.authorization).toBe(`Key ${fake.khaltiConfig.secretKey}`);
    // Executing again: no second call.
    expect((await step(refund!.id, "execute")).body).toMatchObject({ changed: false });
    expect(khaltiRefundCalls()).toBe(calls + 1);

    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } });
    expect([item.paymentStatus, item.refundedMinor]).toEqual(["PARTIALLY_REFUNDED", 217_525n]);
    const actions = (
      await prisma.auditLog.findMany({
        where: { entityId: refund!.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((a) => a.action);
    // Created by the customer's cancellation (audited as booking_item.cancel), then:
    expect(actions).toEqual([
      "refund_request.approve",
      "refund_request.execute",
      "refund_request.complete.api",
    ]);
  });

  it("a refund above what was paid is refused, by the API and by the database", async () => {
    const payment = await prisma.payment.findFirstOrThrow({
      where: { tripId, kind: "CHARGE", status: "SUCCEEDED" },
    });
    expect(
      codeOf(
        await call(admin, "post", "/api/v1/admin/refund-requests", {
          paymentId: payment.id,
          bookingItemId: itemId,
          amountMinor: "217526",
          reason: "more than is left",
        }),
      ),
    ).toEqual([422, "REFUND_EXCEEDS_PAID"]);
    expect(
      await refusedBy(() =>
        prisma.refundRequest.create({
          data: {
            paymentId: payment.id,
            bookingItemId: itemId,
            gateway: "khalti",
            amountMinor: 217_526n,
            currency: "NPR",
            reason: "bypassing the API",
          },
        }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "refund_requests_within_payment_chk" });
  });

  it("the database keeps refunded = completed refunds, and a finished refund final", async () => {
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`UPDATE booking_items SET refunded_minor = 1 WHERE id = ${itemId}::uuid`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_refunds_match_chk" });
    const [refund] = await refundsOf(itemId);
    expect(
      await refusedBy(() =>
        prisma.refundRequest.update({ where: { id: refund!.id }, data: { status: "PROCESSING" } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "refund_requests_final_chk" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("eSewa has no refund API: refunded by hand, then recorded", () => {
  let itemId: string;
  let refundId: string;

  it("a full refund (100% tier) waits as MANUAL until an admin records the eSewa reference", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(2),
      endDate: world.day(3),
      quantity: 1,
      paymentMethod: "online",
      gateway: "esewa",
    });
    itemId = booked.itemId;
    const p = dataOf<Preview>(await preview(booked.tripId, itemId));
    expect([p.refundBps, p.refundMinor]).toEqual([10_000, "435050"]);
    expect((await cancel(booked.tripId, itemId, "435050")).status).toBe(200);
    // Nothing kept → commission waived.
    expect(await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({
      commissionStatus: "WAIVED",
      keptCommissionMinor: 0n,
    });
    refundId = (await refundsOf(itemId))[0]!.id;
    await step(refundId, "approve");
    const executed = dataOf<RefundBody>(await step(refundId, "execute"));
    expect(executed).toMatchObject({
      status: "PROCESSING",
      executionMode: "MANUAL",
      executed: false,
    });
    expect(executed.note).toMatch(/eSewa merchant portal/);
  });

  it("complete with the reference: COMPLETED, item REFUNDED; the same reference again is a no-op", async () => {
    expect(codeOf(await step(refundId, "complete", { reference: "x" }))).toEqual([
      400,
      "VALIDATION_ERROR",
    ]);
    const done = await step(refundId, "complete", {
      reference: "ESEWA-REF-778899",
      note: "Refunded in the eSewa merchant portal",
    });
    expect(dataOf<RefundBody>(done)).toMatchObject({
      status: "COMPLETED",
      executed: true,
      gatewayRefundReferenceMasked: "••••8899",
    });
    expect(JSON.stringify(done.body)).not.toContain("ESEWA-REF-778899");
    expect(
      (await step(refundId, "complete", { reference: "ESEWA-REF-778899" })).body,
    ).toMatchObject({
      changed: false,
    });
    expect(codeOf(await step(refundId, "complete", { reference: "ESEWA-OTHER-1" }))).toEqual([
      409,
      "REFUND_ALREADY_COMPLETED",
    ]);
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: itemId } });
    expect([item.paymentStatus, item.refundedMinor]).toEqual(["REFUNDED", 435_050n]);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: refundId, action: "refund_request.complete.manual" },
    });
    expect(JSON.stringify(audit?.after)).not.toContain("ESEWA-REF-778899");
    expect(audit?.actorUserId).toBe(admin.userId);
  });
});

// ---------------------------------------------------------------------------------------------
describe("double execution, lost answers and refusals", () => {
  it("two executes at once call Khalti once and complete once", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(3),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "online",
      gateway: "khalti",
    });
    const p = dataOf<Preview>(await preview(booked.tripId, booked.itemId));
    expect((await cancel(booked.tripId, booked.itemId, p.refundMinor)).status).toBe(200);
    const refund = (await refundsOf(booked.itemId))[0]!;
    const approvals = await Promise.all([step(refund.id, "approve"), step(refund.id, "approve")]);
    expect(approvals.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await prisma.auditLog.count({
        where: { entityId: refund.id, action: "refund_request.approve" },
      }),
    ).toBe(1);
    const calls = khaltiRefundCalls();
    const results = await Promise.all([step(refund.id, "execute"), step(refund.id, "execute")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
    expect(khaltiRefundCalls()).toBe(calls + 1);
    expect(
      (await prisma.refundRequest.findUniqueOrThrow({ where: { id: refund.id } })).status,
    ).toBe("COMPLETED");
    // A full refund sends no amount (Khalti's documented full refund).
    const sent = fake.khalti.requests
      .filter((r) => r.path.includes("/merchant-transaction/"))
      .at(-1)!;
    expect(sent.body).toEqual({});
  });

  it("a lost answer (Khalti refunded, then 503) stays PROCESSING; check settles it from the lookup", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(3),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "online",
      gateway: "khalti",
    });
    const p = dataOf<Preview>(await preview(booked.tripId, booked.itemId));
    await cancel(booked.tripId, booked.itemId, p.refundMinor);
    const refund = (await refundsOf(booked.itemId))[0]!;
    await step(refund.id, "approve");
    fake.khalti.setRefundMode("lost");
    try {
      const executed = dataOf<RefundBody>(await step(refund.id, "execute"));
      expect(executed).toMatchObject({ status: "PROCESSING", executionMode: "API" });
    } finally {
      fake.khalti.setRefundMode("ok");
    }
    const calls = khaltiRefundCalls();
    // Executing again never calls Khalti a second time while the first is unresolved.
    expect((await step(refund.id, "execute")).body).toMatchObject({ changed: false });
    expect(khaltiRefundCalls()).toBe(calls);
    const checked = await step(refund.id, "check");
    expect(dataOf<RefundBody>(checked)).toMatchObject({ status: "COMPLETED", executed: true });
    expect(khaltiRefundCalls()).toBe(calls);
    expect(
      (await prisma.bookingItem.findUniqueOrThrow({ where: { id: booked.itemId } })).paymentStatus,
    ).toBe("REFUNDED");
  });

  it("a refusal by Khalti is FAILED with the reason; retry or reject (with a note)", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(3),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "online",
      gateway: "khalti",
    });
    const p = dataOf<Preview>(await preview(booked.tripId, booked.itemId));
    await cancel(booked.tripId, booked.itemId, p.refundMinor);
    const refund = (await refundsOf(booked.itemId))[0]!;
    await step(refund.id, "approve");
    fake.khalti.setRefundMode("reject");
    try {
      expect(dataOf<RefundBody>(await step(refund.id, "execute"))).toMatchObject({
        status: "FAILED",
        failureReason: "Khalti refused the refund.",
      });
    } finally {
      fake.khalti.setRefundMode("ok");
    }
    expect(codeOf(await step(refund.id, "reject", {}))).toEqual([400, "VALIDATION_ERROR"]);
    const retried = dataOf<RefundBody>(await step(refund.id, "execute"));
    expect(retried).toMatchObject({ status: "COMPLETED", attempts: 2 });
    expect(codeOf(await step(refund.id, "reject", { note: "too late" }))).toEqual([
      409,
      "REFUND_NOT_ALLOWED",
    ]);
  });

  it("reject: a request nobody should pay; rejecting again changes nothing", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 1,
      paymentMethod: "online",
      gateway: "simulated",
    });
    // The bus has no cancellation policy: cancelling gives nothing back (owner decision).
    const p = dataOf<Preview>(await preview(booked.tripId, booked.itemId));
    expect([p.cancellable, p.refundBps, p.refundMinor]).toEqual([true, 0, "0"]);
    await cancel(booked.tripId, booked.itemId, "0");
    expect(await refundsOf(booked.itemId)).toHaveLength(0);
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: booked.itemId } });
    expect([item.commissionStatus, item.keptCommissionMinor]).toEqual([
      "PENDING",
      item.commissionMinor,
    ]);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { tripId: booked.tripId, kind: "CHARGE", status: "SUCCEEDED" },
    });
    const created = await call(admin, "post", "/api/v1/admin/refund-requests", {
      paymentId: payment.id,
      bookingItemId: booked.itemId,
      amountMinor: "10000",
      reason: "Goodwill gesture requested",
    });
    const id = dataOf<RefundBody>(created).id;
    const rejected = await step(id, "reject", { note: "Policy says no refund" });
    expect(dataOf<RefundBody>(rejected)).toMatchObject({
      status: "REJECTED",
      note: "Policy says no refund",
    });
    expect((await step(id, "reject", { note: "again" })).body).toMatchObject({ changed: false });
    expect(codeOf(await step(id, "approve"))).toEqual([409, "REFUND_NOT_ALLOWED"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("pay at property: nothing to refund; commission waived and the invoice adjusted", () => {
  it("cancelling an invoiced pay-at-property item voids its invoice through an adjustment", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(1),
      endDate: world.day(2),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const before = await prisma.bookingItem.findUniqueOrThrow({ where: { id: booked.itemId } });
    expect(before.commissionStatus).toBe("INVOICED");
    const p = dataOf<Preview>(await preview(booked.tripId, booked.itemId));
    expect([p.refundMinor, p.paidMinor]).toEqual(["0", "0"]);
    expect((await cancel(booked.tripId, booked.itemId, "0")).status).toBe(200);
    const after = await prisma.bookingItem.findUniqueOrThrow({
      where: { id: booked.itemId },
      include: { invoiceAdjustment: true, commissionInvoice: true },
    });
    expect([
      after.commissionStatus,
      after.invoiceAdjustment?.amountMinor,
      after.commissionInvoice?.status,
    ]).toEqual(["WAIVED", before.commissionMinor, "VOID"]);
  });

  it("an item settled at the property cannot be cancelled by the customer", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(1),
      endDate: world.day(2),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const settled = await call(
      hotelPartner,
      "post",
      `/api/v1/partner/bookings/${booked.itemId}/settle-at-property`,
      {},
      { "Idempotency-Key": randomUUID() },
    );
    expect(settled.status).toBe(200);
    expect(dataOf<Preview>(await preview(booked.tripId, booked.itemId)).refusal?.code).toBe(
      "ITEM_SETTLED_AT_PROPERTY",
    );
    expect(codeOf(await cancel(booked.tripId, booked.itemId, "0"))).toEqual([
      409,
      "ITEM_SETTLED_AT_PROPERTY",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("settlement reconciliation (gap 36)", () => {
  it("flags a settlement recorded before the service started; resolving is audited; non-admins blocked", async () => {
    // The previous test's item was settled now, days before its check-in.
    const list = await call(admin, "get", "/api/v1/admin/settlement-reconciliation?state=open");
    expect(list.status).toBe(200);
    const entries =
      dataOf<{ itemId: string; mismatches: { kind: string; resolution: unknown }[] }[]>(list);
    const early = entries.find((e) =>
      e.mismatches.some((m) => m.kind === "SETTLED_BEFORE_SERVICE"),
    );
    expect(early).toBeDefined();
    for (const client of [customer, hotelPartner]) {
      expect((await call(client, "get", "/api/v1/admin/settlement-reconciliation")).status).toBe(
        403,
      );
    }
    const url = `/api/v1/admin/settlement-reconciliation/${early!.itemId}/resolve`;
    expect(
      codeOf(await call(admin, "post", url, { kind: "UNSETTLED_AFTER_SERVICE", note: "n/a" })),
    ).toEqual([409, "SETTLEMENT_MISMATCH_NOT_FOUND"]);
    const resolved = await call(admin, "post", url, {
      kind: "SETTLED_BEFORE_SERVICE",
      note: "Guest paid a deposit at booking; confirmed by phone with the hotel.",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ changed: true });
    expect(
      (await call(admin, "post", url, { kind: "SETTLED_BEFORE_SERVICE", note: "again" })).body,
    ).toMatchObject({
      changed: false,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "settlement_reconciliation.resolve", entityId: early!.itemId },
    });
    expect(audit?.actorUserId).toBe(admin.userId);
    const open = dataOf<{ itemId: string }[]>(
      await call(admin, "get", "/api/v1/admin/settlement-reconciliation?state=open"),
    );
    expect(open.some((e) => e.itemId === early!.itemId)).toBe(false);
    expect(
      await refusedBy(() =>
        prisma.settlementReconciliationResolution.deleteMany({
          where: { bookingItemId: early!.itemId },
        }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "settlement_reconciliation_append_only_chk" });
  });

  it("after the service: invoiced but never settled is flagged", async () => {
    const booked = await bookedTrip({
      listingId: world.listings.room.id,
      startDate: world.day(0),
      endDate: world.day(1),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    await setClock(new Date(Date.now() + 40 * 86_400_000));
    const entries = dataOf<{ itemId: string; mismatches: { kind: string }[] }[]>(
      await call(
        admin,
        "get",
        "/api/v1/admin/settlement-reconciliation?kind=UNSETTLED_AFTER_SERVICE",
      ),
    );
    expect(entries.find((e) => e.itemId === booked.itemId)?.mismatches).toEqual([
      { kind: "UNSETTLED_AFTER_SERVICE", resolution: null },
    ]);
    await setClock(null);
  });
});

// ---------------------------------------------------------------------------------------------
describe("payouts pay what was kept; voiding a paid-out booking claws it back (gap 39)", () => {
  let paidOutItemId: string;
  let paidOutTripId: string;
  let firstBatchId: string;

  it("after the services: the partly refunded room is paid out its kept half minus its commission", async () => {
    await setClock(new Date(Date.now() + 40 * 86_400_000));
    const period = world.day(2).slice(0, 7);
    expect(
      (await call(admin, "post", "/api/v1/admin/payout-batches/generate", { period })).status,
    ).toBe(200);
    const batch = await prisma.payout.findFirstOrThrow({
      where: { providerId: world.providers.hotelProvider.id, status: "PENDING" },
      include: { bookingItems: true },
    });
    const kept = batch.bookingItems.find((i) => i.cancellationRefundBps === 5_000);
    expect(kept).toBeDefined();
    // Kept Rs 2,175.25 − commission Rs 262.50 = Rs 1,912.75; nothing refunded in full is included.
    expect(batch.bookingItems.every((i) => i.paymentStatus !== "REFUNDED")).toBe(true);
    const detail = await call(admin, "get", `/api/v1/admin/payout-batches/${batch.id}`);
    const line = dataOf<{
      items: { id: string; grossMinor: string; commissionMinor: string; netMinor: string }[];
    }>(detail).items.find((i) => i.id === kept!.id);
    expect(line).toMatchObject({
      grossMinor: "217525",
      commissionMinor: "26250",
      netMinor: "191275",
    });
    await setClock(null);
  });

  it("a paid-out bus booking: void → full refund request + clawback; the past payout is unchanged", async () => {
    ({ tripId: paidOutTripId, itemId: paidOutItemId } = await bookedTrip({
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 2,
      paymentMethod: "online",
      gateway: "simulated",
    }));
    await setClock(new Date(Date.now() + 40 * 86_400_000));
    const period = world.day(1).slice(0, 7);
    await call(admin, "post", "/api/v1/admin/payout-batches/generate", { period });
    const batch = await prisma.payout.findFirstOrThrow({
      where: { providerId: world.providers.busProvider.id, status: "PENDING" },
    });
    firstBatchId = batch.id;
    expect(
      (await call(admin, "post", `/api/v1/admin/payout-batches/${batch.id}/schedule`)).status,
    ).toBe(200);
    expect(
      (
        await call(admin, "post", `/api/v1/admin/payout-batches/${batch.id}/mark-paid`, {
          bankReference: "NABIL-TT-0001",
        })
      ).status,
    ).toBe(200);
    const paidBatch = await prisma.payout.findUniqueOrThrow({ where: { id: batch.id } });
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: paidOutItemId } });
    expect(item.payoutStatus).toBe("PAID");

    // A refund on a paid-out item without a clawback is refused.
    const payment = await prisma.payment.findFirstOrThrow({
      where: { tripId: paidOutTripId, kind: "CHARGE", status: "SUCCEEDED" },
    });
    const manual = dataOf<RefundBody>(
      await call(admin, "post", "/api/v1/admin/refund-requests", {
        paymentId: payment.id,
        bookingItemId: paidOutItemId,
        amountMinor: "100",
        reason: "Test: refund before the void",
      }),
    );
    await step(manual.id, "approve");
    expect(codeOf(await step(manual.id, "execute"))).toEqual([409, "REFUND_ITEM_PAID_OUT"]);
    await step(manual.id, "reject", { note: "Handled by the void below" });

    const voided = await call(admin, "post", `/api/v1/admin/booking-items/${paidOutItemId}/void`, {
      reason: "Bus never ran; operator confirmed",
    });
    expect(voided.status).toBe(200);
    // Bus: 2 × Rs 1,800 = Rs 3,600, commission Rs 540 → the provider was paid Rs 3,060.
    expect(dataOf<{ items: unknown[] }>(voided).items).toEqual([
      {
        itemId: paidOutItemId,
        changed: true,
        refundRequests: 1,
        invoiceAdjusted: false,
        currency: "NPR",
        currencyExponent: 2,
        clawbackMinor: "306000",
      },
    ]);
    const after = await prisma.bookingItem.findUniqueOrThrow({
      where: { id: paidOutItemId },
      include: { clawback: true },
    });
    expect([
      after.status,
      after.commissionStatus,
      after.payoutStatus,
      after.clawback?.amountMinor,
    ]).toEqual(["CANCELLED", "WAIVED", "PAID", 306_000n]);
    // The paid batch is exactly as it was.
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(paidBatch);
    // The customer's full refund can now be executed (the clawback exists).
    const refund = (await refundsOf(paidOutItemId)).find((r) => r.status === "REQUESTED")!;
    expect(refund.amountMinor).toBe(360_000n);
    await step(refund.id, "approve");
    expect(dataOf<RefundBody>(await step(refund.id, "execute"))).toMatchObject({
      status: "COMPLETED",
    });
    expect(
      await refusedBy(() =>
        prisma.providerClawback.update({
          where: { id: after.clawback!.id },
          data: { reason: "edited" },
        }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "provider_clawbacks_append_only_chk" });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "booking_item.void", entityId: paidOutItemId },
    });
    expect((audit?.after as { clawbackMinor: string }).clawbackMinor).toBe("306000");
    await setClock(null);
  });

  it("the clawback is deducted from the next batch (never below zero); the rest stays outstanding", async () => {
    // One more bus seat (Rs 1,800 → net Rs 1,530) next month, paid out after its service.
    const next = await bookedTrip({
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 1,
      paymentMethod: "online",
      gateway: "simulated",
    });
    await setClock(new Date(Date.now() + 40 * 86_400_000));
    await call(admin, "post", "/api/v1/admin/payout-batches/generate", {
      period: world.day(1).slice(0, 7),
    });
    const batch = await prisma.payout.findFirstOrThrow({
      where: { providerId: world.providers.busProvider.id, status: "PENDING" },
      include: { bookingItems: { select: { id: true } } },
    });
    expect(batch.bookingItems.map((i) => i.id)).toEqual([next.itemId]);
    const scheduled = await call(
      admin,
      "post",
      `/api/v1/admin/payout-batches/${batch.id}/schedule`,
    );
    expect(
      dataOf<{
        payout: {
          grossMinor: string;
          commissionMinor: string;
          deductionsMinor: string;
          netMinor: string;
        };
      }>(scheduled).payout,
    ).toMatchObject({
      grossMinor: "180000",
      commissionMinor: "27000",
      deductionsMinor: "153000",
      netMinor: "0",
    });
    const claws = dataOf<
      {
        amountMinor: string;
        recoveredMinor: string;
        outstandingMinor: string;
        paidOutInPayoutId: string;
      }[]
    >(
      await call(
        admin,
        "get",
        `/api/v1/admin/clawbacks?providerId=${world.providers.busProvider.id}`,
      ),
    );
    expect(claws).toEqual([
      expect.objectContaining({
        amountMinor: "306000",
        recoveredMinor: "153000",
        outstandingMinor: "153000",
        paidOutInPayoutId: firstBatchId,
        currency: "NPR",
      }),
    ]);
    // The partner sees their own clawbacks only.
    const own = dataOf<unknown[]>(await call(busPartner, "get", "/api/v1/partner/clawbacks"));
    expect(own).toHaveLength(1);
    const hotels = dataOf<unknown[]>(await call(hotelPartner, "get", "/api/v1/partner/clawbacks"));
    expect(hotels).toHaveLength(0);
    // A failed transfer gives the deduction back (it counts only while SCHEDULED or PAID).
    await call(admin, "post", `/api/v1/admin/payout-batches/${batch.id}/mark-failed`, {
      reason: "Bounced",
    });
    const afterFail = dataOf<{ outstandingMinor: string }[]>(
      await call(
        admin,
        "get",
        `/api/v1/admin/clawbacks?providerId=${world.providers.busProvider.id}`,
      ),
    );
    expect(afterFail[0]!.outstandingMinor).toBe("306000");
    await setClock(null);
  });
});

it("money stays a digit string with its currency in every response (ADR 0005)", () => {
  expect(moneyBoundaryViolations(responses)).toEqual([]);
});

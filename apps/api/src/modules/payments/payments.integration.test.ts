import { randomUUID } from "node:crypto";
import { simulatedPayments } from "../../modules/payments/payments.config.js";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { countMoneyFields, moneyBoundaryViolations } from "../../testing/json-safety.js";
import { resolveTestDatabase } from "../../testing/test-database.js";
import { issueCommissionInvoices } from "../finance/invoices.service.js";

/**
 * Phase 5 (ADR 0007): online payments with idempotent intents and allocations, commission invoices
 * for pay-at-property items, the admin settle path, and the database guards behind them.
 */

// These scenarios make dozens of sequential API calls, each several database round trips. On the
// Neon test branch (~100–300 ms per round trip) some exceed the default 30 s, so this file allows
// 120 s per test. Assertions are unchanged; locally the tests take milliseconds.
vi.setConfig({ testTimeout: 120_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const appDeps = {
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
};
const app = createApp({ ...appDeps, payments: simulatedPayments() });
let world: World;

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
  cookie: string;
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
  const setCookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return {
    agent,
    csrfToken: body.data.csrfToken,
    userId: body.data.user.id,
    cookie: setCookie[0]?.split(";")[0] ?? "",
  };
}

let me: Client;
let stranger: Client;
let admin: Client;

/** Every response body, checked for money-boundary violations at the end. */
const responses: unknown[] = [];

async function call(
  method: "get" | "post",
  url: string,
  body?: object,
  as: Client = me,
): Promise<request.Response> {
  const req = as.agent[method](url).set("X-CSRF-Token", as.csrfToken);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}

const errorOf = (res: request.Response) => (res.body as ErrorResponseBody).error;
const statusAndCode = (res: request.Response) => [res.status, errorOf(res).code];

interface PaymentBody {
  id: string;
  status: string;
  amountMinor: string;
  capturedMinor: string;
  currency: string;
  currencyExponent: number;
  allocations: { itemId: string; amountMinor: string }[];
}
interface IntentBody {
  created: boolean;
  payment: PaymentBody;
  due: { lines: { itemId: string; dueMinor: string }[]; totalDueMinor: string };
}
interface TripItem {
  id: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  money: { totalMinor: string; paidMinor: string };
}
interface Trip {
  id: string;
  status: string;
  expiresAt: string | null;
  totals: Record<string, string>;
  onlinePayment: { paidMinor: string; dueMinor: string };
  items: TripItem[];
}

const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;

type ItemSpec = {
  listing: "room" | "bus" | "guide";
  start: number;
  end?: number;
  quantity?: number;
  paymentMethod: "online" | "pay_at_property";
};

/** Creates a trip with the given items and confirms it (POST /confirm). */
async function confirmedTrip(items: ItemSpec[], as: Client = me): Promise<Trip> {
  const created = await call("post", "/api/v1/trips", { currency: "NPR" }, as);
  expect(created.status).toBe(201);
  const tripId = dataOf<Trip>(created).id;
  for (const item of items) {
    const res = await call(
      "post",
      `/api/v1/trips/${tripId}/items`,
      {
        listingId: world.listings[item.listing].id,
        startDate: world.day(item.start),
        ...(item.end === undefined ? {} : { endDate: world.day(item.end) }),
        quantity: item.quantity ?? 1,
        paymentMethod: item.paymentMethod,
      },
      as,
    );
    expect(res.status).toBe(201);
  }
  const confirmed = await call("post", `/api/v1/trips/${tripId}/confirm`, undefined, as);
  expect(confirmed.status).toBe(200);
  return dataOf<Trip>(confirmed);
}

const getTrip = async (id: string, as: Client = me) =>
  dataOf<Trip>(await call("get", `/api/v1/trips/${id}`, undefined, as));
const intent = (tripId: string, as: Client = me) =>
  call("post", `/api/v1/trips/${tripId}/payments/intent`, { gateway: "simulated" }, as);
const confirmPayment = (tripId: string, paymentId: string, body: object = {}, as: Client = me) =>
  call("post", `/api/v1/trips/${tripId}/payments/${paymentId}/confirm`, body, as);

/** Allocations of succeeded charges for one trip, summed per payment and per item, from SQL. */
async function allocationSums(tripId: string) {
  return prisma.$queryRaw<{ payment_id: string; captured: bigint; allocated: bigint }[]>`
    SELECT p.id::text AS payment_id, p.captured_minor AS captured,
           COALESCE(SUM(a.amount_minor), 0)::bigint AS allocated
    FROM payments p LEFT JOIN payment_allocations a ON a.payment_id = p.id
    WHERE p.trip_id = ${tripId}::uuid AND p.status = 'SUCCEEDED'
    GROUP BY p.id`;
}

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

beforeAll(async () => {
  world = await createWorld(prisma);
  me = await signUp("payer");
  stranger = await signUp("stranger");
  admin = await signUp("admin");
  // ADMIN is granted out of band (no API can do it); the role is re-read on every request.
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
describe("online payment: intent → confirm → items paid", () => {
  let trip: Trip;
  let paymentId: string;

  it("creates one intent for exactly the online amount due (computed on the server)", async () => {
    // 2 bus seats (Rs 1,800 each) + guide for 3 days (Rs 3,000/day), both online.
    trip = await confirmedTrip([
      { listing: "bus", start: 1, quantity: 2, paymentMethod: "online" },
      { listing: "guide", start: 0, end: 3, paymentMethod: "online" },
    ]);
    expect(trip.status).toBe("PENDING");
    expect(trip.onlinePayment).toEqual({ paidMinor: "0", dueMinor: "1260000" });

    const res = await intent(trip.id);
    expect(res.status).toBe(201);
    const body = dataOf<IntentBody>(res);
    expect(body.created).toBe(true);
    expect(body.payment).toMatchObject({
      status: "INITIATED",
      amountMinor: "1260000",
      capturedMinor: "0",
      currency: "NPR",
      currencyExponent: 2,
      allocations: [],
    });
    expect(body.due).toEqual({
      lines: [
        { itemId: trip.items[0]!.id, dueMinor: "360000" },
        { itemId: trip.items[1]!.id, dueMinor: "900000" },
      ],
      totalDueMinor: "1260000",
    });
    expect(res.headers.location).toBe(`/api/v1/trips/${trip.id}/payments/${body.payment.id}`);
    paymentId = body.payment.id;
  });

  it("repeating the request returns the SAME open intent (200), never a second charge", async () => {
    const again = await intent(trip.id);
    expect(again.status).toBe(200);
    expect(dataOf<IntentBody>(again)).toMatchObject({ created: false, payment: { id: paymentId } });
    expect(await prisma.payment.count({ where: { tripId: trip.id } })).toBe(1);
  });

  it("confirm: the payment succeeds and is allocated; items become PAID and CONFIRMED", async () => {
    const res = await confirmPayment(trip.id, paymentId);
    expect(res.status).toBe(200);
    const body = dataOf<{ replayed: boolean; payment: PaymentBody }>(res);
    expect(body.replayed).toBe(false);
    expect(body.payment).toMatchObject({
      status: "SUCCEEDED",
      amountMinor: "1260000",
      capturedMinor: "1260000",
      allocations: [
        { itemId: trip.items[0]!.id, amountMinor: "360000" },
        { itemId: trip.items[1]!.id, amountMinor: "900000" },
      ],
    });

    const after = await getTrip(trip.id);
    expect(after.status).toBe("CONFIRMED");
    expect(after.expiresAt).toBeNull();
    expect(after.items.map((i) => [i.status, i.paymentStatus, i.money.paidMinor])).toEqual([
      ["CONFIRMED", "PAID", "360000"],
      ["CONFIRMED", "PAID", "900000"],
    ]);
    expect(after.onlinePayment).toEqual({ paidMinor: "1260000", dueMinor: "0" });
  });

  it("confirming again is a no-op replay: nothing is charged or allocated twice", async () => {
    const res = await confirmPayment(trip.id, paymentId, { capturedAmountMinor: "1" });
    expect(res.status).toBe(200);
    expect(dataOf<{ replayed: boolean }>(res).replayed).toBe(true);
    expect(await prisma.paymentAllocation.count({ where: { paymentId } })).toBe(2);
    expect(await allocationSums(trip.id)).toEqual([
      { payment_id: paymentId, captured: 1_260_000n, allocated: 1_260_000n },
    ]);
  });

  it("nothing is due any more; commission stays PENDING for deduction from the payout", async () => {
    expect(statusAndCode(await intent(trip.id))).toEqual([409, "NOTHING_DUE"]);
    const items = await prisma.bookingItem.findMany({
      where: { tripId: trip.id },
      orderBy: { createdAt: "asc" },
      select: {
        totalMinor: true,
        commissionMinor: true,
        providerPayoutMinor: true,
        commissionStatus: true,
        payoutStatus: true,
        commissionInvoiceId: true,
      },
    });
    expect(items).toEqual([
      {
        totalMinor: 360_000n,
        commissionMinor: 54_000n,
        providerPayoutMinor: 306_000n,
        commissionStatus: "PENDING",
        payoutStatus: "PENDING", // computed, not executed (payouts are a later phase)
        commissionInvoiceId: null, // online commission is never invoiced
      },
      {
        totalMinor: 900_000n,
        commissionMinor: 135_000n,
        providerPayoutMinor: 765_000n,
        commissionStatus: "PENDING",
        payoutStatus: "PENDING",
        commissionInvoiceId: null,
      },
    ]);
  });

  it("lists the trip's payments with their allocations", async () => {
    const res = await call("get", `/api/v1/trips/${trip.id}/payments`);
    expect(res.status).toBe(200);
    const body = dataOf<{ currency: string; payments: PaymentBody[] }>(res);
    expect(body.currency).toBe("NPR");
    expect(body.payments.map((p) => [p.id, p.status, p.capturedMinor])).toEqual([
      [paymentId, "SUCCEEDED", "1260000"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("concurrency: no double intent, no double charge, no over-allocation", () => {
  it("five simultaneous intent requests share ONE open intent", async () => {
    const trip = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    const results = await Promise.all(Array.from({ length: 5 }, () => intent(trip.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => dataOf<IntentBody>(r).payment.id));
    expect(ids.size).toBe(1);
    expect(await prisma.payment.count({ where: { tripId: trip.id, status: "INITIATED" } })).toBe(1);
  });

  it("five simultaneous confirms: exactly one applies; allocations equal the captured amount", async () => {
    const trip = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    const paymentId = dataOf<IntentBody>(await intent(trip.id)).payment.id;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => confirmPayment(trip.id, paymentId)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => !dataOf<{ replayed: boolean }>(r).replayed)).toHaveLength(1);

    expect(await allocationSums(trip.id)).toEqual([
      { payment_id: paymentId, captured: 180_000n, allocated: 180_000n },
    ]);
    const item = await prisma.bookingItem.findFirstOrThrow({ where: { tripId: trip.id } });
    expect([item.status, item.paymentStatus]).toEqual(["CONFIRMED", "PAID"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("partial payment: an item is PAID only when fully covered", () => {
  let trip: Trip;

  it("a partial capture pays items in order and leaves the rest PARTIALLY_PAID", async () => {
    trip = await confirmedTrip([
      { listing: "bus", start: 1, quantity: 2, paymentMethod: "online" }, // 3,60,000
      { listing: "guide", start: 3, end: 6, paymentMethod: "online" }, // 9,00,000
    ]);
    const first = dataOf<IntentBody>(await intent(trip.id)).payment;
    expect(first.amountMinor).toBe("1260000");

    const res = await confirmPayment(trip.id, first.id, { capturedAmountMinor: "500000" });
    expect(dataOf<{ payment: PaymentBody }>(res).payment).toMatchObject({
      status: "SUCCEEDED",
      amountMinor: "1260000",
      capturedMinor: "500000",
      allocations: [
        { itemId: trip.items[0]!.id, amountMinor: "360000" },
        { itemId: trip.items[1]!.id, amountMinor: "140000" },
      ],
    });

    const after = await getTrip(trip.id);
    expect(after.status).toBe("PENDING"); // still waiting for the rest
    expect(after.items.map((i) => [i.status, i.paymentStatus, i.money.paidMinor])).toEqual([
      ["CONFIRMED", "PAID", "360000"],
      ["PENDING", "PARTIALLY_PAID", "140000"],
    ]);
    expect(after.onlinePayment).toEqual({ paidMinor: "500000", dueMinor: "760000" });
  });

  it("a new intent covers only the remainder, and paying it completes the trip", async () => {
    const res = await intent(trip.id);
    expect(res.status).toBe(201);
    const second = dataOf<IntentBody>(res);
    expect(second.payment.amountMinor).toBe("760000");
    expect(second.due.lines).toEqual([{ itemId: trip.items[1]!.id, dueMinor: "760000" }]);

    await confirmPayment(trip.id, second.payment.id);
    const after = await getTrip(trip.id);
    expect(after.status).toBe("CONFIRMED");
    expect(after.items.map((i) => [i.paymentStatus, i.money.paidMinor])).toEqual([
      ["PAID", "360000"],
      ["PAID", "900000"],
    ]);
    // The guide item got money from two payments; together exactly its total.
    const sums = await allocationSums(trip.id);
    expect(sums.every((row) => row.captured === row.allocated)).toBe(true);
    expect(sums.reduce((s, row) => s + row.allocated, 0n)).toBe(1_260_000n);
  });

  it("a capture above the intent amount is rejected and changes nothing", async () => {
    const t = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    const p = dataOf<IntentBody>(await intent(t.id)).payment;
    const res = await confirmPayment(t.id, p.id, { capturedAmountMinor: "180001" });
    expect(statusAndCode(res)).toEqual([422, "INVALID_CAPTURED_AMOUNT"]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      "INITIATED",
    );
  });

  it("a failed payment allocates nothing; it can't be confirmed later; a new intent can", async () => {
    const t = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    const p = dataOf<IntentBody>(await intent(t.id)).payment;
    const failed = await confirmPayment(t.id, p.id, { outcome: "failed" });
    expect(dataOf<{ payment: PaymentBody }>(failed).payment).toMatchObject({
      status: "FAILED",
      capturedMinor: "0",
      allocations: [],
    });
    expect(statusAndCode(await confirmPayment(t.id, p.id))).toEqual([409, "PAYMENT_NOT_OPEN"]);

    const retry = await intent(t.id);
    expect(retry.status).toBe(201);
    expect(dataOf<IntentBody>(retry).payment.id).not.toBe(p.id);
    const item = await prisma.bookingItem.findFirstOrThrow({ where: { tripId: t.id } });
    expect(item.paymentStatus).toBe("UNPAID");
  });

  it("paying before the trip is confirmed is refused", async () => {
    const draft = dataOf<Trip>(await call("post", "/api/v1/trips", { currency: "NPR" }));
    expect(statusAndCode(await intent(draft.id))).toEqual([409, "TRIP_NOT_CONFIRMED"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("pay at property: commission invoices (one per trip and provider, exactly once)", () => {
  let trip: Trip;

  it("confirm issues one invoice per provider with the exact commission, linked to the items", async () => {
    // Homestay 2 nights (commission Rs 1,155) + 1 bus seat paid on boarding (commission Rs 270).
    trip = await confirmedTrip([
      { listing: "room", start: 0, end: 2, paymentMethod: "pay_at_property" },
      { listing: "bus", start: 1, paymentMethod: "pay_at_property" },
    ]);
    expect(trip.status).toBe("CONFIRMED");

    const invoices = await prisma.providerInvoice.findMany({
      where: { tripId: trip.id },
      include: {
        bookingItems: { select: { id: true, commissionMinor: true, commissionStatus: true } },
      },
      orderBy: { amountMinor: "desc" },
    });
    expect(
      invoices.map((inv) => ({
        providerId: inv.providerId,
        status: inv.status,
        amountMinor: inv.amountMinor,
        currency: inv.currency,
        issued: inv.issuedAt !== null,
        items: inv.bookingItems.map((i) => [i.id, i.commissionMinor, i.commissionStatus]),
      })),
    ).toEqual([
      {
        providerId: world.providers.hotelProvider.id,
        status: "ISSUED",
        amountMinor: 115_500n,
        currency: "NPR",
        issued: true,
        items: [[trip.items[0]!.id, 115_500n, "INVOICED"]],
      },
      {
        providerId: world.providers.busProvider.id,
        status: "ISSUED",
        amountMinor: 27_000n,
        currency: "NPR",
        issued: true,
        items: [[trip.items[1]!.id, 27_000n, "INVOICED"]],
      },
    ]);
    for (const inv of invoices) expect(inv.number).toMatch(/^INV-\d{8}-[A-HJKMNP-Z2-9]{8}$/);
  });

  it("retries create nothing: confirm again is refused and re-running invoicing is a no-op", async () => {
    expect(statusAndCode(await call("post", `/api/v1/trips/${trip.id}/confirm`))).toEqual([
      409,
      "TRIP_NOT_EDITABLE",
    ]);
    const rerun = await prisma.$transaction((tx) =>
      issueCommissionInvoices(tx, trip.id, new Date()),
    );
    expect(rerun).toEqual([]);
    expect(await prisma.providerInvoice.count({ where: { tripId: trip.id } })).toBe(2);
  });

  it("three simultaneous confirms: one wins, and exactly one invoice exists", async () => {
    const created = dataOf<Trip>(await call("post", "/api/v1/trips", { currency: "NPR" }));
    await call("post", `/api/v1/trips/${created.id}/items`, {
      listingId: world.listings.room.id,
      startDate: world.day(2),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => call("post", `/api/v1/trips/${created.id}/confirm`)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const invoices = await prisma.providerInvoice.findMany({ where: { tripId: created.id } });
    expect(invoices.map((i) => [i.status, i.amountMinor])).toEqual([["ISSUED", 105_000n]]);
  });

  it("nothing is charged online for a pay-at-property trip", async () => {
    expect(statusAndCode(await intent(trip.id))).toEqual([409, "NOTHING_DUE"]);
  });

  it("admin reads the trip's invoices (internal view, money as strings)", async () => {
    const res = await call("get", `/api/v1/admin/trips/${trip.id}/invoices`, undefined, admin);
    expect(res.status).toBe(200);
    const invoices = dataOf<{ amountMinor: string; status: string; items: unknown[] }[]>(res);
    expect(invoices.map((i) => [i.status, i.amountMinor, i.items.length]).sort()).toEqual([
      ["ISSUED", "115500", 1],
      ["ISSUED", "27000", 1],
    ]);
  });

  it("admin settles at the property: PAY_AT_PROPERTY → PAID_AT_PROPERTY, idempotent", async () => {
    const url = `/api/v1/admin/trips/${trip.id}/payments/at-property/settle`;
    const roomItem = trip.items[0]!.id;
    const first = await call("post", url, { itemIds: [roomItem] }, admin);
    expect(first.status).toBe(200);
    expect(dataOf<{ items: unknown[] }>(first).items).toEqual([
      {
        id: roomItem,
        status: "CONFIRMED",
        paymentMethod: "pay_at_property",
        paymentStatus: "PAID_AT_PROPERTY",
        changed: true,
      },
    ]);
    const again = await call("post", url, { itemIds: [roomItem] }, admin);
    expect(dataOf<{ items: { changed: boolean }[] }>(again).items[0]!.changed).toBe(false);

    // The provider still owes the commission; no money moved through MeroStay.
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: roomItem } });
    expect([item.commissionStatus, item.payoutStatus]).toEqual(["INVOICED", "NOT_APPLICABLE"]);
    expect(await prisma.payment.count({ where: { tripId: trip.id } })).toBe(0);
    const customerView = await getTrip(trip.id);
    expect(customerView.items[0]).toMatchObject({
      paymentMethod: "pay_at_property",
      paymentStatus: "PAID_AT_PROPERTY",
    });
  });

  it("settle rules: unknown trip/item 404, online item 422, unconfirmed item 409", async () => {
    const url = (id: string) => `/api/v1/admin/trips/${id}/payments/at-property/settle`;
    expect(
      statusAndCode(await call("post", url(randomUUID()), { itemIds: [randomUUID()] }, admin)),
    ).toEqual([404, "TRIP_NOT_FOUND"]);
    expect(
      statusAndCode(await call("post", url(trip.id), { itemIds: [randomUUID()] }, admin)),
    ).toEqual([404, "ITEM_NOT_FOUND"]);

    const online = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    expect(
      statusAndCode(await call("post", url(online.id), { itemIds: [online.items[0]!.id] }, admin)),
    ).toEqual([422, "ITEM_NOT_PAY_AT_PROPERTY"]);

    const draft = dataOf<Trip>(await call("post", "/api/v1/trips", { currency: "NPR" }));
    const added = await call("post", `/api/v1/trips/${draft.id}/items`, {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const draftItem = dataOf<Trip>(added).items[0]!.id;
    expect(
      statusAndCode(await call("post", url(draft.id), { itemIds: [draftItem] }, admin)),
    ).toEqual([409, "ITEM_NOT_CONFIRMED"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("mixed trip: online items paid online, pay-at-property invoiced, totals consistent", () => {
  it("each part follows its own path and the trip adds up", async () => {
    const trip = await confirmedTrip([
      { listing: "room", start: 2, end: 4, paymentMethod: "pay_at_property" }, // total 8,70,100
      { listing: "bus", start: 1, quantity: 2, paymentMethod: "online" }, // 3,60,000
      { listing: "bus", start: 0, paymentMethod: "online" }, // 1,80,000
    ]);
    expect(trip.status).toBe("PENDING");
    expect(trip.totals).toMatchObject({
      totalMinor: "1410100",
      payOnlineMinor: "540000",
      payAtPropertyMinor: "870100",
    });
    // The pay-at-property item is already confirmed and invoiced before any online payment.
    const invoice = await prisma.providerInvoice.findFirstOrThrow({ where: { tripId: trip.id } });
    expect([invoice.status, invoice.amountMinor]).toEqual(["ISSUED", 105_000n]);

    const intentBody = dataOf<IntentBody>(await intent(trip.id));
    expect(intentBody.payment.amountMinor).toBe("540000"); // online part only
    expect(intentBody.due.lines.map((l) => l.itemId)).toEqual([
      trip.items[1]!.id,
      trip.items[2]!.id,
    ]);
    await confirmPayment(trip.id, intentBody.payment.id);

    const after = await getTrip(trip.id);
    expect(after.status).toBe("CONFIRMED");
    expect(after.items.map((i) => [i.paymentMethod, i.paymentStatus, i.money.paidMinor])).toEqual([
      ["pay_at_property", "PAY_AT_PROPERTY", "0"],
      ["online", "PAID", "360000"],
      ["online", "PAID", "180000"],
    ]);
    expect(after.onlinePayment).toEqual({ paidMinor: "540000", dueMinor: "0" });
    expect(BigInt(after.totals.payOnlineMinor!) + BigInt(after.totals.payAtPropertyMinor!)).toBe(
      BigInt(after.totals.totalMinor!),
    );

    // The database agrees: trip = Σ items; payment = Σ allocations; invoice = Σ linked commission.
    const [check] = await prisma.$queryRaw<
      { trip_ok: boolean; alloc_ok: boolean; invoice_ok: boolean; commission: bigint }[]
    >`
      SELECT
        (SELECT t.total_minor = SUM(bi.total_minor) AND t.commission_total_minor = SUM(bi.commission_minor)
           FROM trips t JOIN booking_items bi ON bi.trip_id = t.id
           WHERE t.id = ${trip.id}::uuid GROUP BY t.id) AS trip_ok,
        (SELECT bool_and(p.captured_minor = (SELECT SUM(a.amount_minor) FROM payment_allocations a WHERE a.payment_id = p.id))
           FROM payments p WHERE p.trip_id = ${trip.id}::uuid AND p.status = 'SUCCEEDED') AS alloc_ok,
        (SELECT bool_and(i.amount_minor = (SELECT SUM(bi.commission_minor) FROM booking_items bi WHERE bi.commission_invoice_id = i.id))
           FROM provider_invoices i WHERE i.trip_id = ${trip.id}::uuid) AS invoice_ok,
        (SELECT commission_total_minor FROM trips WHERE id = ${trip.id}::uuid) AS commission`;
    expect(check).toEqual({
      trip_ok: true,
      alloc_ok: true,
      invoice_ok: true,
      commission: 105_000n + 54_000n + 27_000n,
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("ownership and access (ADR 0006/0007)", () => {
  let trip: Trip;
  let paymentId: string;

  beforeAll(async () => {
    trip = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    paymentId = dataOf<IntentBody>(await intent(trip.id)).payment.id;
  });

  it("a stranger gets 404 on every payment endpoint of someone else's trip", async () => {
    expect(statusAndCode(await intent(trip.id, stranger))).toEqual([404, "TRIP_NOT_FOUND"]);
    expect(statusAndCode(await confirmPayment(trip.id, paymentId, {}, stranger))).toEqual([
      404,
      "TRIP_NOT_FOUND",
    ]);
    expect(
      statusAndCode(await call("get", `/api/v1/trips/${trip.id}/payments`, undefined, stranger)),
    ).toEqual([404, "TRIP_NOT_FOUND"]);
    // Same answer as a trip that does not exist at all.
    expect(statusAndCode(await intent(randomUUID(), stranger))).toEqual([404, "TRIP_NOT_FOUND"]);
  });

  it("a payment id from another trip is 404, even on the caller's own trip", async () => {
    const own = await confirmedTrip(
      [{ listing: "bus", start: 1, paymentMethod: "online" }],
      stranger,
    );
    expect(statusAndCode(await confirmPayment(own.id, paymentId, {}, stranger))).toEqual([
      404,
      "PAYMENT_NOT_FOUND",
    ]);
  });

  it("the stranger's attempts changed nothing", async () => {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect([payment.status, payment.capturedMinor]).toEqual(["INITIATED", 0n]);
  });

  it("no session → 401; no CSRF token → 403 on writes", async () => {
    const anon = request(app);
    expect(statusAndCode(await anon.post(`/api/v1/trips/${trip.id}/payments/intent`))).toEqual([
      401,
      "UNAUTHENTICATED",
    ]);
    expect(statusAndCode(await anon.get(`/api/v1/trips/${trip.id}/payments`))).toEqual([
      401,
      "UNAUTHENTICATED",
    ]);
    const noCsrf = await me.agent.post(`/api/v1/trips/${trip.id}/payments/${paymentId}/confirm`);
    expect(statusAndCode(noCsrf)).toEqual([403, "CSRF_TOKEN_INVALID"]);
  });

  it("admin endpoints: customers get 403 for every URL (before any data is read); anon 401", async () => {
    const settle = (id: string) => `/api/v1/admin/trips/${id}/payments/at-property/settle`;
    for (const id of [trip.id, randomUUID()]) {
      expect(statusAndCode(await call("post", settle(id), { itemIds: [randomUUID()] }))).toEqual([
        403,
        "FORBIDDEN",
      ]);
      expect(
        statusAndCode(await call("get", `/api/v1/admin/trips/${id}/invoices`, undefined, stranger)),
      ).toEqual([403, "FORBIDDEN"]);
    }
    expect(
      statusAndCode(await request(app).get(`/api/v1/admin/trips/${trip.id}/invoices`)),
    ).toEqual([401, "UNAUTHENTICATED"]);
    const adminNoCsrf = await admin.agent
      .post(settle(trip.id))
      .send({ itemIds: [trip.items[0]!.id] });
    expect(statusAndCode(adminNoCsrf)).toEqual([403, "CSRF_TOKEN_INVALID"]);
  });

  it("a demoted admin loses access on the very next request", async () => {
    // Phase 12: the last active admin can never be demoted (users_last_admin_chk), so another
    // admin exists first.
    const other = await signUp("second-admin");
    await prisma.user.update({ where: { id: other.userId }, data: { role: "ADMIN" } });
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "CUSTOMER" } });
    const res = await call("get", `/api/v1/admin/trips/${trip.id}/invoices`, undefined, admin);
    expect(statusAndCode(res)).toEqual([403, "FORBIDDEN"]);
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
  });

  it("without a configured gateway, intents and confirmations are 503 (never simulated)", async () => {
    const offline = createApp(appDeps); // no `payments` → gateway null
    const res = await request(offline)
      .post(`/api/v1/trips/${trip.id}/payments/intent`)
      .set("Cookie", me.cookie)
      .set("X-CSRF-Token", me.csrfToken)
      .send({ gateway: "simulated" });
    expect(statusAndCode(res)).toEqual([503, "PAYMENTS_UNAVAILABLE"]);
    const confirm = await request(offline)
      .post(`/api/v1/trips/${trip.id}/payments/${paymentId}/confirm`)
      .set("Cookie", me.cookie)
      .set("X-CSRF-Token", me.csrfToken)
      .send({});
    expect(statusAndCode(confirm)).toEqual([503, "PAYMENTS_UNAVAILABLE"]);
  });

  it("after the hold window, paying is refused (the hold-release job then frees the seats)", async () => {
    const late = createApp({
      ...appDeps,
      payments: simulatedPayments(),
      now: () => new Date(Date.now() + 31 * 60_000),
    });
    const res = await request(late)
      .post(`/api/v1/trips/${trip.id}/payments/${paymentId}/confirm`)
      .set("Cookie", me.cookie)
      .set("X-CSRF-Token", me.csrfToken)
      .send({});
    expect(statusAndCode(res)).toEqual([409, "TRIP_EXPIRED"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the database enforces the payment and invoice math (direct writes are refused)", () => {
  let paid: { tripId: string; itemId: string; paymentId: string };
  let unpaid: { tripId: string; itemId: string };

  beforeAll(async () => {
    const t = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    const p = dataOf<IntentBody>(await intent(t.id)).payment;
    await confirmPayment(t.id, p.id);
    paid = { tripId: t.id, itemId: t.items[0]!.id, paymentId: p.id };
    const u = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    unpaid = { tripId: u.id, itemId: u.items[0]!.id };
  });

  it("an allocation beyond what the payment captured, or into another trip", async () => {
    // Two seats as two items; the capture covers only the first.
    const t = await confirmedTrip([
      { listing: "bus", start: 1, paymentMethod: "online" },
      { listing: "bus", start: 1, paymentMethod: "online" },
    ]);
    const p = dataOf<IntentBody>(await intent(t.id)).payment;
    await confirmPayment(t.id, p.id, { capturedAmountMinor: "180000" });
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`
          INSERT INTO payment_allocations (id, payment_id, booking_item_id, amount_minor)
          VALUES (gen_random_uuid(), ${p.id}::uuid, ${t.items[1]!.id}::uuid, 1)`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "payment_allocations_within_payment_chk" });

    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`
          INSERT INTO payment_allocations (id, payment_id, booking_item_id, amount_minor)
          VALUES (gen_random_uuid(), ${paid.paymentId}::uuid, ${t.items[1]!.id}::uuid, 1)`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "payment_allocations_same_trip_chk" });
  });

  it("an allocation beyond the item total (a second payment for a paid item)", async () => {
    const [extra] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO payments (id, trip_id, kind, gateway, status, currency, amount_minor, captured_minor, completed_at, updated_at)
      VALUES (gen_random_uuid(), ${paid.tripId}::uuid, 'CHARGE', 'simulated', 'SUCCEEDED', 'NPR', 1, 1, now(), now())
      RETURNING id::text`;
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`
          INSERT INTO payment_allocations (id, payment_id, booking_item_id, amount_minor)
          VALUES (gen_random_uuid(), ${extra!.id}::uuid, ${paid.itemId}::uuid, 1)`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "payment_allocations_within_item_chk" });
  });

  it("allocating an unfinished payment, changing or deleting an allocation", async () => {
    const t = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    const open = dataOf<IntentBody>(await intent(t.id)).payment;
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`
          INSERT INTO payment_allocations (id, payment_id, booking_item_id, amount_minor)
          VALUES (gen_random_uuid(), ${open.id}::uuid, ${t.items[0]!.id}::uuid, 1)`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "payment_allocations_succeeded_charge_chk" });
    for (const write of [
      () =>
        prisma.$executeRaw`UPDATE payment_allocations SET amount_minor = 1 WHERE payment_id = ${paid.paymentId}::uuid`,
      () =>
        prisma.$executeRaw`DELETE FROM payment_allocations WHERE payment_id = ${paid.paymentId}::uuid`,
    ]) {
      expect(await refusedBy(write)).toEqual({
        sqlState: "23514",
        constraint: "payment_allocations_immutable_chk",
      });
    }
  });

  it("marking an item PAID (or PARTIALLY_PAID) that has no matching allocations", async () => {
    for (const status of ["PAID", "PARTIALLY_PAID"]) {
      expect(
        await refusedBy(() =>
          prisma.$executeRawUnsafe(
            `UPDATE booking_items SET payment_status = $1::payment_status, status = 'CONFIRMED' WHERE id = $2::uuid`,
            status,
            unpaid.itemId,
          ),
        ),
      ).toEqual({ sqlState: "23514", constraint: "booking_items_payment_matches_allocations_chk" });
    }
  });

  it("a second open charge for the same trip, or re-capturing a succeeded payment", async () => {
    await intent(unpaid.tripId);
    const second = await refusedBy(
      () => prisma.$executeRaw`
        INSERT INTO payments (id, trip_id, kind, gateway, status, currency, amount_minor, updated_at)
        VALUES (gen_random_uuid(), ${unpaid.tripId}::uuid, 'CHARGE', 'simulated', 'INITIATED', 'NPR', 180000, now())`,
    );
    expect(second.sqlState).toBe("23505");
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`UPDATE payments SET captured_minor = 1 WHERE id = ${paid.paymentId}::uuid`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "payments_finished_immutable_chk" });
  });

  it("expiring an item that holds the customer's money", async () => {
    const t = await confirmedTrip([
      { listing: "bus", start: 1, quantity: 2, paymentMethod: "online" },
    ]);
    const p = dataOf<IntentBody>(await intent(t.id)).payment;
    await confirmPayment(t.id, p.id, { capturedAmountMinor: "1000" });
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`UPDATE booking_items SET status = 'EXPIRED' WHERE id = ${t.items[0]!.id}::uuid`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_paid_never_expires_chk" });
  });

  it("INVOICED commission without an invoice, a wrong invoice amount, editing an issued invoice", async () => {
    const t = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "pay_at_property" }]);
    const item = t.items[0]!.id;
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`UPDATE booking_items SET commission_invoice_id = NULL WHERE id = ${item}::uuid`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_invoice_link_chk" });

    const issued = await prisma.providerInvoice.findFirstOrThrow({ where: { tripId: t.id } });
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`UPDATE provider_invoices SET amount_minor = amount_minor + 1 WHERE id = ${issued.id}::uuid`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "provider_invoices_issued_immutable_chk" });

    // A DRAFT whose amount does not match its items cannot be issued.
    const draft = await prisma.providerInvoice.create({
      data: {
        number: `INV-TEST-${randomUUID().slice(0, 8)}`,
        providerId: world.providers.busProvider.id,
        status: "DRAFT",
        currency: "NPR",
        amountMinor: 1n,
      },
    });
    expect(
      await refusedBy(() =>
        prisma.providerInvoice.update({
          where: { id: draft.id },
          data: { status: "ISSUED", issuedAt: new Date() },
        }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "provider_invoices_amount_matches_items_chk" });

    // INVOICED requires an invoice (row CHECK).
    const other = await confirmedTrip([{ listing: "bus", start: 1, paymentMethod: "online" }]);
    expect(
      await refusedBy(
        () =>
          prisma.$executeRaw`UPDATE booking_items SET commission_status = 'INVOICED' WHERE id = ${other.items[0]!.id}::uuid`,
      ),
    ).toEqual({ sqlState: "23514", constraint: "booking_items_invoiced_has_invoice_chk" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("money at the boundary", () => {
  it("every money field in every payment/trip/admin response was a digit string with its currency", () => {
    const moneyFields = responses.reduce<number>((n, body) => n + countMoneyFields(body), 0);
    expect(moneyFields).toBeGreaterThan(100); // the check really inspected money
    expect(responses.flatMap((body) => moneyBoundaryViolations(body))).toEqual([]);
  });

  it("no customer response contains commission or provider-payout data", () => {
    const customerBodies = JSON.stringify(
      responses.filter((body) => !JSON.stringify(body).includes('"number":"INV-')),
    );
    for (const field of [
      "commissionMinor",
      "commissionRateBps",
      "providerPayoutMinor",
      "payoutStatus",
    ]) {
      expect(customerBodies).not.toContain(field);
    }
  });
});

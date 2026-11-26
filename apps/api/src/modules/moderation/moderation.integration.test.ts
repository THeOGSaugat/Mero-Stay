import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { inspectDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { moneyBoundaryViolations } from "../../testing/json-safety.js";
import { resolveTestDatabase } from "../../testing/test-database.js";
import { simulatedPayments } from "../payments/payments.config.js";

/**
 * Phase 12 (ADR 0018): listing review with the listing-type rule re-checked at approval (gap 15),
 * booking voids and settlement corrections (gap 13).
 */

vi.setConfig({ testTimeout: 120_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
  payments: simulatedPayments(),
});

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
}
let world: World;
let customer: Client;
let admin: Client;
const responses: unknown[] = [];

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: label,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrf: body.data.csrfToken, userId: body.data.user.id };
}

async function call(as: Client, method: "get" | "post", url: string, body?: object) {
  const req = as.agent[method](url).set("X-CSRF-Token", as.csrf);
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

beforeAll(async () => {
  world = await createWorld(prisma);
  customer = await signUp("moderation-customer");
  admin = await signUp("moderation-admin");
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
describe("listing review (gap 15)", () => {
  const pendingListing = (providerId: string, listingTypeCode: string, title: string) =>
    prisma.listing.create({
      data: {
        providerId,
        listingTypeCode,
        title,
        slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`,
        basePriceMinor: 150_000n,
        status: "PENDING_REVIEW",
        locationId: world.locations.town.id,
      },
    });
  const isPublic = async (id: string) =>
    (await request(app).get(`/api/v1/listings/${id}`)).status === 200;
  const inSearch = async (id: string) => {
    const res = await request(app).get(
      `/api/v1/listings?type=bus_ticket&location=${world.locations.province.slug}`,
    );
    return (res.body as { data: { id: string }[] }).data.some((l) => l.id === id);
  };

  it("a pending listing is hidden; approval makes it public (detail and search); audited", async () => {
    const listing = await pendingListing(
      world.providers.busProvider.id,
      "bus_ticket",
      "Night Bus Review",
    );
    expect(await isPublic(listing.id)).toBe(false);
    expect(await inSearch(listing.id)).toBe(false);

    const queue = await call(
      admin,
      "get",
      "/api/v1/admin/listings?status=PENDING_REVIEW&pageSize=100",
    );
    const entry = dataOf<{ id: string; typeRule: { allowed: boolean } }[]>(queue).find(
      (l) => l.id === listing.id,
    );
    expect(entry?.typeRule.allowed).toBe(true);

    const approved = await call(admin, "post", `/api/v1/admin/listings/${listing.id}/approve`);
    expect(dataOf<{ changed: boolean; listing: { status: string } }>(approved)).toMatchObject({
      changed: true,
      listing: { status: "APPROVED" },
    });
    expect(await isPublic(listing.id)).toBe(true);
    expect(await inSearch(listing.id)).toBe(true);
    const again = await call(admin, "post", `/api/v1/admin/listings/${listing.id}/approve`);
    expect(dataOf<{ changed: boolean }>(again).changed).toBe(false);
    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect([row.reviewedById, row.publishedAt !== null]).toEqual([admin.userId, true]);
    expect(
      await prisma.auditLog.count({ where: { entityId: listing.id, action: "listing.approve" } }),
    ).toBe(1);
  });

  it("rejection needs a reason, keeps it hidden, and the partner sees why", async () => {
    const listing = await pendingListing(
      world.providers.busProvider.id,
      "bus_ticket",
      "Bus Without Photos",
    );
    expect(
      (await call(admin, "post", `/api/v1/admin/listings/${listing.id}/reject`, {})).status,
    ).toBe(400);
    const res = await call(admin, "post", `/api/v1/admin/listings/${listing.id}/reject`, {
      reason: "Add the departure point and bus photos.",
    });
    expect(dataOf<{ listing: { status: string; reviewNote: string } }>(res).listing).toMatchObject({
      status: "REJECTED",
      reviewNote: "Add the departure point and bus photos.",
    });
    expect(await isPublic(listing.id)).toBe(false);
    expect(
      codeOf(await call(admin, "post", `/api/v1/admin/listings/${listing.id}/approve`)),
    ).toEqual([409, "LISTING_NOT_IN_REVIEW"]);
    // The database refuses a rejection without a reason.
    const other = await pendingListing(
      world.providers.busProvider.id,
      "bus_ticket",
      "Bus No Reason",
    );
    expect(
      await refusedBy(() =>
        prisma.listing.update({ where: { id: other.id }, data: { status: "REJECTED" } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "listings_review_chk" });
  });

  it("approval re-checks the type rule: a bus operator's hotel room is refused (API and database)", async () => {
    // The listing was created while the pair was allowed (e.g. before the rule changed).
    await prisma.providerTypeListingType.create({
      data: { providerTypeCode: "bus_operator", listingTypeCode: "hotel_room" },
    });
    let listing;
    try {
      listing = await pendingListing(
        world.providers.busProvider.id,
        "hotel_room",
        "Bus Depot Room",
      );
    } finally {
      await prisma.providerTypeListingType.delete({
        where: {
          providerTypeCode_listingTypeCode: {
            providerTypeCode: "bus_operator",
            listingTypeCode: "hotel_room",
          },
        },
      });
    }
    const hint = await call(admin, "get", `/api/v1/admin/listings/${listing.id}`);
    expect(dataOf<{ typeRule: { allowed: boolean; reason: string } }>(hint).typeRule).toMatchObject(
      {
        allowed: false,
        reason: "not_mapped",
      },
    );
    const res = await call(admin, "post", `/api/v1/admin/listings/${listing.id}/approve`);
    expect(codeOf(res)).toEqual([422, "LISTING_TYPE_NOT_ALLOWED"]);
    expect((res.body as ErrorResponseBody).error.details).toMatchObject({
      listingTypeCode: "hotel_room",
      providerTypeCode: "bus_operator",
      allowedListingTypes: ["bus_ticket"],
    });
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe(
      "PENDING_REVIEW",
    );
    expect(await prisma.auditLog.count({ where: { entityId: listing.id } })).toBe(0);
    // Bypassing the API: the database refuses the approval too.
    expect(
      await refusedBy(() =>
        prisma.listing.update({ where: { id: listing.id }, data: { status: "APPROVED" } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "listings_approval_type_rule_chk" });
  });

  it("non-admins cannot see or decide the queue", async () => {
    const listing = await pendingListing(
      world.providers.busProvider.id,
      "bus_ticket",
      "Bus Forbidden",
    );
    expect(codeOf(await call(customer, "get", "/api/v1/admin/listings"))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    expect(
      codeOf(await call(customer, "post", `/api/v1/admin/listings/${listing.id}/approve`)),
    ).toEqual([403, "FORBIDDEN"]);
    expect((await request(app).post(`/api/v1/admin/listings/${listing.id}/approve`)).status).toBe(
      401,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("voids and corrections (gap 13)", () => {
  const booked = (listingId: string, date: string) =>
    prisma.inventorySlot
      .findFirstOrThrow({ where: { listingId, serviceDate: new Date(`${date}T00:00:00Z`) } })
      .then((s) => s.capacityBooked);

  let tripId: string;
  let roomItemId: string;
  let busItemId: string;

  beforeAll(async () => {
    const created = await call(customer, "post", "/api/v1/trips", { currency: "NPR" });
    tripId = dataOf<{ id: string }>(created).id;
    await call(customer, "post", `/api/v1/trips/${tripId}/items`, {
      listingId: world.listings.room.id,
      startDate: world.day(2),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    await call(customer, "post", `/api/v1/trips/${tripId}/items`, {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 2,
      paymentMethod: "online",
    });
    expect((await call(customer, "post", `/api/v1/trips/${tripId}/confirm`)).status).toBe(200);
    const intent = await call(customer, "post", `/api/v1/trips/${tripId}/payments/intent`, {
      gateway: "simulated",
    });
    const paymentId = dataOf<{ payment: { id: string } }>(intent).payment.id;
    await call(customer, "post", `/api/v1/trips/${tripId}/payments/${paymentId}/confirm`, {});
    const items = await prisma.bookingItem.findMany({
      where: { tripId },
      orderBy: { createdAt: "asc" },
    });
    [roomItemId, busItemId] = items.map((i) => i.id) as [string, string];
    expect(items.map((i) => [i.status, i.paymentStatus, i.commissionStatus])).toEqual([
      ["CONFIRMED", "PAY_AT_PROPERTY", "INVOICED"],
      ["CONFIRMED", "PAID", "PENDING"],
    ]);
  });

  it("voiding a paid online item: cancelled, seats back, commission waived, refund REQUESTED (not executed)", async () => {
    const before = await booked(world.listings.bus.id, world.day(1));
    const res = await call(admin, "post", `/api/v1/admin/booking-items/${busItemId}/void`, {
      reason: "Bus route cancelled by the operator",
    });
    expect(dataOf<{ items: unknown[] }>(res).items).toEqual([
      { itemId: busItemId, changed: true, refundRequests: 1, invoiceAdjusted: false },
    ]);
    expect(await booked(world.listings.bus.id, world.day(1))).toBe(before - 2);
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: busItemId } });
    expect([
      item.status,
      item.commissionStatus,
      item.paymentStatus,
      item.voidedById,
      item.voidReason,
    ]).toEqual([
      "CANCELLED",
      "WAIVED",
      "PAID", // the money is still with MeroStay until the refund is executed (Phase 14)
      admin.userId,
      "Bus route cancelled by the operator",
    ]);
    const refunds = await prisma.refundRequest.findMany({ where: { bookingItemId: busItemId } });
    expect(refunds.map((r) => [r.status, r.amountMinor, r.gatewayRefundReference])).toEqual([
      ["REQUESTED", item.totalMinor, null],
    ]);
    expect(await prisma.payment.count({ where: { tripId, kind: "REFUND" } })).toBe(0);
    // Trip totals = the room only; the trip stays confirmed.
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    const room = await prisma.bookingItem.findUniqueOrThrow({ where: { id: roomItemId } });
    expect([trip.status, trip.totalMinor]).toEqual(["CONFIRMED", room.totalMinor]);
    expect(
      await prisma.auditLog.count({ where: { entityId: busItemId, action: "booking_item.void" } }),
    ).toBe(1);
  });

  it("voiding again changes nothing (no second release, no second refund request)", async () => {
    const before = await booked(world.listings.bus.id, world.day(1));
    const results = await Promise.all([
      call(admin, "post", `/api/v1/admin/booking-items/${busItemId}/void`, {
        reason: "again please",
      }),
      call(admin, "post", `/api/v1/admin/booking-items/${busItemId}/void`, {
        reason: "again please",
      }),
    ]);
    for (const r of results)
      expect(dataOf<{ items: { changed: boolean }[] }>(r).items[0]?.changed).toBe(false);
    expect(await booked(world.listings.bus.id, world.day(1))).toBe(before);
    expect(await prisma.refundRequest.count({ where: { bookingItemId: busItemId } })).toBe(1);
  });

  it("a settlement recorded by mistake is undone with a reason (audited); snapshots unchanged", async () => {
    const settle = await call(
      admin,
      "post",
      `/api/v1/admin/trips/${tripId}/payments/at-property/settle`,
      {
        itemIds: [roomItemId],
      },
    );
    expect(settle.status).toBe(200);
    const snapshot = await prisma.bookingItem.findUniqueOrThrow({ where: { id: roomItemId } });
    const res = await call(
      admin,
      "post",
      `/api/v1/admin/booking-items/${roomItemId}/settlement/reverse`,
      {
        reason: "Guest had not paid; recorded on the wrong booking",
      },
    );
    expect(dataOf<{ changed: boolean }>(res).changed).toBe(true);
    const after = await prisma.bookingItem.findUniqueOrThrow({ where: { id: roomItemId } });
    expect([after.paymentStatus, after.paymentSettledAt, after.paymentSettledById]).toEqual([
      "PAY_AT_PROPERTY",
      null,
      null,
    ]);
    expect([after.totalMinor, after.commissionMinor, after.commissionStatus]).toEqual([
      snapshot.totalMinor,
      snapshot.commissionMinor,
      snapshot.commissionStatus,
    ]);
    const again = await call(
      admin,
      "post",
      `/api/v1/admin/booking-items/${roomItemId}/settlement/reverse`,
      {
        reason: "again please",
      },
    );
    expect(dataOf<{ changed: boolean }>(again).changed).toBe(false);
    expect(
      codeOf(
        await call(admin, "post", `/api/v1/admin/booking-items/${busItemId}/settlement/reverse`, {
          reason: "not a settlement",
        }),
      ),
    ).toEqual([409, "ITEM_NOT_SETTLED"]);
    expect(
      await prisma.auditLog.count({
        where: { entityId: roomItemId, action: "booking_item.settlement.reverse" },
      }),
    ).toBe(1);
  });

  it("voiding an invoiced pay-at-property item: commission waived by an adjustment; the invoice is never edited", async () => {
    const invoice = await prisma.providerInvoice.findFirstOrThrow({ where: { tripId } });
    const before = await booked(world.listings.room.id, world.day(2));
    const res = await call(admin, "post", `/api/v1/admin/booking-items/${roomItemId}/void`, {
      reason: "Duplicate booking made by phone",
    });
    expect(
      dataOf<{ items: { invoiceAdjusted: boolean; refundRequests: number }[] }>(res).items[0],
    ).toMatchObject({
      invoiceAdjusted: true,
      refundRequests: 0,
    });
    expect(await booked(world.listings.room.id, world.day(2))).toBe(before - 1);
    const item = await prisma.bookingItem.findUniqueOrThrow({ where: { id: roomItemId } });
    const adjustments = await prisma.providerInvoiceAdjustment.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(adjustments.map((a) => [a.bookingItemId, a.amountMinor])).toEqual([
      [roomItemId, item.commissionMinor],
    ]);
    const after = await prisma.providerInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    // Fully adjusted (its only item) → VOID; the amount and number are untouched.
    expect([after.status, after.amountMinor, after.number]).toEqual([
      "VOID",
      invoice.amountMinor,
      invoice.number,
    ]);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: tripId } })).status).toBe(
      "CANCELLED",
    );
    // Adjustments are append-only and must match a waived item.
    expect(
      await refusedBy(() =>
        prisma.providerInvoiceAdjustment.deleteMany({ where: { invoiceId: invoice.id } }),
      ),
    ).toEqual({ sqlState: "23514", constraint: "provider_invoice_adjustments_append_only_chk" });
  });

  it("voiding a whole pending trip releases every hold and cancels it", async () => {
    const created = await call(customer, "post", "/api/v1/trips", { currency: "NPR" });
    const id = dataOf<{ id: string }>(created).id;
    await call(customer, "post", `/api/v1/trips/${id}/items`, {
      listingId: world.listings.guide.id,
      startDate: world.day(5),
      quantity: 1,
      paymentMethod: "online",
    });
    expect((await call(customer, "post", `/api/v1/trips/${id}/confirm`)).status).toBe(200);
    expect(await booked(world.listings.guide.id, world.day(5))).toBe(1);
    const res = await call(admin, "post", `/api/v1/admin/trips/${id}/void`, {
      reason: "Fraudulent booking",
    });
    expect(dataOf<{ items: { changed: boolean; refundRequests: number }[] }>(res).items).toEqual([
      expect.objectContaining({ changed: true, refundRequests: 0 }),
    ]);
    expect(await booked(world.listings.guide.id, world.day(5))).toBe(0);
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id } });
    expect([trip.status, trip.totalMinor]).toEqual(["CANCELLED", 0n]);
  });

  it("completed items cannot be voided; non-admins are refused", async () => {
    const created = await call(customer, "post", "/api/v1/trips", { currency: "NPR" });
    const id = dataOf<{ id: string }>(created).id;
    await call(customer, "post", `/api/v1/trips/${id}/items`, {
      listingId: world.listings.room.id,
      startDate: world.day(0),
      endDate: world.day(1),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    await call(customer, "post", `/api/v1/trips/${id}/confirm`);
    const item = await prisma.bookingItem.findFirstOrThrow({ where: { tripId: id } });
    await prisma.bookingItem.update({
      where: { id: item.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    expect(
      codeOf(
        await call(admin, "post", `/api/v1/admin/booking-items/${item.id}/void`, {
          reason: "too late now",
        }),
      ),
    ).toEqual([409, "ITEM_NOT_VOIDABLE_STATUS"]);
    expect(
      codeOf(
        await call(customer, "post", `/api/v1/admin/booking-items/${item.id}/void`, {
          reason: "please",
        }),
      ),
    ).toEqual([403, "FORBIDDEN"]);
    expect(
      codeOf(
        await call(admin, "post", `/api/v1/admin/booking-items/${randomUUID()}/void`, {
          reason: "unknown",
        }),
      ),
    ).toEqual([404, "ITEM_NOT_FOUND"]);
  });
});

it("money stays a digit string in every response (ADR 0005)", () => {
  expect(moneyBoundaryViolations(responses)).toEqual([]);
});

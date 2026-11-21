import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { toDbDate } from "../../domain/dates.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { countMoneyFields, moneyBoundaryViolations } from "../../testing/json-safety.js";
import { resolveTestDatabase } from "../../testing/test-database.js";
import { createTripsService } from "./trips.service.js";

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
});
let world: World;

/** A logged-in user: cookie-keeping agent + CSRF token (ADR 0006). */
interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
  /** "name=value" of the session cookie, for requests through another app instance. */
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

/** The trip owner used throughout this file. */
let me: Client;
/** The hotel + bus + guide trip from the first scenario (later used to test expiry of a mixed trip). */
let multiVerticalTripId: string;

/** Every response body we receive, checked for money-boundary violations at the end. */
const responses: unknown[] = [];

interface Money {
  subtotalMinor: string;
  serviceChargeMinor: string;
  taxMinor: string;
  totalMinor: string;
}
interface TripItem {
  id: string;
  status: string;
  listing: { id: string; listingType: string };
  paymentMethod: string;
  paymentStatus: string;
  quantity: number;
  lines: { date: string; units: number; unitPriceMinor: string; amountMinor: string }[];
  money: Money;
  cancellationPolicy: { name: string; rules: unknown[]; capturedAt: string } | null;
}
interface Trip {
  id: string;
  status: string;
  currency: string;
  currencyExponent: number;
  expiresAt: string | null;
  confirmedAt: string | null;
  totals: Record<string, string>;
  items: TripItem[];
}

const errorOf = (res: request.Response) => (res.body as ErrorResponseBody).error;

async function call(
  method: "get" | "post" | "patch" | "delete",
  url: string,
  body?: object,
  as: Client = me,
) {
  const req = as.agent[method](url).set("X-CSRF-Token", as.csrfToken);
  const res = body ? await req.send(body) : await req;
  responses.push(res.body);
  return res;
}

/** Commission/payout data is not in the customer view, so it is checked in the database. */
async function dbItem(id: string) {
  return prisma.bookingItem.findUniqueOrThrow({
    where: { id },
    select: {
      commissionRateBps: true,
      commissionMinor: true,
      providerPayoutMinor: true,
      commissionStatus: true,
      payoutStatus: true,
    },
  });
}
const tripOf = (res: request.Response) => (res.body as { data: Trip }).data;

async function newTrip(currency = "NPR"): Promise<Trip> {
  const res = await call("post", "/api/v1/trips", { currency });
  expect(res.status).toBe(201);
  return tripOf(res);
}

async function addItem(tripId: string, item: Record<string, unknown>) {
  return call("post", `/api/v1/trips/${tripId}/items`, item);
}

async function booked(listingId: string, n: number): Promise<number> {
  const slot = await prisma.inventorySlot.findUniqueOrThrow({
    where: { listingId_serviceDate: { listingId, serviceDate: toDbDate(world.day(n)) } },
  });
  return slot.capacityBooked;
}

/** Inventory rows whose held units differ from the units of active booking items in this world. */
async function holdLeaks() {
  return prisma.$queryRaw<
    { listing_id: string; service_date: Date; booked: number; held: bigint }[]
  >`
    SELECT s.listing_id::text, s.service_date, s.capacity_booked AS booked,
           COALESCE(SUM(bis.units) FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0) AS held
    FROM inventory_slots s
    JOIN listings l ON l.id = s.listing_id
    LEFT JOIN booking_item_slots bis ON bis.inventory_slot_id = s.id
    LEFT JOIN booking_items bi ON bi.id = bis.booking_item_id
    WHERE l.location_id IN (${world.locations.town.id}::uuid, ${world.locations.village.id}::uuid)
    GROUP BY s.id
    HAVING s.capacity_booked <> COALESCE(SUM(bis.units) FILTER (WHERE bi.status NOT IN ('CANCELLED', 'EXPIRED')), 0)`;
}

beforeAll(async () => {
  world = await createWorld(prisma);
  me = await signUp("owner");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("multi-vertical trip: hotel + bus + guide → quote → confirm", () => {
  let trip: Trip;

  it("creates a DRAFT trip with zero totals and a hold expiry", async () => {
    trip = await newTrip();
    multiVerticalTripId = trip.id;
    expect(trip).toMatchObject({ status: "DRAFT", currency: "NPR", currencyExponent: 2 });
    expect(trip.totals.totalMinor).toBe("0");
    expect(trip.expiresAt).not.toBeNull();
  });

  it("adds a homestay (2 nights, pay at property) with SC, VAT and 15% commission on the subtotal", async () => {
    const res = await addItem(trip.id, {
      listingId: world.listings.room.id,
      startDate: world.day(0),
      endDate: world.day(2),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(new RegExp(`/api/v1/trips/${trip.id}/items/`));
    const item = tripOf(res).items[0]!;
    expect(item.lines).toEqual([
      { date: world.day(0), units: 1, unitPriceMinor: "350000", amountMinor: "350000" },
      { date: world.day(1), units: 1, unitPriceMinor: "420000", amountMinor: "420000" },
    ]);
    // 7,700 + 10% SC 770 + 13% VAT on 8,470 = 1,101.10 → 9,571.10; commission 15% × 7,700 = 1,155.
    expect(item.money).toEqual({
      subtotalMinor: "770000",
      serviceChargeRateBps: 1000,
      serviceChargeMinor: "77000",
      taxRateBps: 1300,
      taxMinor: "110110",
      totalMinor: "957110",
      paidMinor: "0",
      refundedMinor: "0",
    });
    expect(item).toMatchObject({
      status: "PENDING",
      paymentMethod: "pay_at_property",
      paymentStatus: "PAY_AT_PROPERTY",
    });
    expect(await dbItem(item.id)).toEqual({
      commissionRateBps: 1500,
      commissionMinor: 115_500n,
      providerPayoutMinor: 841_610n,
      commissionStatus: "PENDING",
      payoutStatus: "NOT_APPLICABLE",
    });
    expect(item.cancellationPolicy).toMatchObject({ name: world.policy.name });
    expect(item.cancellationPolicy?.rules).toHaveLength(2);
  });

  it("adds 2 bus seats (online) and a guide for 3 days (online)", async () => {
    const bus = await addItem(trip.id, {
      listingId: world.listings.bus.id,
      startDate: world.day(0),
      quantity: 2,
      paymentMethod: "online",
      attributes: { seatNumbers: ["A1", "A2"] },
    });
    expect(bus.status).toBe(201);
    const guide = await addItem(trip.id, {
      listingId: world.listings.guide.id,
      startDate: world.day(1),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "online",
    });
    expect(guide.status).toBe(201);

    const items = tripOf(guide).items;
    expect(items.map((i) => i.listing.listingType)).toEqual([
      "hotel_room",
      "bus_ticket",
      "guide_service",
    ]);
    expect(items[1]!.money).toMatchObject({ subtotalMinor: "360000", totalMinor: "360000" });
    expect(items[1]).toMatchObject({ paymentStatus: "UNPAID" });
    expect(await dbItem(items[1]!.id)).toMatchObject({
      commissionMinor: 54_000n,
      providerPayoutMinor: 306_000n,
      payoutStatus: "PENDING",
    });
    expect(items[2]!.money).toMatchObject({ subtotalMinor: "900000" });
    expect(await dbItem(items[2]!.id)).toMatchObject({ commissionMinor: 135_000n });
    expect(items[2]!.quantity).toBe(3);
  });

  it("reports trip totals as the sum of items, split by payment method", async () => {
    trip = tripOf(await call("get", `/api/v1/trips/${trip.id}`));
    expect(trip.totals).toEqual({
      subtotalMinor: "2030000", // 7,700 + 3,600 + 9,000
      serviceChargeMinor: "77000",
      taxMinor: "110110",
      totalMinor: "2217110", // 9,571.10 + 3,600 + 9,000
      payOnlineMinor: "1260000",
      payAtPropertyMinor: "957110",
    });
    // Commission is stored per item and summed on the trip (not in the customer view).
    const stored = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(stored.commissionTotalMinor).toBe(304_500n); // 1,155 + 540 + 1,350
  });

  it("holds exactly the booked units in inventory", async () => {
    expect(await booked(world.listings.room.id, 0)).toBe(1);
    expect(await booked(world.listings.room.id, 1)).toBe(1);
    expect(await booked(world.listings.bus.id, 0)).toBe(2);
    for (const n of [1, 2, 3]) expect(await booked(world.listings.guide.id, n)).toBe(1);
  });

  it("quote: re-prices without persisting, matches the stored totals, and prices candidates", async () => {
    const plain = await call("post", `/api/v1/trips/${trip.id}/quote`, {});
    expect(plain.status).toBe(200);
    const quote = (
      plain.body as {
        data: {
          dryRun: boolean;
          totals: Record<string, string>;
          lines: { priceChanged: boolean; available: boolean }[];
        };
      }
    ).data;
    expect(quote.dryRun).toBe(true);
    expect(quote.totals).toEqual(trip.totals); // API quote maths == what was stored (and accepted by the DB CHECKs)
    expect(quote.lines.every((l) => !l.priceChanged && l.available)).toBe(true);

    const withCandidate = await call("post", `/api/v1/trips/${trip.id}/quote`, {
      items: [
        {
          listingId: world.listings.bus.id,
          startDate: world.day(1),
          quantity: 1,
          paymentMethod: "online",
        },
      ],
    });
    const quoted = (
      withCandidate.body as {
        data: { totals: Record<string, string>; lines: { candidateIndex: number | null }[] };
      }
    ).data;
    expect(quoted.lines.map((l) => l.candidateIndex)).toEqual([null, null, null, 0]);
    expect(quoted.totals.subtotalMinor).toBe("2210000"); // + 1,800

    // Nothing was written: the trip and the inventory are unchanged.
    expect(tripOf(await call("get", `/api/v1/trips/${trip.id}`)).totals).toEqual(trip.totals);
    expect(await booked(world.listings.bus.id, 1)).toBe(0);
  });

  it("confirm: pay-at-property → CONFIRMED + commission INVOICED; online items await payment", async () => {
    const res = await call("post", `/api/v1/trips/${trip.id}/confirm`);
    expect(res.status).toBe(200);
    const confirmed = tripOf(res);
    expect(confirmed.status).toBe("PENDING"); // online items still need payment (later phase)
    expect(confirmed.confirmedAt).toBeNull();
    expect(confirmed.expiresAt).not.toBeNull(); // payment window

    const [hotel, bus, guide] = confirmed.items;
    expect(hotel).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAY_AT_PROPERTY" });
    expect(await dbItem(hotel!.id)).toMatchObject({
      commissionStatus: "INVOICED",
      payoutStatus: "NOT_APPLICABLE",
    });
    for (const online of [bus!, guide!]) {
      expect(online).toMatchObject({ status: "PENDING", paymentStatus: "UNPAID" });
      expect(await dbItem(online.id)).toMatchObject({
        commissionStatus: "PENDING",
        payoutStatus: "PENDING",
      });
    }
    // Money snapshots are unchanged by confirm.
    expect(confirmed.totals).toEqual(trip.totals);
    expect(confirmed.items.map((i) => i.money)).toEqual(trip.items.map((i) => i.money));
  });

  it("an all-pay-at-property trip becomes CONFIRMED", async () => {
    const t = await newTrip();
    await addItem(t.id, {
      listingId: world.listings.room.id,
      startDate: world.day(2),
      quantity: 1,
      paymentMethod: "pay_at_property",
    });
    const confirmed = tripOf(await call("post", `/api/v1/trips/${t.id}/confirm`));
    expect(confirmed).toMatchObject({ status: "CONFIRMED", expiresAt: null });
    expect(confirmed.confirmedAt).not.toBeNull();
    // Release it again so later tests see the original capacity.
    await prisma.inventorySlot.update({
      where: {
        listingId_serviceDate: {
          listingId: world.listings.room.id,
          serviceDate: toDbDate(world.day(2)),
        },
      },
      data: { capacityBooked: { decrement: 1 } },
    });
    await prisma.bookingItem.updateMany({ where: { tripId: t.id }, data: { status: "CANCELLED" } });
  });

  it("a submitted trip can no longer be edited, quoted or confirmed again", async () => {
    const add = await addItem(trip.id, {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 1,
      paymentMethod: "online",
    });
    expect(add.status).toBe(409);
    expect(errorOf(add).code).toBe("TRIP_NOT_EDITABLE");
    expect((await call("post", `/api/v1/trips/${trip.id}/quote`, {})).status).toBe(409);
    expect((await call("post", `/api/v1/trips/${trip.id}/confirm`)).status).toBe(409);
  });

  it("the database agrees with every stored amount (CHECK formulas re-evaluated in SQL)", async () => {
    const mismatches = await prisma.$queryRaw<{ id: string }[]>`
      SELECT bi.id::text AS id FROM booking_items bi
      WHERE bi.trip_id = ${trip.id}::uuid AND (
        bi.commission_minor     <> ROUND(bi.subtotal_minor::numeric * bi.commission_rate_bps / 10000)
        OR bi.service_charge_minor <> ROUND(bi.subtotal_minor::numeric * bi.service_charge_rate_bps / 10000)
        OR bi.tax_minor         <> ROUND((bi.subtotal_minor::numeric + bi.service_charge_minor) * bi.tax_rate_bps / 10000)
        OR bi.total_minor       <> bi.subtotal_minor + bi.service_charge_minor + bi.tax_minor
        OR bi.provider_payout_minor <> bi.total_minor - bi.commission_minor
        OR bi.subtotal_minor    <> (SELECT SUM(amount_minor) FROM booking_item_slots s WHERE s.booking_item_id = bi.id)
      )`;
    expect(mismatches).toEqual([]);
  });
});

describe("overbooking is impossible (database constraint → clean 409)", () => {
  it("rejects seats beyond capacity, with no partial writes and no PostgreSQL text", async () => {
    // Day 0 bus: 2 seats, both held by the first trip.
    const t = await newTrip();
    const before = await booked(world.listings.bus.id, 0);
    const res = await addItem(t.id, {
      listingId: world.listings.bus.id,
      startDate: world.day(0),
      quantity: 1,
      paymentMethod: "online",
    });

    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: "INSUFFICIENT_AVAILABILITY",
      details: { date: world.day(0), requested: 1 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Failing row|violates|inventory_slots|23514/);

    expect(await booked(world.listings.bus.id, 0)).toBe(before);
    expect(tripOf(await call("get", `/api/v1/trips/${t.id}`)).items).toEqual([]);
  });

  it("a multi-night stay that is full on ONE night fails as a whole (all-or-nothing)", async () => {
    // Fill night 3 of the room completely, then ask for nights 2–3.
    const blocker = await newTrip();
    const fill = await addItem(blocker.id, {
      listingId: world.listings.room.id,
      startDate: world.day(3),
      quantity: 3,
      paymentMethod: "online",
    });
    expect(fill.status).toBe(201);

    const before2 = await booked(world.listings.room.id, 2);
    const t = await newTrip();
    const res = await addItem(t.id, {
      listingId: world.listings.room.id,
      startDate: world.day(2),
      endDate: world.day(4),
      quantity: 1,
      paymentMethod: "online",
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ date: world.day(3) });
    expect(await booked(world.listings.room.id, 2)).toBe(before2); // night 2 was rolled back too

    await call("delete", `/api/v1/trips/${blocker.id}/items/${tripOf(fill).items[0]!.id}`);
  });

  it("two simultaneous requests for the last unit: exactly one wins", async () => {
    // Guide day 5: capacity 1, untouched so far.
    const [a, b] = [await newTrip(), await newTrip()];
    const body = {
      listingId: world.listings.guide.id,
      startDate: world.day(5),
      quantity: 1,
      paymentMethod: "online",
    };
    const results = await Promise.all([addItem(a.id, body), addItem(b.id, body)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await booked(world.listings.guide.id, 5)).toBe(1);
  });
});

describe("rules that return 404 / 409 / 422", () => {
  it.each([
    [
      "an item in another currency (NPR trip, USD listing)",
      "NPR",
      () => world.listings.usdRoom.id,
      0,
      undefined,
      422,
      "CURRENCY_MISMATCH",
    ],
    [
      "an item in another currency (USD trip, NPR listing)",
      "USD",
      () => world.listings.room.id,
      0,
      undefined,
      422,
      "CURRENCY_MISMATCH",
    ],
    [
      "an inactive vertical (flight)",
      "NPR",
      () => world.listings.flight.id,
      0,
      undefined,
      422,
      "LISTING_NOT_BOOKABLE",
    ],
    [
      "a draft listing",
      "NPR",
      () => world.listings.draftRoom.id,
      0,
      undefined,
      422,
      "LISTING_NOT_BOOKABLE",
    ],
    [
      "an unverified provider",
      "NPR",
      () => world.listings.unverifiedRoom.id,
      0,
      undefined,
      422,
      "LISTING_NOT_BOOKABLE",
    ],
    [
      "a container listing (the hotel itself)",
      "NPR",
      () => world.listings.hotel.id,
      0,
      undefined,
      422,
      "LISTING_NOT_BOOKABLE",
    ],
    [
      "an unknown listing",
      "NPR",
      () => "00000000-0000-4000-8000-000000000000",
      0,
      undefined,
      422,
      "UNKNOWN_LISTING",
    ],
    ["a CLOSED date", "NPR", () => world.listings.room.id, 4, undefined, 409, "NOT_AVAILABLE"],
    [
      "a date with no inventory",
      "NPR",
      () => world.listings.bus.id,
      3,
      undefined,
      409,
      "NOT_AVAILABLE",
    ],
    ["more than 30 nights", "NPR", () => world.listings.room.id, 0, 31, 422, "INVALID_DATE_RANGE"],
  ])("rejects %s", async (_label, currency, listingId, startDay, endDay, status, code) => {
    const t = await newTrip(currency);
    const res = await addItem(t.id, {
      listingId: listingId(),
      startDate: world.day(startDay),
      ...(endDay === undefined ? {} : { endDate: world.day(endDay) }),
      quantity: 1,
      paymentMethod: "online",
    });
    expect(res.status).toBe(status);
    expect(errorOf(res).code).toBe(code);
  });

  it("rejects a date in the past", async () => {
    const t = await newTrip();
    const res = await addItem(t.id, {
      listingId: world.listings.room.id,
      startDate: "2020-01-01",
      quantity: 1,
      paymentMethod: "online",
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("DATE_IN_PAST");
  });

  it("quote rejects a candidate in another currency", async () => {
    const t = await newTrip();
    const res = await call("post", `/api/v1/trips/${t.id}/quote`, {
      items: [
        {
          listingId: world.listings.usdRoom.id,
          startDate: world.day(0),
          quantity: 1,
          paymentMethod: "online",
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("CURRENCY_MISMATCH");
  });

  it("rejects a body that still sends userId, an unknown trip, an unknown item and confirming an empty trip", async () => {
    // The temporary userId is gone: the owner comes from the session (ADR 0006).
    const user = await call("post", "/api/v1/trips", {
      userId: "00000000-0000-4000-8000-000000000000",
    });
    expect([user.status, errorOf(user).code]).toEqual([400, "VALIDATION_ERROR"]);
    const trip = await call("get", "/api/v1/trips/00000000-0000-4000-8000-000000000000");
    expect([trip.status, errorOf(trip).code]).toEqual([404, "TRIP_NOT_FOUND"]);
    const t = await newTrip();
    const item = await call(
      "delete",
      `/api/v1/trips/${t.id}/items/00000000-0000-4000-8000-000000000000`,
    );
    expect([item.status, errorOf(item).code]).toEqual([404, "ITEM_NOT_FOUND"]);
    const empty = await call("post", `/api/v1/trips/${t.id}/confirm`);
    expect([empty.status, errorOf(empty).code]).toEqual([409, "TRIP_EMPTY"]);
  });
});

describe("PATCH and DELETE items: money and holds are recomputed", () => {
  let tripId: string;
  let itemId: string;

  it("changing quantity re-prices the item and re-reserves inventory", async () => {
    const t = await newTrip();
    tripId = t.id;
    const added = await addItem(tripId, {
      listingId: world.listings.room.id,
      startDate: world.day(2),
      endDate: world.day(3),
      quantity: 1,
      paymentMethod: "online",
    });
    itemId = tripOf(added).items[0]!.id;
    const before = await booked(world.listings.room.id, 2);

    const res = await call("patch", `/api/v1/trips/${tripId}/items/${itemId}`, { quantity: 2 });
    expect(res.status).toBe(200);
    const item = tripOf(res).items[0]!;
    expect(item.money.subtotalMinor).toBe("700000"); // 2 rooms × Rs 3,500
    expect(item.quantity).toBe(2);
    expect(await booked(world.listings.room.id, 2)).toBe(before + 1);
    expect(tripOf(res).totals.subtotalMinor).toBe("700000");
  });

  it("a change that cannot be booked is rejected and leaves the item exactly as it was", async () => {
    const before = tripOf(await call("get", `/api/v1/trips/${tripId}`));
    const holdBefore = await booked(world.listings.room.id, 2);

    // Night 4 is CLOSED.
    const res = await call("patch", `/api/v1/trips/${tripId}/items/${itemId}`, {
      endDate: world.day(5),
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("NOT_AVAILABLE");

    const after = tripOf(await call("get", `/api/v1/trips/${tripId}`));
    expect(after.items).toEqual(before.items);
    expect(await booked(world.listings.room.id, 2)).toBe(holdBefore);
  });

  it("switching the payment method updates the per-item statuses", async () => {
    const res = await call("patch", `/api/v1/trips/${tripId}/items/${itemId}`, {
      paymentMethod: "pay_at_property",
    });
    expect(tripOf(res).items[0]).toMatchObject({ paymentStatus: "PAY_AT_PROPERTY" });
    expect(await dbItem(itemId)).toMatchObject({ payoutStatus: "NOT_APPLICABLE" });
    expect(tripOf(res).totals).toMatchObject({
      payAtPropertyMinor: tripOf(res).totals.totalMinor,
      payOnlineMinor: "0",
    });
  });

  it("deleting an item releases its holds and zeroes the totals", async () => {
    const holdBefore = await booked(world.listings.room.id, 2);
    const res = await call("delete", `/api/v1/trips/${tripId}/items/${itemId}`);
    expect(res.status).toBe(200);
    expect(tripOf(res).items).toEqual([]);
    expect(tripOf(res).totals.totalMinor).toBe("0");
    expect(await booked(world.listings.room.id, 2)).toBe(holdBefore - 2);
  });
});

describe("ownership: a trip is visible and editable only by its owner (ADR 0006)", () => {
  let tripId: string;
  let itemId: string;
  let stranger: Client;

  beforeAll(async () => {
    stranger = await signUp("stranger");
    const t = await newTrip();
    tripId = t.id;
    const added = await addItem(tripId, {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 1,
      paymentMethod: "online",
    });
    itemId = tripOf(added).items[0]!.id;
  });

  it.each([
    ["read", "get", () => `/api/v1/trips/${tripId}`, undefined],
    [
      "add an item to",
      "post",
      () => `/api/v1/trips/${tripId}/items`,
      { listingId: "", startDate: "", quantity: 1, paymentMethod: "online" },
    ],
    [
      "change an item of",
      "patch",
      () => `/api/v1/trips/${tripId}/items/${itemId}`,
      { quantity: 2 },
    ],
    ["delete an item of", "delete", () => `/api/v1/trips/${tripId}/items/${itemId}`, undefined],
    ["quote", "post", () => `/api/v1/trips/${tripId}/quote`, {}],
    ["confirm", "post", () => `/api/v1/trips/${tripId}/confirm`, undefined],
  ] as const)(
    "another user cannot %s my trip: 404 TRIP_NOT_FOUND, same as a trip that does not exist",
    async (_label, method, url, body) => {
      const payload =
        body && "listingId" in body
          ? { ...body, listingId: world.listings.bus.id, startDate: world.day(1) }
          : body;
      const res = await call(method, url(), payload, stranger);
      expect(res.status).toBe(404);
      expect(errorOf(res)).toEqual({ code: "TRIP_NOT_FOUND", message: "Trip not found." });

      const missing = await call(method, url().replace(tripId, randomUUID()), payload, stranger);
      expect(missing.body).toEqual(res.body); // indistinguishable: existence does not leak
    },
  );

  it("the stranger's attempts changed nothing", async () => {
    const trip = tripOf(await call("get", `/api/v1/trips/${tripId}`));
    expect(trip.status).toBe("DRAFT");
    expect(trip.items.map((i) => [i.id, i.quantity])).toEqual([[itemId, 1]]);
  });

  it("without a session every trip endpoint is 401", async () => {
    const anonymous = await request(app).get(`/api/v1/trips/${tripId}`);
    expect([anonymous.status, errorOf(anonymous).code]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("with a session but no CSRF token, writes are refused (403) and reads still work", async () => {
    const write = await me.agent.post(`/api/v1/trips/${tripId}/quote`).send({});
    expect([write.status, errorOf(write).code]).toEqual([403, "CSRF_TOKEN_INVALID"]);
    const forged = await me.agent
      .post(`/api/v1/trips/${tripId}/quote`)
      .set("X-CSRF-Token", stranger.csrfToken)
      .send({});
    expect(forged.status).toBe(403); // another session's token does not work
    expect((await me.agent.get(`/api/v1/trips/${tripId}`)).status).toBe(200);
  });

  it("each user only ever sees their own trips: the stranger can still use their own", async () => {
    const own = await call("post", "/api/v1/trips", {}, stranger);
    expect(own.status).toBe(201);
    expect((await call("get", `/api/v1/trips/${tripOf(own).id}`, undefined, stranger)).status).toBe(
      200,
    );
    expect((await call("get", `/api/v1/trips/${tripOf(own).id}`)).status).toBe(404); // and I can't see theirs
  });
});

describe("invariants after all API writes", () => {
  it("every trip's stored totals equal the sum of its active items", async () => {
    const mismatches = await prisma.$queryRaw<{ reference: string }[]>`
      SELECT t.reference FROM trips t
      JOIN booking_items bi ON bi.trip_id = t.id AND bi.status NOT IN ('CANCELLED', 'EXPIRED')
      WHERE t.customer_id = ${me.userId}::uuid
      GROUP BY t.id
      HAVING t.subtotal_minor <> SUM(bi.subtotal_minor) OR t.total_minor <> SUM(bi.total_minor)
          OR t.commission_total_minor <> SUM(bi.commission_minor)`;
    expect(mismatches).toEqual([]);
  });

  it("inventory holds equal the units of active booking items (nothing leaked, nothing lost)", async () => {
    expect(await holdLeaks()).toEqual([]);
  });

  it("no customer response ever contained commission or provider-payout data", () => {
    const leaks = JSON.stringify(responses).match(
      /"[A-Za-z]*(?:[Cc]ommission|[Pp]ayout)[A-Za-z]*"\s*:/g,
    );
    expect(leaks).toBeNull();
  });

  it("no response ever contained a password hash", () => {
    expect(JSON.stringify(responses)).not.toMatch(/argon2|passwordHash|password_hash/);
  });

  it("every money field in every response was a digit string with its currency, and JSON-safe", () => {
    expect(responses.length).toBeGreaterThan(30);
    expect(countMoneyFields(responses)).toBeGreaterThan(200);
    expect(moneyBoundaryViolations(responses)).toEqual([]);
    expect(() => JSON.stringify(responses)).not.toThrow();
  });
});

describe("hold expiry", () => {
  it("an expired draft cannot be edited, and the sweeper releases its holds", async () => {
    const t = await newTrip();
    await addItem(t.id, {
      listingId: world.listings.bus.id,
      startDate: world.day(1),
      quantity: 3,
      paymentMethod: "online",
    });
    const held = await booked(world.listings.bus.id, 1);

    const later = () => new Date(Date.now() + 31 * 60_000);
    const lateApp = createApp({
      logger: pino({ level: "silent" }),
      checkDatabase: () => Promise.resolve(),
      prisma,
      auth: testAuthConfig(),
      now: later,
    });
    const edit = await request(lateApp)
      .post(`/api/v1/trips/${t.id}/items`)
      .set("Cookie", me.cookie)
      .set("X-CSRF-Token", me.csrfToken)
      .send({
        listingId: world.listings.bus.id,
        startDate: world.day(1),
        quantity: 1,
        paymentMethod: "online",
      });
    expect([edit.status, errorOf(edit).code]).toEqual([409, "TRIP_EXPIRED"]);

    const expired = await createTripsService({ prisma, now: later }).expireStaleTrips();
    expect(expired).toBeGreaterThanOrEqual(1);

    const after = await prisma.trip.findUniqueOrThrow({
      where: { id: t.id },
      include: { items: true },
    });
    expect(after.status).toBe("EXPIRED");
    expect(after.items.map((i) => i.status)).toEqual(["EXPIRED"]);
    expect(after.totalMinor).toBe(0n);
    // Its 3 seats are back (other stale drafts on the same date may have released more), and every
    // remaining hold matches an active item exactly.
    expect(await booked(world.listings.bus.id, 1)).toBeLessThanOrEqual(held - 3);
    expect(await holdLeaks()).toEqual([]);

    // The mixed trip (hotel paid at property = CONFIRMED; bus + guide online = PENDING) keeps the
    // hotel, expires the unpaid online items, and becomes CONFIRMED with hotel-only totals.
    const mixed = await prisma.trip.findUniqueOrThrow({
      where: { id: multiVerticalTripId },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    expect(mixed.status).toBe("CONFIRMED");
    expect(mixed.items.map((i) => [i.listingTypeCode, i.status])).toEqual([
      ["hotel_room", "CONFIRMED"],
      ["bus_ticket", "EXPIRED"],
      ["guide_service", "EXPIRED"],
    ]);
    expect([mixed.subtotalMinor, mixed.totalMinor, mixed.commissionTotalMinor]).toEqual([
      770_000n,
      957_110n,
      115_500n,
    ]);
    expect(mixed.expiresAt).toBeNull();
    expect(mixed.confirmedAt).not.toBeNull();

    // Every released unit is accounted for, and a second sweep finds nothing to do.
    expect(await holdLeaks()).toEqual([]);
    expect(await createTripsService({ prisma, now: later }).expireStaleTrips()).toBe(0);
  });
});

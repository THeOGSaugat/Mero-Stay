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

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
});
let world: World;

interface ListingSummary {
  id: string;
  listingType: { code: string };
  basePriceMinor: string;
  availability: { minAvailable: number; estimatedSubtotalMinor: string } | null;
}
interface SearchBody {
  data: ListingSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

beforeAll(async () => {
  world = await createWorld(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const search = async (params: Record<string, string>) => {
  const res = await request(app)
    .get("/api/v1/listings")
    .query({ location: world.locations.province.slug, ...params });
  return { res, body: res.body as SearchBody };
};

describe("GET /api/v1/listing-types", () => {
  it("lists every vertical, with flights present but inactive", async () => {
    const res = await request(app).get("/api/v1/listing-types");
    expect(res.status).toBe(200);
    const types = (
      res.body as {
        data: { code: string; isActive: boolean; isBookable: boolean; unitLabel: string }[];
      }
    ).data;
    expect(types.map((t) => t.code)).toEqual([
      "activity",
      "bus_ticket",
      "flight_ticket",
      "guide_service",
      "hotel",
      "hotel_room",
      "tour",
    ]);
    expect(types.find((t) => t.code === "flight_ticket")).toMatchObject({ isActive: false });
    expect(types.find((t) => t.code === "hotel")).toMatchObject({ isBookable: false });
  });
});

describe("GET /api/v1/listings", () => {
  it("returns only bookable, approved listings of active types from verified providers", async () => {
    const { res, body } = await search({});
    expect(res.status).toBe(200);
    const ids = body.data.map((l) => l.id);
    const { room, bus, guide, hotel, draftRoom, unverifiedRoom, flight, usdRoom } = world.listings;
    expect(ids).toEqual(expect.arrayContaining([room.id, bus.id, guide.id, usdRoom.id]));
    for (const hidden of [hotel.id, draftRoom.id, unverifiedRoom.id, flight.id]) {
      expect(ids).not.toContain(hidden);
    }
  });

  it("includes listings in descendant locations (province → town → village)", async () => {
    const { body } = await search({ type: "hotel_room", currency: "NPR" });
    expect(body.data.map((l) => l.id)).toEqual([world.listings.room.id]); // room is in the village
  });

  it("filters by listing type, the same way for every vertical", async () => {
    for (const [type, listing] of [
      ["bus_ticket", world.listings.bus],
      ["guide_service", world.listings.guide],
    ] as const) {
      const { body } = await search({ type });
      expect(body.data.map((l) => l.id)).toEqual([listing.id]);
    }
  });

  it("returns no flights even when asked, because the vertical is inactive", async () => {
    const { res, body } = await search({ type: "flight_ticket" });
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("filters by price range (money given as minor-unit strings) and sorts by price", async () => {
    const { body } = await search({ currency: "NPR", minPrice: "180000", maxPrice: "300000" });
    expect(body.data.map((l) => l.basePriceMinor)).toEqual(["180000", "300000"]);
    const desc = await search({ currency: "NPR", sort: "price_desc" });
    expect(desc.body.data.map((l) => l.basePriceMinor)).toEqual(["350000", "300000", "180000"]);
  });

  it("only returns listings with enough free units on EVERY requested date", async () => {
    // The bus has 2 seats on day 0 and no inventory on day 2.
    const twoSeats = await search({ type: "bus_ticket", startDate: world.day(0), quantity: "2" });
    expect(twoSeats.body.data).toHaveLength(1);
    expect(twoSeats.body.data[0]?.availability).toMatchObject({
      minAvailable: 2,
      estimatedSubtotalMinor: "360000",
    });

    const threeSeats = await search({ type: "bus_ticket", startDate: world.day(0), quantity: "3" });
    expect(threeSeats.body.data).toEqual([]);

    // Room: day 4 is CLOSED, so a stay across it is unavailable, but one ending before it is fine.
    const across = await search({
      type: "hotel_room",
      currency: "NPR",
      startDate: world.day(3),
      endDate: world.day(5),
    });
    expect(across.body.data).toEqual([]);
    const stay = await search({
      type: "hotel_room",
      currency: "NPR",
      startDate: world.day(0),
      endDate: world.day(2),
    });
    // Night 0 at 3,500 + night 1 at the festival price 4,200, for 1 room.
    expect(stay.body.data[0]?.availability).toMatchObject({
      minAvailable: 3,
      estimatedSubtotalMinor: "770000",
    });
  });

  it("never offers inventory that another trip already holds", async () => {
    const slot = await prisma.inventorySlot.findUniqueOrThrow({
      where: {
        listingId_serviceDate: {
          listingId: world.listings.bus.id,
          serviceDate: toDbDate(world.day(0)),
        },
      },
    });
    await prisma.inventorySlot.update({ where: { id: slot.id }, data: { capacityBooked: 1 } });
    try {
      const { body } = await search({ type: "bus_ticket", startDate: world.day(0), quantity: "2" });
      expect(body.data).toEqual([]);
    } finally {
      await prisma.inventorySlot.update({ where: { id: slot.id }, data: { capacityBooked: 0 } });
    }
  });

  it("paginates", async () => {
    const first = await search({ currency: "NPR", pageSize: "2", page: "1" });
    expect(first.body.pagination).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    const second = await search({ currency: "NPR", pageSize: "2", page: "2" });
    expect(second.body.data).toHaveLength(1);
  });

  it("returns every money field as a digit string with its currency", async () => {
    const { body } = await search({ startDate: world.day(0) });
    expect(countMoneyFields(body)).toBeGreaterThan(0);
    expect(moneyBoundaryViolations(body)).toEqual([]);
  });

  it.each([
    ["unknown location", { location: "nowhere-at-all" }, 422, "UNKNOWN_LOCATION"],
    ["unknown listing type", { type: "spaceship" }, 422, "UNKNOWN_LISTING_TYPE"],
    ["a date in the past", { startDate: "2020-01-01" }, 422, "DATE_IN_PAST"],
    [
      "a reversed range",
      { startDate: "2099-01-05", endDate: "2099-01-04" },
      422,
      "INVALID_DATE_RANGE",
    ],
  ])("rejects %s", async (_label, params, status, code) => {
    const res = await request(app).get("/api/v1/listings").query(params);
    expect(res.status).toBe(status);
    expect((res.body as ErrorResponseBody).error.code).toBe(code);
  });
});

describe("GET /api/v1/listings/:id", () => {
  interface DetailBody {
    data: {
      listingType: { code: string; isBookable: boolean };
      details: Record<string, unknown> | null;
      children: { id: string }[];
      cancellationPolicy: { name: string } | null;
      calendar: {
        slots: { date: string; status: string; available: number; unitPriceMinor: string }[];
      };
    };
  }

  it("returns the type-specific details and a priced availability calendar", async () => {
    const res = await request(app)
      .get(`/api/v1/listings/${world.listings.room.id}`)
      .query({ from: world.day(0), to: world.day(5) });
    expect(res.status).toBe(200);
    const { data } = res.body as DetailBody;
    expect(data.details).toMatchObject({ maxAdults: 2, bedType: "double" });
    expect(data.cancellationPolicy?.name).toBe(world.policy.name);
    expect(data.calendar.slots).toEqual([
      { date: world.day(0), status: "OPEN", available: 3, unitPriceMinor: "350000" },
      { date: world.day(1), status: "OPEN", available: 3, unitPriceMinor: "420000" },
      { date: world.day(2), status: "OPEN", available: 3, unitPriceMinor: "350000" },
      { date: world.day(3), status: "OPEN", available: 3, unitPriceMinor: "350000" },
      { date: world.day(4), status: "CLOSED", available: 3, unitPriceMinor: "350000" },
    ]);
    expect(moneyBoundaryViolations(res.body)).toEqual([]);
  });

  it("works unchanged for another vertical (bus route details with origin/destination)", async () => {
    const res = await request(app)
      .get(`/api/v1/listings/${world.listings.bus.id}`)
      .query({ from: world.day(0) });
    const { data } = res.body as DetailBody;
    expect(data.listingType.code).toBe("bus_ticket");
    expect(data.details).toMatchObject({
      departureTime: "06:30",
      origin: { slug: world.locations.town.slug },
      destination: { slug: world.locations.village.slug },
    });
  });

  it("shows a container (hotel) with its bookable rooms and no calendar", async () => {
    const res = await request(app).get(`/api/v1/listings/${world.listings.hotel.id}`);
    const { data } = res.body as DetailBody;
    expect(data.listingType).toMatchObject({ code: "hotel", isBookable: false });
    expect(data.children.map((c) => c.id)).toEqual([world.listings.room.id]);
    expect(data.calendar.slots).toEqual([]);
  });

  it.each([
    ["an inactive vertical (flight)", () => world.listings.flight.id],
    ["a draft listing", () => world.listings.draftRoom.id],
    ["an unverified provider's listing", () => world.listings.unverifiedRoom.id],
    ["an unknown id", () => "00000000-0000-4000-8000-000000000000"],
  ])("returns 404 for %s", async (_label, id) => {
    const res = await request(app).get(`/api/v1/listings/${id()}`);
    expect(res.status).toBe(404);
    expect((res.body as ErrorResponseBody).error.code).toBe("LISTING_NOT_FOUND");
  });
});

import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { unauthenticatedTripsEnabled } from "../config/env.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { ErrorResponseBody } from "../lib/errors.js";
import { searchListingsQuerySchema } from "./listings/listings.schemas.js";
import {
  addItemBodySchema,
  createTripBodySchema,
  updateItemBodySchema,
} from "./trips/trips.schemas.js";

/**
 * Validation and wiring without a database. The fake Prisma client fails loudly if a request that
 * should have been rejected by validation ever reaches the data layer.
 */
const exploding = new Proxy(
  {},
  {
    get: () => {
      throw new Error("validation should have rejected this request before any database call");
    },
  },
) as PrismaClient;

function app(options: { tripsEnabled?: boolean } = {}) {
  return createApp({
    logger: pino({ level: "silent" }),
    checkDatabase: () => Promise.resolve(),
    prisma: exploding,
    unauthenticatedTripsEnabled: options.tripsEnabled ?? true,
  });
}

const errorOf = (res: request.Response) => (res.body as ErrorResponseBody).error;
const uuid = "6f1c2c1e-1b6a-4c8e-9a4e-2f3b4c5d6e7f";
const validItem = {
  listingId: uuid,
  startDate: "2027-03-01",
  quantity: 1,
  paymentMethod: "online",
};

describe("request validation (400 VALIDATION_ERROR, before any database work)", () => {
  it.each([
    ["unknown query parameter", "/api/v1/listings?colour=red"],
    ["bad date", "/api/v1/listings?startDate=2027-02-30"],
    ["endDate without startDate", "/api/v1/listings?endDate=2027-03-02"],
    ["money as a number-like decimal", "/api/v1/listings?minPrice=3500.50"],
    ["minPrice above maxPrice", "/api/v1/listings?minPrice=500&maxPrice=100"],
    ["page size too large", "/api/v1/listings?pageSize=500"],
    ["non-UUID listing id", "/api/v1/listings/not-a-uuid"],
    ["non-UUID trip id", "/api/v1/trips/123"],
  ])("rejects %s", async (_label, url) => {
    const res = await request(app()).get(url);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(errorOf(res).details)).toBe(true);
  });

  it.each([
    ["missing userId", "/api/v1/trips", {}],
    ["unknown field (strict)", "/api/v1/trips", { userId: uuid, isAdmin: true }],
    ["lower-case currency", "/api/v1/trips", { userId: uuid, currency: "npr" }],
    ["quantity 0", `/api/v1/trips/${uuid}/items`, { ...validItem, quantity: 0 }],
    [
      "unknown payment method",
      `/api/v1/trips/${uuid}/items`,
      { ...validItem, paymentMethod: "cash" },
    ],
    ["money sent by the client", `/api/v1/trips/${uuid}/items`, { ...validItem, totalMinor: "1" }],
  ])("rejects POST with %s", async (_label, url, body) => {
    const res = await request(app()).post(url).send(body);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
  });

  it("names the failing field", async () => {
    const res = await request(app())
      .post(`/api/v1/trips/${uuid}/items`)
      .send({ ...validItem, quantity: 0 });
    expect(errorOf(res).details).toEqual([expect.objectContaining({ path: "quantity" })]);
  });
});

describe("schemas", () => {
  it("parses money inputs as bigint, never as JS numbers", () => {
    const q = searchListingsQuerySchema.parse({ minPrice: "9223372036854775807" });
    expect(q.minPrice).toBe(9_223_372_036_854_775_807n);
    expect(searchListingsQuerySchema.safeParse({ minPrice: "9223372036854775808" }).success).toBe(
      false,
    );
  });

  it("defaults search paging, sort and quantity", () => {
    expect(searchListingsQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 20,
      sort: "price_asc",
      quantity: 1,
    });
  });

  it("defaults trip currency to NPR", () => {
    expect(createTripBodySchema.parse({ userId: uuid }).currency).toBe("NPR");
  });

  it("accepts a single-date item and a range item", () => {
    expect(addItemBodySchema.safeParse(validItem).success).toBe(true);
    expect(addItemBodySchema.safeParse({ ...validItem, endDate: "2027-03-03" }).success).toBe(true);
  });

  it("an item update needs at least one field, and endDate can be cleared with null", () => {
    expect(updateItemBodySchema.safeParse({}).success).toBe(false);
    expect(updateItemBodySchema.parse({ endDate: null })).toEqual({ endDate: null });
  });
});

describe("temporary unauthenticated trip API (ADR 0005)", () => {
  it("returns 403 TRIPS_API_DISABLED when switched off, without touching the database", async () => {
    const res = await request(app({ tripsEnabled: false }))
      .post("/api/v1/trips")
      .send({ userId: uuid });
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("TRIPS_API_DISABLED");
  });

  it("is off by default in production, on elsewhere, and can be set explicitly", () => {
    expect(unauthenticatedTripsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(unauthenticatedTripsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(unauthenticatedTripsEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(
      unauthenticatedTripsEnabled({
        NODE_ENV: "production",
        ALLOW_UNAUTHENTICATED_TRIPS_API: "true",
      }),
    ).toBe(true);
    expect(
      unauthenticatedTripsEnabled({
        NODE_ENV: "development",
        ALLOW_UNAUTHENTICATED_TRIPS_API: "false",
      }),
    ).toBe(false);
  });

  it("without a database client only the health endpoints exist", async () => {
    const healthOnly = createApp({
      logger: pino({ level: "silent" }),
      checkDatabase: () => Promise.resolve(),
    });
    expect((await request(healthOnly).get("/api/v1/listing-types")).status).toBe(404);
    expect((await request(healthOnly).get("/api/health")).status).toBe(200);
  });
});

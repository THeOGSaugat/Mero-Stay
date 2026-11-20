import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { ErrorResponseBody } from "../lib/errors.js";
import { testAuthConfig } from "../testing/auth-config.js";
import { searchListingsQuerySchema } from "./listings/listings.schemas.js";
import {
  addItemBodySchema,
  createTripBodySchema,
  updateItemBodySchema,
} from "./trips/trips.schemas.js";

/**
 * Validation, authentication gates and wiring without a database. The fake Prisma client fails
 * loudly if a request that should have been rejected earlier ever reaches the data layer.
 */
const exploding = new Proxy(
  {},
  {
    get: () => {
      throw new Error("this request should have been rejected before any database call");
    },
  },
) as PrismaClient;

const app = () =>
  createApp({
    logger: pino({ level: "silent" }),
    checkDatabase: () => Promise.resolve(),
    prisma: exploding,
    auth: testAuthConfig(),
  });

const errorOf = (res: request.Response) => (res.body as ErrorResponseBody).error;
const uuid = "6f1c2c1e-1b6a-4c8e-9a4e-2f3b4c5d6e7f";
const validItem = {
  listingId: uuid,
  startDate: "2027-03-01",
  quantity: 1,
  paymentMethod: "online",
};

describe("public search validation (400 VALIDATION_ERROR, before any database work)", () => {
  it.each([
    ["unknown query parameter", "/api/v1/listings?colour=red"],
    ["bad date", "/api/v1/listings?startDate=2027-02-30"],
    ["endDate without startDate", "/api/v1/listings?endDate=2027-03-02"],
    ["money as a number-like decimal", "/api/v1/listings?minPrice=3500.50"],
    ["minPrice above maxPrice", "/api/v1/listings?minPrice=500&maxPrice=100"],
    ["page size too large", "/api/v1/listings?pageSize=500"],
    ["non-UUID listing id", "/api/v1/listings/not-a-uuid"],
  ])("rejects %s", async (_label, url) => {
    const res = await request(app()).get(url);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(errorOf(res).details)).toBe(true);
  });
});

describe("trips require a session (401 before validation or any database work)", () => {
  it.each([
    ["post", "/api/v1/trips"],
    ["get", `/api/v1/trips/${uuid}`],
    ["post", `/api/v1/trips/${uuid}/items`],
    ["patch", `/api/v1/trips/${uuid}/items/${uuid}`],
    ["delete", `/api/v1/trips/${uuid}/items/${uuid}`],
    ["post", `/api/v1/trips/${uuid}/quote`],
    ["post", `/api/v1/trips/${uuid}/confirm`],
    ["get", "/api/v1/trips/not-even-a-uuid"],
  ] as const)("%s %s → 401 UNAUTHENTICATED", async (method, url) => {
    const res = await request(app())[method](url).send({});
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe("UNAUTHENTICATED");
  });

  it("GET /auth/me without a session → 401", async () => {
    const res = await request(app()).get("/api/v1/auth/me");
    expect([res.status, errorOf(res).code]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("POST /auth/logout without a session → 401", async () => {
    const res = await request(app()).post("/api/v1/auth/logout");
    expect([res.status, errorOf(res).code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("auth request validation (before any database work)", () => {
  const good = { email: "ram@example.com", password: "a long enough passphrase", fullName: "Ram" };

  it.each([
    ["an invalid email", { ...good, email: "not-an-email" }, "email"],
    ["a password shorter than 12 characters", { ...good, password: "short-pass1" }, "password"],
    ["a common password", { ...good, password: "Password1234" }, "password"],
    ["a password over 128 characters", { ...good, password: "x".repeat(129) }, "password"],
    ["an unknown field (e.g. role)", { ...good, role: "ADMIN" }, ""],
    ["a malformed phone", { ...good, phone: "98123" }, "phone"],
  ])("register rejects %s", async (_label, body, path) => {
    const res = await request(app()).post("/api/v1/auth/register").send(body);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    if (path) {
      expect(errorOf(res).details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    }
  });

  it("login rejects a missing password", async () => {
    const res = await request(app()).post("/api/v1/auth/login").send({ email: "ram@example.com" });
    expect([res.status, errorOf(res).code]).toEqual([400, "VALIDATION_ERROR"]);
  });

  it.each(["/api/v1/auth/login", "/api/v1/auth/register"])(
    "%s only accepts application/json (blocks cross-site form posts) → 415",
    async (url) => {
      const res = await request(app())
        .post(url)
        .type("form")
        .send("email=ram@example.com&password=whatever-password");
      expect([res.status, errorOf(res).code]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE"]);
    },
  );
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

  it("creates trips without any userId: the owner comes from the session", () => {
    expect(createTripBodySchema.parse({})).toEqual({ currency: "NPR" });
    const withUserId = createTripBodySchema.safeParse({ userId: uuid });
    expect(withUserId.success).toBe(false); // strict: the temporary field is gone
  });

  it("validates trip items", () => {
    expect(addItemBodySchema.safeParse(validItem).success).toBe(true);
    expect(addItemBodySchema.safeParse({ ...validItem, endDate: "2027-03-03" }).success).toBe(true);
    expect(addItemBodySchema.safeParse({ ...validItem, quantity: 0 }).success).toBe(false);
    expect(addItemBodySchema.safeParse({ ...validItem, paymentMethod: "cash" }).success).toBe(
      false,
    );
    expect(addItemBodySchema.safeParse({ ...validItem, totalMinor: "1" }).success).toBe(false);
  });

  it("an item update needs at least one field, and endDate can be cleared with null", () => {
    expect(updateItemBodySchema.safeParse({}).success).toBe(false);
    expect(updateItemBodySchema.parse({ endDate: null })).toEqual({ endDate: null });
  });
});

describe("app wiring", () => {
  it("refuses to build the API without auth configuration", () => {
    expect(() =>
      createApp({
        logger: pino({ level: "silent" }),
        checkDatabase: () => Promise.resolve(),
        prisma: exploding,
      }),
    ).toThrow(/auth/);
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

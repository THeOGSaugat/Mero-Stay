import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { mapDatabaseError } from "../../lib/database-errors.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/**
 * Gap 22 (ADR 0013): a provider may only create or change listings whose type its provider type
 * is mapped to (`provider_type_listing_types`), while both types are active. Setup that is not
 * under test (an inactive type's provider) is seeded with Prisma. Flags switched in a test are
 * always restored (integration files run one after another).
 */

vi.setConfig({ testTimeout: 300_000 });

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
});

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
}

const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error?.code];
const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const detailsOf = (res: request.Response) =>
  (res.body as ErrorResponseBody).error?.details as Record<string, unknown> | undefined;

async function signUp(label: string): Promise<Client> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").send({
    email: `${label}-${randomUUID().slice(0, 8)}@test.local`,
    password: "a long test passphrase",
    fullName: `${label} Person`,
  });
  expect(res.status).toBe(201);
  const body = res.body as { data: { user: { id: string }; csrfToken: string } };
  return { agent, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

function call(who: Client, method: "get" | "post" | "patch", url: string, body?: unknown) {
  const req = who.agent[method](url).set("X-CSRF-Token", who.csrfToken);
  return body === undefined ? req : req.send(body as object);
}

/** A partner whose only provider has this (offered) type, onboarded through the API. */
async function partnerOf(providerTypeCode: string): Promise<Client & { providerId: string }> {
  const who = await signUp(providerTypeCode);
  const res = await call(who, "post", "/api/v1/partner/onboarding", {
    providerTypeCode,
    legalName: `${providerTypeCode} Ltd`,
    displayName: `${providerTypeCode} ${randomUUID().slice(0, 6)}`,
  });
  expect(res.status).toBe(201);
  return { ...who, providerId: dataOf<{ id: string }>(res).id };
}

const listingCount = (providerId: string) => prisma.listing.count({ where: { providerId } });

const roomBody = {
  listingTypeCode: "hotel_room",
  title: "Lakeside Double",
  basePriceMinor: "350000",
  details: { maxAdults: 2 },
};

async function setListingTypeActive(code: string, isActive: boolean) {
  await prisma.listingType.update({ where: { code }, data: { isActive } });
}
async function setProviderTypeActive(code: string, isActive: boolean) {
  await prisma.providerType.update({ where: { code }, data: { isActive } });
}

let busOperator: Client & { providerId: string };
let hotel: Client & { providerId: string };
let tourOperator: Client & { providerId: string };

beforeAll(async () => {
  [busOperator, hotel, tourOperator] = await Promise.all([
    partnerOf("bus_operator"),
    partnerOf("hotel"),
    partnerOf("tour_operator"),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("gap 22: listing types follow the provider type's mapping", () => {
  it("a bus operator cannot create a hotel room: 422 naming what it may list; nothing written", async () => {
    const res = await call(busOperator, "post", "/api/v1/partner/listings", roomBody);
    expect(codeOf(res)).toEqual([422, "LISTING_TYPE_NOT_ALLOWED"]);
    expect(detailsOf(res)).toEqual({
      listingTypeCode: "hotel_room",
      providerTypeCode: "bus_operator",
      reason: "not_mapped",
      allowedListingTypes: ["bus_ticket"],
    });
    expect(await listingCount(busOperator.providerId)).toBe(0);
    // The container type (a hotel property) is refused just the same.
    expect(
      codeOf(
        await call(busOperator, "post", "/api/v1/partner/listings", {
          listingTypeCode: "hotel",
          title: "Not a hotel",
          basePriceMinor: "0",
          details: { accommodationKind: "HOTEL", checkInTime: "14:00", checkOutTime: "11:00" },
        }),
      ),
    ).toEqual([422, "LISTING_TYPE_NOT_ALLOWED"]);
    expect(await listingCount(busOperator.providerId)).toBe(0);
  });

  it("a hotel creates its property and a room", async () => {
    const property = await call(hotel, "post", "/api/v1/partner/listings", {
      listingTypeCode: "hotel",
      title: "Hotel Fewa View",
      basePriceMinor: "0",
      details: { accommodationKind: "HOTEL", checkInTime: "14:00", checkOutTime: "11:00" },
    });
    expect(property.status).toBe(201);
    const room = await call(hotel, "post", "/api/v1/partner/listings", {
      ...roomBody,
      parentId: dataOf<{ id: string }>(property).id,
    });
    expect(room.status).toBe(201);
    expect(await listingCount(hotel.providerId)).toBe(2);
  });

  it("a homestay (the hotel provider type, ADR 0009) creates its property and a room", async () => {
    const homestay = await partnerOf("hotel");
    const property = await call(homestay, "post", "/api/v1/partner/listings", {
      listingTypeCode: "hotel",
      title: "Didi's Homestay",
      basePriceMinor: "0",
      details: { accommodationKind: "HOMESTAY", checkInTime: "12:00", checkOutTime: "10:00" },
    });
    expect(property.status).toBe(201);
    const room = await call(homestay, "post", "/api/v1/partner/listings", {
      ...roomBody,
      title: "Family room",
      parentId: dataOf<{ id: string }>(property).id,
    });
    expect(room.status).toBe(201);
  });

  it("a tour operator's activity: refused while the activity type is inactive, allowed once active", async () => {
    const body = {
      listingTypeCode: "activity",
      title: "Rafting on the Trishuli",
      basePriceMinor: "450000",
    };
    await setListingTypeActive("activity", false);
    try {
      const refused = await call(tourOperator, "post", "/api/v1/partner/listings", body);
      expect(codeOf(refused)).toEqual([422, "LISTING_TYPE_NOT_OFFERED"]);
      expect(await listingCount(tourOperator.providerId)).toBe(0);
      // What the partner may list right now excludes it as well.
      const profile = dataOf<{ providerType: { allowedListingTypes: { code: string }[] } }>(
        await call(tourOperator, "get", "/api/v1/partner/profile"),
      );
      expect(profile.providerType.allowedListingTypes.map((t) => t.code)).toEqual(["tour"]);
    } finally {
      await setListingTypeActive("activity", true);
    }
    const allowed = await call(tourOperator, "post", "/api/v1/partner/listings", body);
    expect(allowed.status).toBe(201);
  });

  it("an airline's flight: refused while its provider type is inactive, allowed when both are active", async () => {
    // The airline provider type is not offered (gap 19), so its partner is seeded directly.
    const who = await signUp("airline");
    const provider = await prisma.provider.create({
      data: {
        providerTypeCode: "airline",
        ownerUserId: who.userId,
        legalName: "Mountain Air Pvt. Ltd.",
        displayName: "Mountain Air",
      },
    });
    await prisma.user.update({ where: { id: who.userId }, data: { role: "PARTNER" } });
    const body = {
      listingTypeCode: "flight_ticket",
      title: "KTM → PKR morning",
      basePriceMinor: "450000",
    };

    // Both inactive (today's data): the listing type is not offered.
    expect(codeOf(await call(who, "post", "/api/v1/partner/listings", body))).toEqual([
      422,
      "LISTING_TYPE_NOT_OFFERED",
    ]);
    await setListingTypeActive("flight_ticket", true);
    try {
      // Listing type active, provider type still inactive: mapped, but not allowed.
      const refused = await call(who, "post", "/api/v1/partner/listings", body);
      expect(codeOf(refused)).toEqual([422, "LISTING_TYPE_NOT_ALLOWED"]);
      expect(detailsOf(refused)).toMatchObject({
        reason: "provider_type_not_offered",
        allowedListingTypes: [],
      });
      expect(await listingCount(provider.id)).toBe(0);

      await setProviderTypeActive("airline", true);
      const allowed = await call(who, "post", "/api/v1/partner/listings", body);
      expect(allowed.status).toBe(201);
    } finally {
      await setProviderTypeActive("airline", false);
      await setListingTypeActive("flight_ticket", false);
    }
  });

  it("updates: the type cannot be changed; a listing whose type is no longer allowed can only be archived", async () => {
    const created = await call(tourOperator, "post", "/api/v1/partner/listings", {
      listingTypeCode: "activity",
      title: "Paragliding from Sarangkot",
      basePriceMinor: "800000",
    });
    const id = dataOf<{ id: string }>(created).id;

    // Changing the type is not part of the update contract (unknown field → 400), unchanged.
    expect(
      codeOf(
        await call(tourOperator, "patch", `/api/v1/partner/listings/${id}`, {
          listingTypeCode: "hotel_room",
        }),
      ),
    ).toEqual([400, "VALIDATION_ERROR"]);

    await setListingTypeActive("activity", false);
    try {
      expect(
        codeOf(
          await call(tourOperator, "patch", `/api/v1/partner/listings/${id}`, {
            title: "New title",
          }),
        ),
      ).toEqual([422, "LISTING_TYPE_NOT_OFFERED"]);
      expect((await prisma.listing.findUniqueOrThrow({ where: { id } })).title).toBe(
        "Paragliding from Sarangkot",
      );
      // Taking it down is always possible.
      const archived = await call(tourOperator, "patch", `/api/v1/partner/listings/${id}`, {
        status: "ARCHIVED",
      });
      expect([archived.status, dataOf<{ status: string }>(archived).status]).toEqual([
        200,
        "ARCHIVED",
      ]);
    } finally {
      await setListingTypeActive("activity", true);
    }
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id } });
    expect([listing.listingTypeCode, listing.title]).toEqual([
      "activity",
      "Paragliding from Sarangkot",
    ]);
  });

  it("the database refuses an unmapped pair on any write path (guard trigger → 422)", async () => {
    const insert = prisma.listing.create({
      data: {
        providerId: busOperator.providerId,
        listingTypeCode: "hotel_room",
        title: "Sneaky room",
        slug: `sneaky-${randomUUID().slice(0, 8)}`,
        basePriceMinor: 100_000n,
      },
    });
    const err = await insert.then(
      () => null,
      (e: unknown) => e,
    );
    expect(mapDatabaseError(err)?.code).toBe("LISTING_TYPE_NOT_ALLOWED");
    expect(await listingCount(busOperator.providerId)).toBe(0);

    // Changing an existing listing's type to an unmapped one is refused too.
    const room = await prisma.listing.findFirstOrThrow({
      where: { providerId: hotel.providerId, listingTypeCode: "hotel_room" },
    });
    const changed =
      await prisma.$executeRaw`UPDATE listings SET listing_type_code = 'bus_ticket' WHERE id = ${room.id}::uuid`.then(
        () => null,
        (e: unknown) => e,
      );
    expect(mapDatabaseError(changed)?.code).toBe("LISTING_TYPE_NOT_ALLOWED");
    expect(
      (await prisma.listing.findUniqueOrThrow({ where: { id: room.id } })).listingTypeCode,
    ).toBe("hotel_room");
  });

  it("the mapping is visible: public types, the partner's profile, and the admin's full view", async () => {
    type Offered = { code: string; allowedListingTypes: { code: string; isBookable: boolean }[] }[];
    const offered = dataOf<Offered>(await request(app).get("/api/v1/provider-types"));
    expect(offered.find((t) => t.code === "hotel")?.allowedListingTypes.map((t) => t.code)).toEqual(
      ["hotel", "hotel_room"],
    );
    expect(
      offered.find((t) => t.code === "tour_operator")?.allowedListingTypes.map((t) => t.code),
    ).toEqual(["activity", "tour"]);
    expect(offered.map((t) => t.code)).not.toContain("airline");

    const profile = dataOf<{ providerType: { allowedListingTypes: { code: string }[] } }>(
      await call(busOperator, "get", "/api/v1/partner/profile"),
    );
    expect(profile.providerType.allowedListingTypes.map((t) => t.code)).toEqual(["bus_ticket"]);

    // Admin: every type, inactive ones included, with flags. Non-admins are refused.
    expect(codeOf(await call(hotel, "get", "/api/v1/admin/provider-types"))).toEqual([
      403,
      "FORBIDDEN",
    ]);
    const admin = await signUp("rules-admin");
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "ADMIN" } });
    type Rules = {
      code: string;
      isActive: boolean;
      listingTypes: { code: string; isActive: boolean }[];
      usableListingTypes: string[];
    }[];
    const rules = dataOf<Rules>(await call(admin, "get", "/api/v1/admin/provider-types"));
    expect(rules.find((t) => t.code === "airline")).toMatchObject({
      isActive: false,
      listingTypes: [expect.objectContaining({ code: "flight_ticket", isActive: false })],
      usableListingTypes: [],
    });
    expect(rules.find((t) => t.code === "activity_operator")?.usableListingTypes).toEqual([
      "activity",
    ]);
    // Every mapping row in the database appears in the admin view.
    const rows = await prisma.providerTypeListingType.count();
    expect(rules.reduce((n, t) => n + t.listingTypes.length, 0)).toBe(rows);
  });
});
